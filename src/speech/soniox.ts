// Soniox real-time transcription. One WebSocket per side keeps 自分側/相手側 apart. Soniox supplies the text,
// its times and the end of each utterance (<end>, endpoint detection); the local Silero VAD supplies voice
// activity for the segmenter, as with Gemini. Soniox counts time only by the audio it has received, from 0
// on each connection, so each connection keeps anchors (Soniox time → recording time) and adds one whenever
// a chunk does not start where the previous one ended (a hole in the capture, or chunks dropped).
import { WebSocket } from "ws";
import { z } from "zod";
import type { Side } from "../store/store.ts";
import type { VadFactory } from "./gemini-live.ts";
import { createParakeet } from "./parakeet.ts";
import type { SpeechCallbacks, SpeechEngine } from "./types.ts";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const DEFAULT_SONIOX_MODEL = "stt-rt-v5";
const MAX_BUFFERED_CHUNKS = 600; // ~60 s of 100 ms chunks while reconnecting
const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
const DEFAULT_FINISH_WAIT_MS = 3000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 8000;
const DEFAULT_KEEPALIVE_MS = 15_000; // Soniox may close a connection that receives nothing
const REPORT_AFTER_FAILURES = 5;
/** Errors that a new connection cannot fix: the key, the balance or the request itself. */
const FATAL_CODES = new Set([400, 401, 402, 403]);

export type SonioxCallbacks = { onMessage(raw: string): void; onClose(code: number, reason: string): void };
export type SonioxSocket = { sendAudio(pcm: Buffer): void; finish(): void; keepalive(): void; close(): void };
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

