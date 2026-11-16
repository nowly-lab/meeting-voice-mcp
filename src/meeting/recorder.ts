// Runs one meeting: capture → speech engine → segmenter → delivery queue, with WAV files kept while recording
// and compressed after stop. One meeting at a time per Mac.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DeliveryBridge } from "../bridge/bridge.ts";
import type { CaptureEvent, CaptureHandle } from "../capture/helper.ts";
import { compressAudio } from "../audio/compress.ts";
import { createWavWriter, fixWavHeader, type WavWriter } from "../audio/wav.ts";
import { Segmenter, sealSegment, type SealedSegment } from "../segment/segmenter.ts";
import type { SpeechCallbacks, SpeechEngine } from "../speech/types.ts";
import type { MeetingMeta, MeetingStore, Side, Utterance } from "../store/store.ts";

export type EngineKind = "parakeet" | "gemini";
export type EngineFactory = (kind: EngineKind, sides: Side[], cb: SpeechCallbacks, language: string) => Promise<SpeechEngine>;
export type CaptureFn = (sources: Side[], on: { event(e: CaptureEvent): void; pcm(side: Side, chunk: Buffer, atMs: number): void }) => Promise<CaptureHandle>;
export type SourceState = "ok" | "denied" | "off";
export type RecordingStatus = {
  meetingId: string | null;
  title: string | null;
  elapsedMs: number;
  engine: EngineKind | null;
  sources: Record<Side, SourceState>;
  levels: Record<Side, number>;
  pending: number;
  target: string | null;
  error: string | null;
  audioGaps: AudioGap[];
};
export type AudioGap = { side: Side; fromMs: number; toMs: number };
export type LiveEvent =
  | { type: "status"; status: RecordingStatus }
  | { type: "utterance"; meetingId: string; utterance: Utterance }
  | { type: "segment"; meetingId: string; segment: number; utteranceSeqs: number[] }
  | { type: "partial"; meetingId: string; side: Side; active: boolean };
export type StartInput = {
  title?: string;
  instructions?: string;
  engine?: EngineKind;
  language?: string;
  sources?: Side[];
  silenceSeconds?: number;
  agentSession: string | null;
};

const FORCE_MS = 60_000;
const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
const IDLE_FEED_AFTER_MS = 300; // a side silent this long (no PCM at all) is fed silence
const MAX_PAD_MS = 30 * 60_000;
const GEMINI_WAIT_MS = 5_000;

