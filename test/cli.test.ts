import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureServer } from "../src/mcp/stdio.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { MeetingStore } from "../src/store/store.ts";
import { fakeHardware } from "./helpers/fakes.ts";
import { main, PLUGIN_INSTRUCTIONS } from "../src/cli.ts";

test("ensureServer starts a server when none runs, and reuses a healthy one", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mv-cli-"));
  let spawned = 0;
  let server: RunningServer | null = null;
  const spawnServer = (d: string) => { spawned++; const hw = fakeHardware(); void startServer({ dataDir: d, env: {}, capture: hw.capture, engines: hw.engines, openUrl: () => {} }).then((s) => (server = s)); };
  const a = await ensureServer(dataDir, { spawnServer, timeoutMs: 5000 });
  const b = await ensureServer(dataDir, { spawnServer, timeoutMs: 5000 });
  assert.equal(spawned, 1);
  assert.equal(a.port, b.port);
  await (server as RunningServer | null)?.close();
});

test("a stale server.json (dead pid) is replaced", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mv-cli-"));
  new MeetingStore(dataDir).writeServerInfo({ port: 1, pid: 999999, token: "old" });
  let server: RunningServer | null = null;
  const spawnServer = (d: string) => { const hw = fakeHardware(); void startServer({ dataDir: d, env: {}, capture: hw.capture, engines: hw.engines, openUrl: () => {} }).then((s) => (server = s)); };
  const info = await ensureServer(dataDir, { spawnServer, timeoutMs: 5000 });
  assert.notEqual(info.token, "old");
  await (server as RunningServer | null)?.close();
});

test("install-plugin prints the marketplace commands", async () => {
  let out = "";
  assert.equal(await main(["install-plugin"], {}, { out: (s) => (out += s), err: () => {} }), 0);
  assert.equal(out, PLUGIN_INSTRUCTIONS);
  assert.match(out, /\/plugin marketplace add nowly-lab\/meeting-voice-mcp/);
});

test("status says it is not running", async () => {
  let out = "";
  const code = await main(["status"], { MEETING_VOICE_MCP_DATA_DIR: mkdtempSync(join(tmpdir(), "mv-cli-")) }, { out: (s) => (out += s), err: () => {} });
  assert.equal(code, 1);
  assert.match(out, /動いていません/);
});
