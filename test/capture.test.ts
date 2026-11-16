import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCapture, type CaptureEvent } from "../src/capture/helper.ts";
import { ensureCaptureBinary } from "../src/capture/build.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-capture.mjs", import.meta.url));

function collect(mode: string) {
  process.env.FAKE_CAPTURE_MODE = mode;
  const events: CaptureEvent[] = [];
  const pcm: Record<string, number> = { mic: 0, system: 0 };
  return { events, pcm, on: { event: (e: CaptureEvent) => events.push(e), pcm: (side: "mic" | "system", b: Buffer) => (pcm[side] += b.length) } };
}

test("resolves on ready and delivers PCM per side", async () => {
  const c = collect("ok");
  const h = await startCapture(fake, ["mic", "system"], c.on);
  await new Promise((r) => setTimeout(r, 80));
  await h.stop();
  assert.ok(c.events.some((e) => e.event === "ready"));
  assert.ok(c.pcm.mic! > 0 && c.pcm.system! > 0);
});

test("system denied keeps the mic running", async () => {
  const c = collect("deny-system");
  const h = await startCapture(fake, ["mic", "system"], c.on);
  await new Promise((r) => setTimeout(r, 80));
  await h.stop();
  assert.ok(c.events.some((e) => e.event === "denied" && e.side === "system"));
  assert.ok(c.pcm.mic! > 0);
  assert.equal(c.pcm.system, 0);
});

test("a helper that cannot start rejects with its message", async () => {
  const c = collect("fail");
  await assert.rejects(startCapture(fake, ["mic"], c.on), /No audio source could start/);
});

test("stop ends the child process", async () => {
  const c = collect("ok");
  const h = await startCapture(fake, ["mic"], c.on);
  await h.stop();
  assert.equal(h.exited(), true);
});

test("ensureCaptureBinary builds once per source hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-build-"));
  let calls = 0;
  const compile = async (_sources: string[], out: string) => { calls++; writeFileSync(out, "#!/bin/sh\n"); chmodSync(out, 0o755); };
  const a = await ensureCaptureBinary(dir, compile);
  const b = await ensureCaptureBinary(dir, compile);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.match(a, /bin\/meeting-voice-capture-[0-9a-f]{12}$/);
});
