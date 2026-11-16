// Soniox real-time transcription. One WebSocket per side keeps 自分側/相手側 apart. Soniox supplies the text,
// its times and the end of each utterance (<end>, endpoint detection); the local Silero VAD supplies voice
// activity for the segmenter, as with Gemini. Soniox times start at 0 on each connection, so they are moved
// onto the recording timeline by the time of the first audio sent on that connection.
import { WebSocket } from "ws";
import { z } from "zod";
import type { Side } from "../store/store.ts";
import type { VadFactory } from "./gemini-live.ts";
import { createParakeet } from "./parakeet.ts";
import type { SpeechCallbacks, SpeechEngine } from "./types.ts";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const DEFAULT_SONIOX_MODEL = "stt-rt-v5";
const MAX_BUFFERED_CHUNKS = 600; // ~60 s of 100 ms chunks while reconnecting
const DEFAULT_FINISH_WAIT_MS = 3000;
/** Errors that a new connection cannot fix: the key, the balance or the request itself. */
const FATAL_CODES = new Set([400, 401, 402, 403]);

export type SonioxCallbacks = { onMessage(raw: string): void; onClose(code: number, reason: string): void };
export type SonioxSocket = { sendAudio(pcm: Buffer): void; finish(): void; close(): void };
export type SonioxConnect = (side: Side, cb: SonioxCallbacks) => Promise<SonioxSocket>;

const TokenSchema = z.object({
  text: z.string().max(20000),
  start_ms: z.number().optional(),
  end_ms: z.number().optional(),
  is_final: z.boolean(),
});
const MessageSchema = z.object({
  tokens: z.array(TokenSchema).max(10000).optional(),
  finished: z.boolean().optional(),
  error_code: z.number().optional(),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
});

export function defaultConnect(apiKey: string, model: string, language: string): SonioxConnect {
  const config = { model, audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, language_hints: [language], enable_endpoint_detection: true };
  return (_side, cb) =>
    new Promise((resolve, reject) => {
      // The key goes in the header: the api_key field of the start request is refused from 2027-01-15.
      const ws = new WebSocket(SONIOX_URL, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
      let opened = false;
      ws.on("open", () => {
        opened = true;
        ws.send(JSON.stringify(config));
        resolve({
          sendAudio: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
          finish: () => { if (ws.readyState === WebSocket.OPEN) ws.send(""); }, // an empty text frame ends the stream
          close: () => ws.close(),
        });
      });
      ws.on("message", (data) => cb.onMessage(data.toString()));
      ws.on("unexpected-response", (_req, res) => { reject(Error(`HTTP ${res.statusCode ?? "?"}`)); ws.terminate(); });
      ws.on("error", (error) => { if (!opened) reject(error); });
      ws.on("close", (code, reason) => { if (opened) cb.onClose(code, reason.toString()); });
    });
}

function connectMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return `Soniox に接続できません。SONIOX_API_KEY を確かめてください（${text.slice(0, 200)}）`;
}
function errorMessage(code: number, type: string | undefined) {
  if (code === 402) return `Soniox の残高か利用上限が足りません（${code} ${type ?? ""}）。Soniox の管理画面を確かめてください。`;
  if (code === 401 || code === 403) return connectMessage(Error(`${code} ${type ?? ""}`));
  return `Soniox が文字起こしを断りました（${code} ${type ?? ""}）`;
}

type SideState = {
  side: Side;
  socket: SonioxSocket | null;
  /** Increases with each connection: messages from a replaced connection are ignored. */
  generation: number;
  /** Recording time of the first audio sent on the current connection; Soniox times count from it. */
  base: number | null;
  buffer: { pcm: Buffer; atMs: number }[];
  reconnecting: boolean;
  dead: boolean;
  text: string;
  startMs: number | null;
  endMs: number | null;
  onFinished: (() => void) | null;
};

