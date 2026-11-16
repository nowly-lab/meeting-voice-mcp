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
