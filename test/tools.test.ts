import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingStore } from "../src/store/store.ts";
import { DeliveryBridge } from "../src/bridge/bridge.ts";
import { Recorder } from "../src/meeting/recorder.ts";
import { callTool, type ToolContext } from "../src/mcp/tools.ts";
import { fakeHardware } from "./helpers/fakes.ts";

function ctx(session: string | null = null) {
  const hw = fakeHardware();
  const store = new MeetingStore(mkdtempSync(join(tmpdir(), "mv-tools-")));
  const bridge = new DeliveryBridge(store);
  const recorder = new Recorder({ store, bridge, capture: hw.capture, engines: hw.engines, clock: Date.now, events: () => {}, compress: async () => {}, tickMs: 0 });
  const c: ToolContext = { recorder, store, bridge, session, pageUrl: (id) => `http://x/${id ?? ""}`, openUrl: () => {} };
  return { c, hw, store, bridge };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text).data;

test("arguments are checked strictly", async () => {
  const { c } = ctx();
  const r = await callTool(c, "start_recording", { silence_seconds: 99 });
  assert.equal(r.isError, true);
  assert.equal((await callTool(c, "list_meetings", { extra: 1 })).isError, true);
  assert.equal((await callTool(c, "nope", {})).isError, true);
});

test("get_new_utterances returns only utterances after after_seq, without echoes", async () => {
  const { c, hw } = ctx();
  await callTool(c, "start_recording", {});
  hw.state.cb!.text({ side: "system", text: "在庫が足りないときは保留", startMs: 0, endMs: 500 });
  hw.state.cb!.text({ side: "mic", text: "在庫が足りないときは保留", startMs: 800, endMs: 1300 });
  hw.state.cb!.text({ side: "mic", text: "決済が完了したら", startMs: 6000, endMs: 6500 });
  const all = body(await callTool(c, "get_new_utterances", {}));
  assert.deepEqual(all.utterances.map((u: { text: string }) => u.text), ["在庫が足りないときは保留", "決済が完了したら"]);
  const after = body(await callTool(c, "get_new_utterances", { after_seq: all.utterances[0].seq }));
  assert.deepEqual(after.utterances.map((u: { text: string }) => u.text), ["決済が完了したら"]);
  assert.equal(after.lastSeq, all.utterances[1].seq);
});

test("start without a session says how to read speech; take_delivery needs a session", async () => {
  const { c } = ctx(null);
  const started = body(await callTool(c, "start_recording", {}));
  assert.match(started.delivery, /get_new_utterances/);
  assert.equal((await callTool(c, "take_delivery", {})).isError, true);
});

test("take_delivery moves waiting segments to this session", async () => {
  const a = ctx(null);
  await callTool(a.c, "start_recording", {});
  a.hw.state.cb!.text({ side: "mic", text: "一", startMs: 0, endMs: 100 });
  await callTool(a.c, "stop_recording", {});
  const id = a.store.listMeetings(0, 1)[0]!.id;
  assert.deepEqual(a.bridge.pending(id), { count: 1, target: null });
  const r = body(await callTool({ ...a.c, session: "B" }, "take_delivery", {}));
  assert.equal(r.target, "B");
  assert.equal(a.store.readMeta(id).agentSession, "B");
});

test("search, list and transcript paging", async () => {
  const { c, hw } = ctx();
  await callTool(c, "start_recording", { title: "返品の流れ" });
  for (let i = 0; i < 5; i++) hw.state.cb!.text({ side: "mic", text: `発言${i}`, startMs: i * 5000, endMs: i * 5000 + 100 });
  await callTool(c, "stop_recording", {});
  const list = body(await callTool(c, "list_meetings", {}));
  assert.equal(list[0].title, "返品の流れ");
  assert.equal(body(await callTool(c, "search_meetings", { query: "発言3" }))[0].excerpts[0], "発言3");
  const page = body(await callTool(c, "get_transcript", { id: list[0].id, offset: 2, limit: 2 }));
  assert.deepEqual(page.utterances.map((u: { text: string }) => u.text), ["発言2", "発言3"]);
  assert.equal(page.total, 5);
});

test("stop_recording returns only a summary", async () => {
  const { c, hw } = ctx();
  await callTool(c, "start_recording", { title: "返品の流れ", instructions: "図を直す" });
  hw.state.cb!.text({ side: "mic", text: "一", startMs: 0, endMs: 100 });
  hw.state.cb!.text({ side: "mic", text: "二", startMs: 200, endMs: 300 });
  const r = body(await callTool(c, "stop_recording", {}));
  assert.deepEqual(Object.keys(r.meeting).sort(), ["audioGaps", "endedAt", "engine", "id", "segments", "startedAt", "status", "title", "utterances"]);
  assert.equal(r.meeting.title, "返品の流れ");
  assert.equal(r.meeting.utterances, 2);
  assert.equal(r.meeting.segments, 1);
  assert.deepEqual(r.meeting.audioGaps, { count: 0, totalMs: 0 });
  assert.match(r.page, /^http:\/\/x\//);
});
