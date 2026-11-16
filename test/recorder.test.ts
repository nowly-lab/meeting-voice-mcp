import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingStore, type Side } from "../src/store/store.ts";
import { DeliveryBridge } from "../src/bridge/bridge.ts";
import { Recorder, type EngineFactory } from "../src/meeting/recorder.ts";
import type { CaptureEvent } from "../src/capture/helper.ts";
import type { SpeechCallbacks } from "../src/speech/types.ts";

function setup(opts: { denySystem?: boolean; failEngine?: string } = {}) {
  let now = 0;
  const store = new MeetingStore(mkdtempSync(join(tmpdir(), "mv-rec-")));
  const bridge = new DeliveryBridge(store, () => now);
  let cb: SpeechCallbacks | null = null;
  let onCapture: { event(e: CaptureEvent): void; pcm(side: Side, b: Buffer, atMs: number): void } | null = null;
  const engines: EngineFactory = async (kind, _sides, c) => {
    if (opts.failEngine) throw Error(opts.failEngine);
    cb = c;
    return { write: () => {}, stop: async () => {} };
  };
  const capture = async (_sources: Side[], on: typeof onCapture & {}) => {
    onCapture = on;
    if (opts.denySystem) on.event({ event: "denied", side: "system", message: "no permission" });
    on.event({ event: "ready", sources: opts.denySystem ? ["mic"] : ["mic", "system"] });
    return { stop: async () => {}, exited: () => true };
  };
  const compressed: string[] = [];
  const recorder = new Recorder({ store, bridge, capture, engines, clock: () => now, events: () => {}, compress: async (wav) => { compressed.push(wav); }, tickMs: 0 });
  return { store, bridge, recorder, cb: () => cb!, pcm: (side: Side, atMs: number) => onCapture!.pcm(side, Buffer.alloc(3200), atMs), compressed, at: (t: number) => { now = t; recorder.tick(); } };
}

test("start → utterance → 3 s silence → one segment queued for the session", async () => {
  const s = setup();
  const m = await s.recorder.start({ title: "注文フロー", instructions: "図を直す", agentSession: "A" });
  s.cb().voice("mic", true, 0);
  s.cb().text({ side: "mic", text: "注文が確定したら", startMs: 0, endMs: 900 });
  s.cb().voice("mic", false, 1000);
  s.at(3999);
  assert.equal(s.bridge.pending(m.id).count, 0);
  s.at(4000);
  assert.deepEqual(s.bridge.pending(m.id), { count: 1, target: "A" });
  assert.equal(s.store.readMeeting(m.id).utterances.length, 1);
});

test("a second start is refused naming the meeting", async () => {
  const s = setup();
  const m = await s.recorder.start({ title: "注文フロー", agentSession: null });
  await assert.rejects(s.recorder.start({ agentSession: null }), new RegExp(`録音中の会議があります: 注文フロー \\(${m.id}\\)`));
});

test("system denied: the mic keeps working and status says denied", async () => {
  const s = setup({ denySystem: true });
  const m = await s.recorder.start({ agentSession: "A" });
  assert.equal(s.recorder.status().sources.system, "denied");
  assert.equal(s.recorder.status().sources.mic, "ok");
  s.cb().text({ side: "mic", text: "マイクだけ", startMs: 0, endMs: 500 });
  s.at(4000);
  assert.equal(s.bridge.pending(m.id).count, 1);
});

test("an engine failure creates no meeting", async () => {
  const s = setup({ failEngine: "Gemini Live に接続できません。GEMINI_API_KEY を確かめてください" });
  await assert.rejects(s.recorder.start({ engine: "gemini", agentSession: null }), /GEMINI_API_KEY/);
  assert.equal(s.store.listMeetings(0, 10).length, 0);
});

test("stop seals open utterances, then compression marks the meeting saved", async () => {
  const s = setup();
  const m = await s.recorder.start({ agentSession: "A" });
  s.pcm("mic", 0);
  s.pcm("system", 0);
  s.cb().text({ side: "system", text: "開いたまま", startMs: 0, endMs: 500 });
  const stopped = await s.recorder.stop();
  assert.equal(stopped.status, "stopped");
  assert.equal(s.bridge.pending(m.id).count, 1);
  await s.recorder.idle();
  assert.equal(s.store.readMeta(m.id).status, "saved");
  assert.deepEqual(s.compressed.map((p) => p.split("/").pop()).sort(), ["mic.wav", "system.wav"]);
  assert.equal(s.recorder.status().meetingId, null);
});