export function defaultConnect(apiKey: string, model: string, language: string, url = SONIOX_URL): SonioxConnect {
  const config = { model, audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, language_hints: [language], enable_endpoint_detection: true };
  return (_side, cb) =>
    new Promise((resolve, reject) => {
      // The key goes in the header: the api_key field of the start request is refused from 2027-01-15.
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
      const send = (data: string | Buffer) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); };
      let opened = false;
      ws.on("open", () => {
        opened = true;
        ws.send(JSON.stringify(config));
        resolve({
          sendAudio: (pcm) => send(pcm),
          finish: () => send(""), // an empty text frame ends the stream; an empty binary frame does not
          keepalive: () => send(JSON.stringify({ type: "keepalive" })),
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

type Anchor = { sent: number; at: number };
type SideState = {
  side: Side;
  socket: SonioxSocket | null;
  /** Increases with each connection: messages from a replaced connection are ignored. */
  generation: number;
  /** Soniox time (ms of audio sent on this connection) → recording time. */
  anchors: Anchor[];
  sentMs: number;
  lastAudioAt: number;
  buffer: { pcm: Buffer; atMs: number }[];
  reconnecting: Promise<void> | null;
  /** Failures in a row; cleared when Soniox sends text again. */
  failures: number;
  reported: boolean;
  dead: boolean;
  lastError: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  onFinished: (() => void) | null;
};

/** Recording time of a Soniox time on the current connection. */
function toRecording(s: SideState, t: number): number {
  let anchor = s.anchors[0];
  if (!anchor) return t;
  for (const a of s.anchors) if (a.sent <= t) anchor = a;
  return anchor!.at + (t - anchor!.sent);
}

export async function createSoniox(
  opts: {
    apiKey: string; model: string; language: string; sides: Side[]; connect?: SonioxConnect; vad?: VadFactory; vadModelDir?: string;
    finishWaitMs?: number; retryBaseMs?: number; retryMaxMs?: number; keepaliveMs?: number;
  },
  cb: SpeechCallbacks,
): Promise<SpeechEngine> {
  const connect = opts.connect ?? defaultConnect(opts.apiKey, opts.model, opts.language);
  const finishWaitMs = opts.finishWaitMs ?? DEFAULT_FINISH_WAIT_MS;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  let stopping = false;
  const states = new Map<Side, SideState>();
  const waits = new Set<{ timer: ReturnType<typeof setTimeout>; done(): void }>();
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const w = { timer: setTimeout(() => { waits.delete(w); resolve(); }, ms), done: resolve };
    waits.add(w);
  });

  const emit = (s: SideState) => {
    const text = s.text.trim();
    if (text) cb.text({ side: s.side, text, startMs: s.startMs ?? 0, endMs: s.endMs ?? s.startMs ?? 0 });
    s.text = "";
    s.startMs = null;
    s.endMs = null;
  };

  const fail = (s: SideState, message: string) => {
    s.failures++;
    s.lastError = message;
    if (s.failures >= REPORT_AFTER_FAILURES && !s.reported) { s.reported = true; cb.error(message); }
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
        s.onFinished?.();
      } else {
        fail(s, errorMessage(m.error_code, m.error_type));
        reconnect(s);
      }
      return;
    }
    if (m.tokens?.length) { s.failures = 0; s.reported = false; }
    for (const t of m.tokens ?? []) {
      if (!t.is_final) continue;
      if (t.text === "<end>") { emit(s); continue; }
      if (t.text === "<fin>") continue;
      s.text += t.text;
      if (t.start_ms !== undefined && s.startMs === null) s.startMs = toRecording(s, t.start_ms);
      if (t.end_ms !== undefined) s.endMs = toRecording(s, t.end_ms);
    }
    if (m.finished) s.onFinished?.();
  };

  const callbacksFor = (s: SideState, generation: number): SonioxCallbacks => ({
    onMessage(raw) { if (s.generation === generation) onMessage(s, raw); },
    onClose() {
      if (s.generation !== generation) return;
      s.onFinished?.();
      if (stopping || s.dead) return;
      // Soniox closes only after finished, which only stop asks for: any other close is a failure.
      fail(s, "Soniox との接続が切れました。つなぎ直しています");
      reconnect(s);
    },
  });

  const sendChunk = (s: SideState, socket: SonioxSocket, pcm: Buffer, atMs: number) => {
    const last = s.anchors.at(-1);
    const expected = last ? last.at + (s.sentMs - last.sent) : null;
    if (expected === null || Math.abs(atMs - expected) > 1) s.anchors.push({ sent: s.sentMs, at: atMs });
    socket.sendAudio(pcm);
    s.sentMs += pcm.length / BYTES_PER_MS;
    s.lastAudioAt = Date.now();
  };

  const open = async (s: SideState) => {
    const generation = ++s.generation;
    const socket = await connect(s.side, callbacksFor(s, generation));
    if (stopping) { try { socket.close(); } catch { /* ignore */ } return; }
    s.socket = socket;
    s.anchors = [];
    s.sentMs = 0;
    s.lastAudioAt = Date.now();
    for (const chunk of s.buffer.splice(0)) sendChunk(s, socket, chunk.pcm, chunk.atMs);
  };

  function reconnect(s: SideState) {
    if (stopping || s.dead || s.reconnecting) return;
    emit(s); // final text of the old connection keeps its own times
    const old = s.socket;
    s.socket = null;
    s.generation++;
    try { old?.close(); } catch { /* already closed */ }
    s.reconnecting = (async () => {
      // Keep trying while recording, with a capped backoff; report once after several failures in a row.
      while (!stopping && !s.dead) {
        await wait(Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(Math.max(s.failures - 1, 0), 10)));
        if (stopping || s.dead) break;
        try {
          await open(s);
          break;
        } catch (error) {
          if (/^HTTP 40[123]$/.test(error instanceof Error ? error.message : "")) { // the handshake status from defaultConnect
            // The key was revoked or the balance ran out during the meeting: a new connection cannot fix it.
            s.dead = true;
            cb.error(connectMessage(error));
            break;
          }
          fail(s, connectMessage(error));
        }
      }
      s.reconnecting = null;
    })();
  }

  for (const side of opts.sides) {
    states.set(side, {
      side, socket: null, generation: 0, anchors: [], sentMs: 0, lastAudioAt: Date.now(), buffer: [], reconnecting: null,
      failures: 0, reported: false, dead: false, lastError: "", text: "", startMs: null, endMs: null, onFinished: null,
    });
  }
  try {
    for (const s of states.values()) await open(s);
  } catch (error) {
    stopping = true; // the engine is never returned: closing these sockets must not start reconnects
    for (const s of states.values()) try { s.socket?.close(); } catch { /* ignore */ }
    throw Error(connectMessage(error));
  }

  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const s of states.values()) {
      if (s.socket && !s.reconnecting && now - s.lastAudioAt >= keepaliveMs) {
        try { s.socket.keepalive(); } catch { /* closed; onClose reconnects */ }
        s.lastAudioAt = now;
      }
    }
  }, Math.max(1, Math.floor(keepaliveMs / 3))); // checked often, so a quiet side waits at most ~4/3 of keepaliveMs
  keepalive.unref?.();

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
      if (s.socket && !s.reconnecting) sendChunk(s, s.socket, pcm, atMs);
      else if (s.buffer.length < MAX_BUFFERED_CHUNKS) s.buffer.push({ pcm, atMs });
    },
    async stop() {
      if (stopping) return;
      await vad.stop();
      stopping = true;
      clearInterval(keepalive);
      for (const w of waits) { clearTimeout(w.timer); w.done(); }
      waits.clear();
      await Promise.all([...states.values()].map((s) => s.reconnecting));
      await Promise.all([...states.values()].map(async (s) => {
        if (s.socket && !s.dead) {
          const finished = new Promise<void>((resolve) => { s.onFinished = resolve; });
          try { s.socket.finish(); } catch { /* closed */ }
          await Promise.race([finished, wait(finishWaitMs)]);
        }
        emit(s);
        s.generation++; // nothing after stop reaches the meeting
        try { s.socket?.close(); } catch { /* ignore */ }
      }));
      for (const w of waits) { clearTimeout(w.timer); w.done(); }
      waits.clear();
    },
  };
}