function rms(pcm: Buffer) {
  let sum = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function defaultTitle(now: number) {
  const d = new Date(now);
  const p = (x: number) => String(x).padStart(2, "0");
  return `会議 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Active = {
  meta: MeetingMeta;
  startedClock: number;
  engine: SpeechEngine;
  capture: CaptureHandle | null;
  segmenter: Segmenter;
  wav: Partial<Record<Side, WavWriter>>;
  sources: Record<Side, SourceState>;
  levels: Record<Side, number>;
  error: string | null;
  /** Capture time (ms since capture started) up to which each side's audio has been written / fed. */
  written: Record<Side, number>;
  stopping: boolean;
  gaps: AudioGap[];
};

export class Recorder {
  private readonly deps: {
    store: MeetingStore;
    bridge: DeliveryBridge;
    capture: CaptureFn;
    engines: EngineFactory;
    clock: () => number;
    events: (e: LiveEvent) => void;
    compress?: (wav: string, m4a: string) => Promise<void>;
    tickMs?: number;
  };
  private active: Active | null = null;
  private starting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private background: Promise<void> = Promise.resolve();
  private lastLevelEmit = 0;

  constructor(deps: Recorder["deps"]) {
    this.deps = deps;
  }

  async start(input: StartInput): Promise<MeetingMeta> {
    if (this.active || this.starting) {
      const m = this.active?.meta;
      throw Error(m ? `録音中の会議があります: ${m.title} (${m.id})` : "録音を始めているところです");
    }
    this.starting = true;
    try {
      const { store, clock } = this.deps;
      const engineKind = input.engine ?? "parakeet";
      const sources = input.sources ?? ["mic", "system"];
      const silenceSeconds = input.silenceSeconds ?? 3;
      let ref: Active | null = null;
      const cb: SpeechCallbacks = {
        voice: (side, active, atMs) => {
          ref?.segmenter.voice(side, active, atMs);
          if (ref) this.deps.events({ type: "partial", meetingId: ref.meta.id, side, active });
        },
        pending: (side, atMs) => ref?.segmenter.pendingTranscript(side, atMs),
        text: (u) => { if (ref) this.addUtteranceTo(ref, u); },
        error: (message) => { if (ref) { ref.error = message; this.emitStatus(); } },
      };
      // The engine first: a missing key or model fails here, before any meeting is created.
      const engine = await this.deps.engines(engineKind, sources, cb, input.language ?? "ja");
      const meta = store.createMeeting({
        title: input.title?.trim() || defaultTitle(clock()),
        startedAt: new Date(clock()).toISOString(),
        engine: engineKind,
        language: input.language ?? "ja",
        instructions: input.instructions ?? "",
        agentSession: input.agentSession,
        silenceSeconds,
      });
      const active: Active = {
        meta,
        startedClock: clock(),
        engine,
        capture: null,
        segmenter: new Segmenter(
          { silenceMs: silenceSeconds * 1000, forceMs: FORCE_MS, transcriptWaitMs: engineKind === "gemini" ? GEMINI_WAIT_MS : 0 },
          (s) => this.onSeal(meta.id, s),
        ),
        wav: {},
        sources: { mic: sources.includes("mic") ? "ok" : "off", system: sources.includes("system") ? "ok" : "off" },
        levels: { mic: 0, system: 0 },
        error: null,
        written: { mic: 0, system: 0 },
        stopping: false,
        gaps: [],
      };
      ref = active;
      this.deps.bridge.setTarget(meta.id, input.agentSession);
      for (const side of sources) active.wav[side] = createWavWriter(store.audioPath(meta.id, side, "wav"));
      try {
        active.capture = await this.deps.capture(sources, {
          event: (e) => {
            if (e.event === "denied") { active.sources[e.side] = "denied"; active.error = e.message; this.emitStatus(); }
            if (e.event === "error") { active.error = e.message; this.emitStatus(); }
            // The helper ended without being asked to (crash, killed): finish the meeting as interrupted.
            if (e.event === "stopped" && !active.stopping && this.active === active) void this.finish(true).catch(() => {});
          },
          pcm: (side, chunk, atMs) => {
            this.writeAudio(active, side, chunk, atMs);
            active.levels[side] = rms(chunk);
            const now = clock();
            if (now - this.lastLevelEmit > 200) { this.lastLevelEmit = now; this.emitStatus(); }
          },
        });
      } catch (error) {
        await engine.stop().catch(() => {});
        for (const w of Object.values(active.wav)) await w?.close();
        store.updateMeeting(meta.id, { status: "saved", endedAt: new Date(clock()).toISOString(), interrupted: true });
        throw error;
      }
      // Capture timestamps start at 0 when the helper is ready; the silence clock and labels share that epoch.
      active.startedClock = clock();
      active.meta = store.updateMeeting(meta.id, { startedAt: new Date(active.startedClock).toISOString() });
      this.active = active;
      const tickMs = this.deps.tickMs ?? 250;
      if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs);
      this.emitStatus();
      return meta;
    } finally {
      this.starting = false;
    }
  }

  /** Called on a timer: closes segments on silence and releases expired delivery claims. */
  tick(): void {
    this.deps.bridge.releaseExpiredClaims();
    const a = this.active;
    if (!a) return;
    const now = this.deps.clock() - a.startedClock;
    // A process tap sends nothing while no app plays. Feed silence so the VAD can end the last utterance.
    // Fill only up to now minus the margin, so real PCM that is merely a little late is not covered.
    for (const side of ["mic", "system"] as const) {
      if (a.sources[side] !== "ok" || a.written[side] === 0) continue;
      const gap = now - IDLE_FEED_AFTER_MS - a.written[side];
      if (gap > 0) {
        const ms = Math.floor(gap);
        const silence = Buffer.alloc(ms * BYTES_PER_MS);
        a.wav[side]?.write(silence);
        a.engine.write(side, silence, a.written[side]);
        a.written[side] += ms;
      }
    }
    a.segmenter.tick(now);
  }

  /** Writes PCM on the capture timeline: a gap before `atMs` becomes silence in the saved audio too. */
  // One cursor per side: the saved audio and the engine get exactly the same samples. A chunk that starts
  // before the cursor (it was covered by idle silence) is trimmed to the cursor; one wholly before it is dropped.
  private writeAudio(a: Active, side: Side, chunk: Buffer, atMs: number) {
    const wav = a.wav[side];
    const cursor = a.written[side];
    let data = chunk;
    let at = atMs;
    if (at < cursor) {
      // Real audio that idle silence already covered: it cannot be kept on the timeline, so it is recorded as lost.
      const skipBytes = Math.round((cursor - at) * BYTES_PER_MS / 2) * 2;
      const lostTo = Math.min(cursor, at + chunk.length / BYTES_PER_MS);
      this.recordGap(a, { side, fromMs: Math.round(at), toMs: Math.round(lostTo) });
      if (skipBytes >= data.length) return;
      data = data.subarray(skipBytes);
      at = cursor;
    } else if (at > cursor) {
      const gapMs = Math.min(MAX_PAD_MS, at - cursor);
      wav?.write(Buffer.alloc(Math.round(gapMs * BYTES_PER_MS / 2) * 2));
    }
    wav?.write(data);
    a.engine.write(side, data, at);
    a.written[side] = at + data.length / BYTES_PER_MS;
  }

  addUtterance(u: Omit<Utterance, "seq" | "id">): void {
    if (this.active) this.addUtteranceTo(this.active, u);
  }

  private addUtteranceTo(a: Active, u: Omit<Utterance, "seq" | "id">) {
    const full: Utterance = { ...u, seq: this.deps.store.nextSeq(), id: randomUUID() };
    const kept = a.segmenter.utterance(full) ?? full;
    this.deps.store.appendUtterance(a.meta.id, kept);
    this.deps.events({ type: "utterance", meetingId: a.meta.id, utterance: kept });
  }

  private onSeal(meetingId: string, s: SealedSegment) {
    this.deps.store.appendSegmentEvent(meetingId, {
      type: "sealed",
      segment: s.segment,
      utteranceSeqs: s.utterances.map((u) => u.seq),
      at: new Date(this.deps.clock()).toISOString(),
      ...(s.forced ? { forced: true } : {}),
    });
    this.deps.bridge.enqueue(meetingId, s);
    this.deps.events({ type: "segment", meetingId, segment: s.segment, utteranceSeqs: s.utterances.map((u) => u.seq) });
  }

  private recordGap(a: Active, gap: AudioGap) {
    const last = a.gaps.at(-1);
    if (last && last.side === gap.side && gap.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, gap.toMs);
    else if (a.gaps.length < 1000) a.gaps.push(gap);
    a.meta = this.deps.store.updateMeeting(a.meta.id, { audioGaps: a.gaps });
    this.emitStatus();
  }

  stop(): Promise<MeetingMeta> {
    return this.finish(false);
  }

  private finishing: Promise<MeetingMeta> | null = null;

  /** One finalization at a time: a requested stop and a helper exit never finalize twice. */
  private finish(interrupted: boolean): Promise<MeetingMeta> {
    if (this.finishing) return this.finishing;
    const a = this.active;
    if (!a) return Promise.reject(Error("録音中の会議はありません"));
    a.stopping = true;
    this.finishing = this.finalize(a, interrupted).finally(() => (this.finishing = null));
    return this.finishing;
  }

  private async finalize(a: Active, interrupted: boolean): Promise<MeetingMeta> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await a.capture?.stop().catch(() => {});
    await a.engine.stop().catch(() => {});
    a.segmenter.flush(this.deps.clock() - a.startedClock);
    for (const w of Object.values(a.wav)) await w?.close();
    this.active = null;
    const meta = this.deps.store.updateMeeting(a.meta.id, {
      status: "stopped",
      endedAt: new Date(this.deps.clock()).toISOString(),
      ...(interrupted ? { interrupted: true } : {}),
    });
    this.background = this.background.then(() => this.compressMeeting(meta.id));
    this.emitStatus();
    return meta;
  }

  private async compressMeeting(id: string) {
    const { store } = this.deps;
    const compress = this.deps.compress ?? compressAudio;
    let ok = true;
    for (const side of ["mic", "system"] as const) {
      const wav = store.audioPath(id, side, "wav");
      if (!existsSync(wav)) continue;
      try {
        await compress(wav, store.audioPath(id, side, "m4a"));
      } catch {
        ok = false;
      }
    }
    if (ok) store.updateMeeting(id, { status: "saved" });
  }

  /** Resolves when background compression has finished. */
  idle(): Promise<void> {
    return this.background;
  }

  /** At server start: a meeting left "recording" (crash, sleep, kill) is stopped as interrupted, nothing is lost. */
  async recoverInterrupted(): Promise<void> {
    const { store, bridge } = this.deps;
    for (const meta of store.listMeetings(0, 10_000)) {
      // Undelivered segments of any meeting stay deliverable after a restart.
      if (meta.status === "saved") {
        bridge.restore(meta.id, meta.agentSession);
        continue;
      }
      if (meta.status === "recording") {
        const { utterances, segments } = store.readMeeting(meta.id);
        const sealedSeqs = new Set(segments.flatMap((e) => (e.type === "sealed" ? e.utteranceSeqs : [])));
        const open = utterances.filter((u) => !sealedSeqs.has(u.seq) && !u.echoOf);
        if (open.length > 0) {
          const next = Math.max(0, ...segments.map((e) => e.segment)) + 1;
          const s = sealSegment(open, next, false);
          store.appendSegmentEvent(meta.id, { type: "sealed", segment: s.segment, utteranceSeqs: s.utterances.map((u) => u.seq), at: new Date(this.deps.clock()).toISOString() });
        }
        store.updateMeeting(meta.id, { status: "stopped", interrupted: true, endedAt: meta.endedAt ?? new Date(this.deps.clock()).toISOString() });
        for (const side of ["mic", "system"] as const) {
          const wav = store.audioPath(meta.id, side, "wav");
          if (existsSync(wav)) fixWavHeader(wav);
        }
      }
      bridge.restore(meta.id, meta.agentSession);
      this.background = this.background.then(() => this.compressMeeting(meta.id));
    }
  }

  status(): RecordingStatus {
    const a = this.active;
    const pending = a ? this.deps.bridge.pending(a.meta.id) : { count: 0, target: null };
    return {
      meetingId: a?.meta.id ?? null,
      title: a?.meta.title ?? null,
      elapsedMs: a ? this.deps.clock() - a.startedClock : 0,
      engine: a?.meta.engine ?? null,
      sources: a?.sources ?? { mic: "off", system: "off" },
      levels: a?.levels ?? { mic: 0, system: 0 },
      pending: pending.count,
      target: pending.target,
      error: a?.error ?? null,
      audioGaps: a ? a.gaps.map((g) => ({ ...g })) : [],
    };
  }

  activeMeetingId(): string | null {
    return this.active?.meta.id ?? null;
  }

  private emitStatus() {
    this.deps.events({ type: "status", status: this.status() });
  }
}