test("recoverInterrupted stops a meeting left recording and seals its open utterances", async () => {
  const s = setup();
  const m = s.store.createMeeting({ title: "落ちた会議", startedAt: new Date(0).toISOString(), engine: "parakeet", language: "ja", instructions: "", agentSession: "A", silenceSeconds: 3 });
  s.store.appendUtterance(m.id, { seq: s.store.nextSeq(), id: "u1", side: "mic", startMs: 0, endMs: 100, text: "途中まで" });
  await s.recorder.recoverInterrupted();
  await s.recorder.idle();
  const meta = s.store.readMeta(m.id);
  assert.equal(meta.interrupted, true);
  assert.equal(meta.status, "saved");
  assert.equal(s.bridge.pending(m.id).count, 1);
  assert.equal(existsSync(s.store.audioPath(m.id, "mic", "wav")), false);
});

import { readFileSync } from "node:fs";

function setup2(opts: { captureDelayMs?: number } = {}) {
  let now = 1_000_000;
  const store = new MeetingStore(mkdtempSync(join(tmpdir(), "mv-rec2-")));
  const bridge = new DeliveryBridge(store, () => now);
  let cb: SpeechCallbacks | null = null;
  const writes: { side: Side; bytes: number; atMs: number }[] = [];
  let on: { event(e: CaptureEvent): void; pcm(side: Side, b: Buffer, atMs: number): void } | null = null;
  const engines: EngineFactory = async (_k, _s, c) => { cb = c; return { write: (side, pcm, atMs) => void writes.push({ side, bytes: pcm.length, atMs }), stop: async () => {} }; };
  const capture = async (sources: Side[], o: NonNullable<typeof on>) => {
    on = o; now += opts.captureDelayMs ?? 0;
    o.event({ event: "ready", sources });
    return { stop: async () => {}, exited: () => true };
  };
  const recorder = new Recorder({ store, bridge, capture, engines, clock: () => now, events: () => {}, compress: async () => {}, tickMs: 0 });
  return { store, bridge, recorder, writes, cb: () => cb!, on: () => on!, at: (t: number) => { now = t; recorder.tick(); }, now: () => now };
}

test("Q2: the silence clock starts when capture is ready, not before", async () => {
  const s = setup2({ captureDelayMs: 2000 });
  const m = await s.recorder.start({ agentSession: "A" });
  const t0 = s.now();
  s.cb().text({ side: "mic", text: "一", startMs: 0, endMs: 1000 });
  s.at(t0 + 3999);
  assert.equal(s.bridge.pending(m.id).count, 0);
  s.at(t0 + 4000);
  assert.equal(s.bridge.pending(m.id).count, 1);
});

test("F3: retained audio keeps gaps so it shares the transcript timeline", async () => {
  const s = setup2();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", Buffer.alloc(3200), 0);
  s.on().pcm("system", Buffer.alloc(3200), 5000);
  await s.recorder.stop();
  const wav = readFileSync(s.store.audioPath(m.id, "system", "wav"));
  const seconds = wav.readUInt32LE(40) / 32000;
  assert.ok(Math.abs(seconds - 5.1) < 0.01, `duration ${seconds}`);
});

test("Q1: a side that stops sending PCM is fed silence so its last utterance can end", async () => {
  const s = setup2();
  const t0 = s.now();
  await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", Buffer.alloc(3200), 0);
  s.writes.length = 0;
  s.at(t0 + 2000);
  const fed = s.writes.filter((w) => w.side === "system");
  assert.ok(fed.length > 0, "silence was written to the engine");
  assert.equal(fed[0]!.atMs, 100);
  const total = fed.reduce((a, w) => a + w.bytes, 0) / 32;
  assert.ok(total >= 1500 && total <= 1900, `fed ${total} ms`);
});