export async function createSoniox(
  opts: { apiKey: string; model: string; language: string; sides: Side[]; connect?: SonioxConnect; vad?: VadFactory; vadModelDir?: string; finishWaitMs?: number },
  cb: SpeechCallbacks,
): Promise<SpeechEngine> {
  const connect = opts.connect ?? defaultConnect(opts.apiKey, opts.model, opts.language);
  const finishWaitMs = opts.finishWaitMs ?? DEFAULT_FINISH_WAIT_MS;
  let stopping = false;
  const states = new Map<Side, SideState>();

  const emit = (s: SideState) => {
    const text = s.text.trim();
    if (text) cb.text({ side: s.side, text, startMs: s.startMs ?? 0, endMs: s.endMs ?? s.startMs ?? 0 });
    s.text = "";
    s.startMs = null;
    s.endMs = null;
  };

  const onMessage = (s: SideState, raw: string) => {
    let parsed;
    try {
      parsed = MessageSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) { cb.error("Soniox から読めない応答が届きました"); return; }
    const m = parsed.data;
    if (m.error_code) {
      if (FATAL_CODES.has(m.error_code)) {
        s.dead = true;
        cb.error(errorMessage(m.error_code, m.error_type));
        try { s.socket?.close(); } catch { /* already closed */ }
      } else if (!stopping) {
        void reconnect(s);
      }
      return;
    }
    const base = s.base ?? 0;
    for (const t of m.tokens ?? []) {
      if (!t.is_final) continue;
      if (t.text === "<end>") { emit(s); continue; }
      if (t.text === "<fin>") continue;
      s.text += t.text;
      if (t.start_ms !== undefined && s.startMs === null) s.startMs = base + t.start_ms;
      if (t.end_ms !== undefined) s.endMs = base + t.end_ms;
    }
    if (m.finished) s.onFinished?.();
  };

  const callbacksFor = (s: SideState, generation: number): SonioxCallbacks => ({
    onMessage(raw) { if (s.generation === generation) onMessage(s, raw); },
    onClose(code) { if (s.generation === generation && !stopping && !s.dead && code !== 1000) void reconnect(s); },
  });

  const open = async (s: SideState) => {
    const generation = ++s.generation;
    const socket = await connect(s.side, callbacksFor(s, generation));
    s.socket = socket;
    s.base = null;
    for (const chunk of s.buffer.splice(0)) {
      s.base ??= chunk.atMs;
      socket.sendAudio(chunk.pcm);
    }
  };

  async function reconnect(s: SideState) {
    if (stopping || s.reconnecting || s.dead) return;
    s.reconnecting = true;
    emit(s); // final text of the old connection keeps its own times
    const old = s.socket;
    s.socket = null;
    s.generation++;
    try { old?.close(); } catch { /* already closed */ }
    for (let attempt = 0; !stopping; attempt++) {
      try {
        await open(s);
        break;
      } catch (error) {
        if (attempt >= 4) { cb.error(connectMessage(error)); break; }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
    s.reconnecting = false;
  }

  for (const side of opts.sides) {
    states.set(side, { side, socket: null, generation: 0, base: null, buffer: [], reconnecting: false, dead: false, text: "", startMs: null, endMs: null, onFinished: null });
  }
  try {
    for (const s of states.values()) await open(s);
  } catch (error) {
    for (const s of states.values()) try { s.socket?.close(); } catch { /* ignore */ }
    throw Error(connectMessage(error));
  }

  const vadFactory: VadFactory = opts.vad ?? ((vcb) => createParakeet(opts.vadModelDir ?? "", { ...vcb, text: () => {}, pending: () => {} }, { vadOnly: true }));
  const vad = vadFactory({
    voice(side, active, atMs) {
      cb.voice(side, active, atMs);
      if (!active) cb.pending(side, atMs);
    },
    error: cb.error,
  });

  return {
    write(side, pcm, atMs) {
      const s = states.get(side);
      if (!s || stopping) return;
      vad.write(side, pcm, atMs);
      if (s.dead) return;
      if (s.socket && !s.reconnecting) {
        s.base ??= atMs;
        s.socket.sendAudio(pcm);
      } else if (s.buffer.length < MAX_BUFFERED_CHUNKS) {
        s.buffer.push({ pcm, atMs });
      }
    },
    async stop() {
      if (stopping) return;
      await vad.stop();
      stopping = true;
      await Promise.all([...states.values()].map(async (s) => {
        if (s.socket && !s.dead) {
          const finished = new Promise<void>((resolve) => { s.onFinished = resolve; });
          try { s.socket.finish(); } catch { /* closed */ }
          await Promise.race([finished, new Promise((r) => setTimeout(r, finishWaitMs))]);
        }
        emit(s);
        try { s.socket?.close(); } catch { /* ignore */ }
      }));
    },
  };
}
