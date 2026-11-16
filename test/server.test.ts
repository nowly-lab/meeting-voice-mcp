import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { connectRemote } from "../src/mcp/stdio.ts";
import { fakeHardware } from "./helpers/fakes.ts";

async function boot() {
  const hw = fakeHardware();
  const dataDir = mkdtempSync(join(tmpdir(), "mv-srv-"));
  const s = await startServer({ dataDir, env: {}, capture: hw.capture, engines: hw.engines, openUrl: () => {} });
  return { s, hw, dataDir };
}
function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}
const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("refuses a foreign Host with 421", async () => {
  const { s } = await boot();
  assert.equal((await raw(s.port, "/", { headers: { host: "evil.example" } })).status, 421);
  await s.close();
});

test("/mcp and the bridge refuse Origin (403) and a missing token (401)", async () => {
  const { s } = await boot();
  const auth = { authorization: `Bearer ${s.token}` };
  assert.equal((await raw(s.port, "/mcp", { method: "POST", headers: { ...json, ...auth, origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await raw(s.port, "/mcp", { method: "POST", headers: json, body: "{}" })).status, 401);
  assert.equal((await raw(s.port, "/api/bridge/poll", { method: "POST", headers: { ...json, ...auth, origin: "http://127.0.0.1" }, body: "{}" })).status, 403);
  assert.equal((await raw(s.port, "/api/bridge/poll", { method: "POST", headers: json, body: "{}" })).status, 401);
  await s.close();
});

test("page APIs need the nonce and cannot write", async () => {
  const { s } = await boot();
  assert.equal((await raw(s.port, "/api/status")).status, 403);
  const page = await raw(s.port, "/");
  const nonce = /__NONCE__="([0-9a-f-]+)"/.exec(page.body)?.[1] ?? /data-nonce="([0-9a-f-]+)"/.exec(page.body)?.[1];
  assert.ok(nonce, "page carries a nonce");
  assert.equal((await raw(s.port, `/api/status?nonce=${nonce}`)).status, 200);
  assert.equal((await raw(s.port, `/api/meetings?nonce=${nonce}`, { method: "POST", body: "{}" })).status, 404);
  await s.close();
});

test("tools/list over HTTP has the 10 tools", async () => {
  const { s } = await boot();
  const c = await connectRemote({ port: s.port, pid: process.pid, token: s.token });
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_meeting", "get_new_utterances", "get_transcript", "list_meetings", "open_page", "recording_status", "search_meetings", "start_recording", "stop_recording", "take_delivery"]);
  await c.close();
  await s.close();
});

test("start over HTTP with a session header targets that session; plugin poll gets the segment", async () => {
  const { s, hw } = await boot();
  const c = await connectRemote({ port: s.port, pid: process.pid, token: s.token }, "session-A");
  const r = await c.callTool({ name: "start_recording", arguments: { title: "t", instructions: "図を直す" } });
  assert.equal(r.isError, undefined);
  hw.state.cb!.text({ side: "mic", text: "在庫を引き当てる", startMs: 0, endMs: 500 });
  await s.recorder.stop();
  const poll = await raw(s.port, "/api/bridge/poll", { method: "POST", headers: { ...json, authorization: `Bearer ${s.token}` }, body: JSON.stringify({ session: "session-A", waitMs: 0 }) });
  const delivery = JSON.parse(poll.body).delivery;
  assert.ok(delivery.text.includes("在庫を引き当てる"));
  assert.ok(delivery.text.includes("録音開始時の指示: 図を直す"));
  await c.close();
  await s.close();
});

test("gemini without a key: isError naming GEMINI_API_KEY and no meeting", async () => {
  const { s } = await boot();
  const c = await connectRemote({ port: s.port, pid: process.pid, token: s.token });
  const r = await c.callTool({ name: "start_recording", arguments: { engine: "gemini" } });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /GEMINI_API_KEY/);
  assert.equal(s.store.listMeetings(0, 10).length, 0);
  await c.close();
  await s.close();
});

test("F4: a second server on the same data folder is refused", async () => {
  const hw = fakeHardware();
  const dataDir = mkdtempSync(join(tmpdir(), "mv-srv-"));
  const results = await Promise.allSettled([0, 1].map(() => startServer({ dataDir, env: {}, capture: hw.capture, engines: hw.engines, openUrl: () => {} })));
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already running|動いています/);
  await (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startServer>>>).value.close();
  const again = await startServer({ dataDir, env: {}, capture: hw.capture, engines: hw.engines, openUrl: () => {} });
  await again.close();
});

test("F7: open_page links open the meeting in history", async () => {
  const { s } = await boot();
  const c = await connectRemote({ port: s.port, pid: process.pid, token: s.token });
  const r = await c.callTool({ name: "open_page", arguments: { meeting_id: "11111111-1111-4111-8111-111111111111" } });
  assert.match(JSON.stringify(r.content), /#history=11111111-1111-4111-8111-111111111111/);
  await c.close(); await s.close();
});