test("F5: an unexpected capture exit stops the meeting as interrupted", async () => {
  const s = setup2();
  const m = await s.recorder.start({ agentSession: "A" });
  s.cb().text({ side: "mic", text: "途中", startMs: 0, endMs: 100 });
  s.on().event({ event: "stopped" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.recorder.activeMeetingId(), null);
  const meta = s.store.readMeta(m.id);
  assert.equal(meta.interrupted, true);
  assert.equal(s.bridge.pending(m.id).count, 1, "open speech was sealed");
});

test("Q1+F3: fed silence is also in the saved audio, so later chunks stay on the timeline", async () => {
  const s = setup2();
  const t0 = s.now();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", Buffer.alloc(3200), 0);
  s.at(t0 + 2000);
  s.on().pcm("system", Buffer.alloc(3200), 3000);
  await s.recorder.stop();
  const seconds = readFileSync(s.store.audioPath(m.id, "system", "wav")).readUInt32LE(40) / 32000;
  assert.ok(Math.abs(seconds - 3.1) < 0.01, `duration ${seconds}`);
});

const tone = (ms: number, value: number) => { const b = Buffer.alloc(ms * 32); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(value, i * 2); return b; };
const sampleAt = (wav: Buffer, ms: number) => wav.readInt16LE(44 + Math.floor(ms * 16) * 2);

test("R2-1: idle silence keeps a margin, and a late chunk is trimmed to the cursor (no drift)", async () => {
  const s = setup2();
  const t0 = s.now();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", tone(100, 1000), 0);
  s.at(t0 + 2000); // silence fed up to 2000 - 300 = 1700
  s.on().pcm("system", tone(100, 2000), 1650); // overlaps 1650-1700: only 1700-1750 is kept
  s.on().pcm("system", tone(100, 3000), 1750);
  await s.recorder.stop();
  const wav = readFileSync(s.store.audioPath(m.id, "system", "wav"));
  assert.equal(wav.readUInt32LE(40) / 32, 1850, "timeline ends at 1850 ms");
  assert.equal(sampleAt(wav, 50), 1000);
  assert.equal(sampleAt(wav, 1000), 0);
  assert.equal(sampleAt(wav, 1720), 2000);
  assert.equal(sampleAt(wav, 1800), 3000);
  const engine = s.writes.filter((w) => w.side === "system").map((w) => [w.atMs, w.bytes / 32]);
  assert.deepEqual(engine, [[0, 100], [100, 1600], [1700, 50], [1750, 100]]);
});

test("R2-1: a chunk fully inside already-written time is dropped from both audio and engine", async () => {
  const s = setup2();
  const t0 = s.now();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", tone(100, 1000), 0);
  s.at(t0 + 2000);
  s.on().pcm("system", tone(100, 2000), 500);
  await s.recorder.stop();
  const wav = readFileSync(s.store.audioPath(m.id, "system", "wav"));
  assert.equal(wav.readUInt32LE(40) / 32, 1700);
  assert.equal(sampleAt(wav, 550), 0);
  assert.equal(s.recorder.status().meetingId, null);
});

test("R3-1: real PCM dropped behind idle silence is recorded as an audio gap, in status and after reload", async () => {
  const s = setup2();
  const t0 = s.now();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", tone(100, 1000), 0);
  s.at(t0 + 2000);
  s.on().pcm("system", tone(100, 2000), 500);    // wholly behind the cursor: 100 ms lost
  s.on().pcm("system", tone(100, 2000), 1650);   // partly behind: 50 ms lost
  assert.deepEqual(s.recorder.status().audioGaps, [{ side: "system", fromMs: 500, toMs: 600 }, { side: "system", fromMs: 1650, toMs: 1700 }]);
  await s.recorder.stop();
  const reread = new MeetingStore(s.store.dataDir).readMeta(m.id);
  assert.deepEqual(reread.audioGaps, [{ side: "system", fromMs: 500, toMs: 600 }, { side: "system", fromMs: 1650, toMs: 1700 }]);
});

test("R3-1: contiguous chunks record no gap", async () => {
  const s = setup2();
  const m = await s.recorder.start({ agentSession: "A", sources: ["system"] });
  s.on().pcm("system", tone(100, 1000), 0);
  s.on().pcm("system", tone(100, 1000), 100);
  await s.recorder.stop();
  assert.equal(s.store.readMeta(m.id).audioGaps, undefined);
});
