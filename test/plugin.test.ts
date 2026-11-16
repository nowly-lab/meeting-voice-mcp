import { test } from "node:test";
import assert from "node:assert/strict";
import { createLink, type PluginHost, TOOL_INPUT_SCHEMA } from "../plugin/hooks/delivery.ts";

type Call = { url: string; body: unknown; headers: Record<string, string> };
function host(opts: { submitDrop?: string; appendFails?: boolean; serverDown?: number } = {}) {
  const calls: Call[] = [];
  const submitted: string[] = [];
  const appended: string[] = [];
  let starts = 0;
  let down = opts.serverDown ?? 0;
  let info: { port: number; pid: number; token: string } | null = down ? null : { port: 4000, pid: 1, token: "t1" };
  const deliveries: unknown[] = [];
  const h: PluginHost = {
    sessionId: async () => "S1",
    readServerInfo: async () => info,
    startServer: async () => { starts++; down = 0; info = { port: 4001, pid: 2, token: "t2" }; },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body, headers: init.headers });
      if (url.endsWith("/api/bridge/poll")) return { ok: true, status: 200, text: JSON.stringify({ delivery: deliveries.shift() ?? null }) };
      if (url.endsWith("/mcp")) return { ok: true, status: 200, text: JSON.stringify({ result: { content: [{ type: "text", text: `called ${body.params.name}` }] } }) };
      return { ok: true, status: 200, text: "{}" };
    },
    submit: async (text) => { submitted.push(text); return opts.submitDrop ? { drop: opts.submitDrop } : {}; },
    append: async (text) => { if (opts.appendFails) throw Error("refused"); appended.push(text); },
    log: () => {},
  };
  return { h, calls, submitted, appended, deliveries, starts: () => starts };
}
const d = (id: string) => ({ id, meetingId: "m", segments: [1], text: `区切り ${id}`, resent: false });

test("idle: a polled delivery becomes a prompt and is acked", async () => {
  const x = host();
  const link = createLink(x.h);
  x.deliveries.push(d("00000000-0000-4000-8000-000000000001"));
  await link.pollOnce();
  assert.deepEqual(x.submitted, ["区切り 00000000-0000-4000-8000-000000000001"]);
  assert.ok(x.calls.some((c) => c.url.endsWith("/api/bridge/ack") && (c.body as { id: string }).id === "00000000-0000-4000-8000-000000000001"));
  assert.equal(x.calls.find((c) => c.url.endsWith("/api/bridge/poll"))!.headers.authorization, "Bearer t1");
  assert.deepEqual(x.calls.find((c) => c.url.endsWith("/api/bridge/poll"))!.body, { session: "S1", waitMs: 20000 });
});

test("busy: the delivery goes into the running turn and is acked", async () => {
  const x = host();
  const link = createLink(x.h);
  link.turnStarted();
  x.deliveries.push(d("00000000-0000-4000-8000-000000000002"));
  await link.pollOnce();
  assert.deepEqual(x.appended, ["区切り 00000000-0000-4000-8000-000000000002"]);
  assert.deepEqual(x.submitted, []);
  assert.ok(x.calls.some((c) => c.url.endsWith("/api/bridge/ack")));
});

test("a dropped prompt is released, not acked", async () => {
  const x = host({ submitDrop: "stopped" });
  const link = createLink(x.h);
  x.deliveries.push(d("00000000-0000-4000-8000-000000000003"));
  await link.pollOnce();
  assert.ok(x.calls.some((c) => c.url.endsWith("/api/bridge/release")));
  assert.ok(!x.calls.some((c) => c.url.endsWith("/api/bridge/ack")));
});

test("busy and append refused: waits for idle, then submits", async () => {
  const x = host({ appendFails: true });
  const link = createLink(x.h);
  link.turnStarted();
  x.deliveries.push(d("00000000-0000-4000-8000-000000000004"));
  const p = link.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(x.submitted, []);
  link.turnEnded();
  await p;
  assert.deepEqual(x.submitted, ["区切り 00000000-0000-4000-8000-000000000004"]);
});

test("the tool call is relayed with the session header, starting the server once if it is down", async () => {
  const x = host({ serverDown: 1 });
  const link = createLink(x.h);
  const r = await link.callTool({ action: "start_recording", title: "注文フロー", instructions: "図を直す" });
  assert.equal(r.text, "called start_recording");
  assert.equal(x.starts(), 1);
  const mcp = x.calls.find((c) => c.url === "http://127.0.0.1:4001/mcp")!;
  assert.equal(mcp.headers["x-meeting-voice-session"], "S1");
  assert.equal(mcp.headers.authorization, "Bearer t2");
  assert.deepEqual((mcp.body as { params: unknown }).params, { name: "start_recording", arguments: { title: "注文フロー", instructions: "図を直す" } });
});

test("an unknown action is refused without a request", async () => {
  const x = host();
  const r = await createLink(x.h).callTool({ action: "rm -rf" });
  assert.ok("deny" in r);
  assert.equal(x.calls.length, 0);
});

test("the tool schema lists every server tool as an action", () => {
  assert.deepEqual((TOOL_INPUT_SCHEMA.properties.action as { enum: string[] }).enum.sort(),
    ["get_meeting", "get_new_utterances", "get_transcript", "list_meetings", "open_page", "recording_status", "search_meetings", "start_recording", "stop_recording", "take_delivery"]);
});
