// Gemini Live transcription. One Live connection per side keeps 自分側/相手側 apart. Utterance boundaries come
// from the local Silero VAD; Gemini supplies only the text (inputAudioTranscription). Settings from the
// 2026-11-16 spike: the model only supports AUDIO responses, so output is capped at 1 token and never used.
import { EndSensitivity, GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import type { Side } from "../store/store.ts";
import { createParakeet } from "./parakeet.ts";
import type { SpeechCallbacks, SpeechEngine } from "./types.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-live";
const DEFAULT_QUIET_MS = 1200;
const MAX_BUFFERED_CHUNKS = 600; // ~60 s of 100 ms chunks while reconnecting

export type LiveCallbacks = {
  onTranscription(text: string): void;
  onResumptionHandle(handle: string): void;
  onGoAway(): void;
  onClose(code: number, reason: string): void;
};
export type LiveSessionLike = { sendAudio(base64: string): void; close(): void };
export type LiveConnect = (side: Side, handle: string | undefined, cb: LiveCallbacks) => Promise<LiveSessionLike>;
export type VadFactory = (cb: Pick<SpeechCallbacks, "voice" | "error">) => { write(side: Side, pcm: Buffer, atMs: number): void; stop(): Promise<void> };

export function defaultConnect(apiKey: string, model: string, language: string): LiveConnect {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
  return async (_side, handle, cb) => {
    const session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        maxOutputTokens: 1,
        inputAudioTranscription: {},
        systemInstruction: `あなたは会議の記録係です。音声を聞くだけで、決して話したり応答したりしないでください。会議の言語: ${language}`,
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: handle ? { handle } : {},
        realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW, prefixPaddingMs: 300, silenceDurationMs: 1000 } },
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          const text = m.serverContent?.inputTranscription?.text;
          if (text) cb.onTranscription(text);
          const update = m.sessionResumptionUpdate;
          if (update?.resumable && update.newHandle) cb.onResumptionHandle(update.newHandle);
          if (m.goAway) cb.onGoAway();
        },
        onerror: () => {},
        onclose: (e: { code: number; reason: string }) => cb.onClose(e.code, e.reason),
      },
    });
    return {
      sendAudio: (data) => session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } }),
      close: () => session.close(),
    };
  };
}

function authMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return `Gemini Live に接続できません。GEMINI_API_KEY を確かめてください（${text.slice(0, 200)}）`;
}

type SideState = {
  side: Side;
  session: LiveSessionLike | null;
  handle: string | undefined;
  buffer: string[];
  reconnecting: boolean;
  text: string;
  /** The utterance the text belongs to: from VAD, or the last one when text arrives late. */
  span: { start: number; end: number | null } | null;
  lastSpan: { start: number; end: number } | null;
  active: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

export async function createGeminiLive(
  opts: { apiKey: string; model: string; language: string; sides: Side[]; connect?: LiveConnect; vad?: VadFactory; vadModelDir?: string; quietMs?: number },
  cb: SpeechCallbacks,
): Promise<SpeechEngine> {
  const connect = opts.connect ?? defaultConnect(opts.apiKey, opts.model, opts.language);
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  let stopping = false;
  const states = new Map<Side, SideState>();

  // Text is never dropped: it is emitted with the utterance it belongs to, however late it arrives.
  const emit = (s: SideState) => {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    const text = s.text.trim();
    if (!text) return; // keep the span: the transcription may still be on its way
    const span = s.span ?? s.lastSpan ?? { start: 0, end: 0 };
    const end = span.end ?? span.start;
    cb.text({ side: s.side, text, startMs: span.start, endMs: end });
    s.text = "";
    s.lastSpan = { start: span.start, end };
    if (!s.active) s.span = null;
  };
  const scheduleFlush = (s: SideState) => {
    if (s.active) return;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => emit(s), quietMs);
  };

  const callbacksFor = (s: SideState): LiveCallbacks => ({
    onTranscription(text) {
      s.text += text;
      scheduleFlush(s);
    },
    onResumptionHandle(handle) {
      s.handle = handle;
    },
    onGoAway() {
      void reconnect(s);
    },
    onClose(code) {
      if (!stopping && code !== 1000) void reconnect(s);
    },
  });

  async function reconnect(s: SideState) {
    if (stopping || s.reconnecting) return;
    s.reconnecting = true;
    const old = s.session;
    s.session = null;
    try { old?.close(); } catch { /* already closed */ }
    for (let attempt = 0; !stopping; attempt++) {
      try {
        s.session = await connect(s.side, s.handle, callbacksFor(s));
        for (const chunk of s.buffer.splice(0)) s.session.sendAudio(chunk);
        break;
      } catch (error) {
        if (attempt >= 4) { cb.error(authMessage(error)); break; }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
    s.reconnecting = false;
  }

  for (const side of opts.sides) {
    const s: SideState = { side, session: null, handle: undefined, buffer: [], reconnecting: false, text: "", span: null, lastSpan: null, active: false, flushTimer: null };
    states.set(side, s);
  }
  try {
    for (const s of states.values()) s.session = await connect(s.side, undefined, callbacksFor(s));
  } catch (error) {
    for (const s of states.values()) try { s.session?.close(); } catch { /* ignore */ }
    throw Error(authMessage(error));
  }

  const vadFactory: VadFactory = opts.vad ?? ((vcb) => createParakeet(opts.vadModelDir ?? "", { ...vcb, text: () => {}, pending: () => {} }, { vadOnly: true }));
  const vad = vadFactory({
    voice(side, active, atMs) {
      cb.voice(side, active, atMs);
      const s = states.get(side);
      if (!s) return;
      s.active = active;
      if (active) {
        // Text still waiting from the previous utterance keeps that utterance's times.
        if (s.text.trim()) emit(s);
        s.span = { start: atMs, end: null };
        if (s.flushTimer) clearTimeout(s.flushTimer);
      } else {
        if (s.span) s.span.end = atMs;
        cb.pending(side, atMs);
        scheduleFlush(s);
      }
    },
    error: cb.error,
  });

  return {
    write(side, pcm, atMs) {
      const s = states.get(side);
      if (!s || stopping) return;
      vad.write(side, pcm, atMs);
      const data = pcm.toString("base64");
      if (s.session && !s.reconnecting) s.session.sendAudio(data);
      else if (s.buffer.length < MAX_BUFFERED_CHUNKS) s.buffer.push(data);
    },
    async stop() {
      if (stopping) return;
      await vad.stop();
      stopping = true;
      for (const s of states.values()) {
        emit(s);
        try { s.session?.close(); } catch { /* ignore */ }
      }
    },
  };
}
