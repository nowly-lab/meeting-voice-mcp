import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingStore, type Utterance } from "../src/store/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "mv-store-"));
const base = { title: "注文フローの整理", startedAt: "2026-11-16T05:02:00.000Z", engine: "parakeet" as const, language: "ja",
  instructions: "図を直す", agentSession: null, silenceSeconds: 3 };
const u = (seq: number, text: string, side: "mic" | "system" = "mic"): Utterance => ({ seq, id: `u${seq}`, side, startMs: seq * 1000, endMs: seq * 1000 + 500, text });

test("nextSeq keeps increasing across instances", () => {
  const d = dir();
  const a = new MeetingStore(d);
  assert.equal(a.nextSeq(), 1);
  assert.equal(a.nextSeq(), 2);
  assert.equal(new MeetingStore(d).nextSeq(), 3);
});

test("utterances are appended and read back in order", () => {
  const s = new MeetingStore(dir());
  const m = s.createMeeting(base);
  assert.equal(m.status, "recording");
  s.appendUtterance(m.id, u(1, "一"));
  s.appendUtterance(m.id, u(2, "二", "system"));
  s.appendUtterance(m.id, u(3, "三"));
  assert.deepEqual(s.readMeeting(m.id).utterances.map((x) => x.text), ["一", "二", "三"]);
});

test("a truncated last line is skipped", () => {
  const d = dir();
  const s = new MeetingStore(d);
  const m = s.createMeeting(base);
  s.appendUtterance(m.id, u(1, "一"));
  appendFileSync(join(d, "meetings", m.id, "utterances.jsonl"), '{"seq":2,"id":"u2","si');
  assert.deepEqual(s.readMeeting(m.id).utterances.map((x) => x.text), ["一"]);
});

test("segment events and meeting updates persist", () => {
  const s = new MeetingStore(dir());
  const m = s.createMeeting(base);
  s.appendSegmentEvent(m.id, { type: "sealed", segment: 1, utteranceSeqs: [1], at: "t" });
  s.updateMeeting(m.id, { status: "stopped", endedAt: "e" });
  const r = s.readMeeting(m.id);
  assert.equal(r.segments.length, 1);
  assert.equal(r.meta.status, "stopped");
});

test("server info is written with mode 0600", () => {
  const d = dir();
  const s = new MeetingStore(d);
  s.writeServerInfo({ port: 4321, pid: 99, token: "t" });
  assert.equal(statSync(join(d, "server.json")).mode & 0o777, 0o600);
  assert.deepEqual(s.readServerInfo(), { port: 4321, pid: 99, token: "t" });
});

test("listMeetings is newest first and search hits title and text", () => {
  const s = new MeetingStore(dir());
  const a = s.createMeeting({ ...base, title: "在庫連携", startedAt: "2026-11-15T00:00:00.000Z" });
  const b = s.createMeeting({ ...base, title: "返品", startedAt: "2026-11-16T00:00:00.000Z" });
  s.appendUtterance(b.id, u(1, "在庫を戻します"));
  assert.deepEqual(s.listMeetings(0, 10).map((m) => m.id), [b.id, a.id]);
  const hits = s.search("在庫", 0, 10);
  assert.deepEqual(hits.map((h) => h.meta.id).sort(), [a.id, b.id].sort());
  assert.ok(hits.find((h) => h.meta.id === b.id)!.excerpts[0]!.includes("在庫を戻します"));
});

test("audioPath points inside the meeting folder", () => {
  const d = dir();
  const s = new MeetingStore(d);
  const m = s.createMeeting(base);
  assert.equal(s.audioPath(m.id, "system", "m4a"), join(d, "meetings", m.id, "audio", "system.m4a"));
});
