import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSideProcessor } from "../src/speech/side-processor.ts";
import { ensureParakeetModel, type ModelFile } from "../src/speech/model.ts";
import { createParakeet } from "../src/speech/parakeet.ts";

function fakeVad() {
  // Speech = any sample > 0.5. Emits a segment when a run of speech ends.
  let detected = false; let buf: number[] = []; let start = 0; let index = 0; const queue: { start: number; samples: Float32Array }[] = [];
  return {
    acceptWaveform(s: Float32Array) { for (const x of s) { if (x > 0.5) { if (!detected) { detected = true; start = index; buf = []; } buf.push(x); } else if (detected) { detected = false; queue.push({ start, samples: Float32Array.from(buf) }); } index++; } },
    isDetected: () => detected, isEmpty: () => queue.length === 0, front: () => queue[0]!, pop: () => void queue.shift(), flush() { if (detected) { detected = false; queue.push({ start, samples: Float32Array.from(buf) }); } },
  };
}

test("side processor reports voice changes and recognized segments with times", () => {
  const p = createSideProcessor({ vad: fakeVad(), recognize: (s) => `len${s.length}` });
  const speech = new Float32Array(1600).fill(0.9); // 100 ms
  const quiet = new Float32Array(1600).fill(0);
  const r1 = p.accept(quiet, 0);
  assert.deepEqual(r1, { voice: [], segments: [] });
  const r2 = p.accept(speech, 100);
  assert.deepEqual(r2.voice, [{ active: true, atMs: 200 }]);
  const r3 = p.accept(quiet, 200);
  assert.deepEqual(r3.voice, [{ active: false, atMs: 300 }]);
  assert.deepEqual(r3.segments, [{ text: "len1600", startMs: 100, endMs: 200 }]);
});

test("side processor fills a time gap with silence", () => {
  const p = createSideProcessor({ vad: fakeVad(), recognize: () => "x" });
  p.accept(new Float32Array(1600).fill(0), 0);
  p.accept(new Float32Array(1600).fill(0.9), 5000); // 4.9 s gap
  const r = p.accept(new Float32Array(1600).fill(0), 5100);
  assert.deepEqual(r.segments, [{ text: "x", startMs: 5000, endMs: 5100 }]);
});

test("side processor drops empty recognitions", () => {
  const p = createSideProcessor({ vad: fakeVad(), recognize: () => "  " });
  p.accept(new Float32Array(1600).fill(0.9), 0);
  assert.deepEqual(p.flush().segments, []);
});

test("ensureParakeetModel rejects a file whose hash does not match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-model-"));
  const body = Buffer.from("model-bytes");
  const files: ModelFile[] = [{ name: "a.onnx", url: "https://example.test/a.onnx", bytes: body.length, sha256: "0".repeat(64) }];
  const fetchImpl = (async () => new Response(body)) as typeof fetch;
  await assert.rejects(ensureParakeetModel(dir, { files, fetch: fetchImpl }), /確認できません/);
  assert.equal(existsSync(join(dir, "models", "parakeet-tdt-ctc-0.6b-ja-int8", "a.onnx")), false);
});

test("ensureParakeetModel downloads once and then trusts the verified marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mv-model-"));
  const body = Buffer.from("model-bytes");
  const files: ModelFile[] = [{ name: "a.onnx", url: "https://example.test/a.onnx", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }];
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(body); }) as typeof fetch;
  const modelDir = await ensureParakeetModel(dir, { files, fetch: fetchImpl });
  await ensureParakeetModel(dir, { files, fetch: fetchImpl });
  assert.equal(calls, 1);
  assert.ok(existsSync(join(modelDir, "verified.json")));
});

test("createParakeet forwards worker messages to callbacks with the side", async () => {
  const worker = Object.assign(new EventEmitter(), { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); }, terminate: async () => 0 });
  const seen: string[] = [];
  const engine = createParakeet("/models", {
    voice: (side, active, at) => seen.push(`voice ${side} ${active} ${at}`),
    text: (u) => seen.push(`text ${u.side} ${u.text} ${u.startMs}-${u.endMs}`),
    pending: () => {}, error: (m) => seen.push(`error ${m}`),
  }, { spawnWorker: () => worker as never });
  worker.emit("message", { type: "ready" });
  engine.write("system", Buffer.alloc(320), 40);
  assert.equal((worker.posted.at(-1) as { type: string; side: string; atMs: number }).side, "system");
  worker.emit("message", { type: "voice", side: "mic", active: true, atMs: 10 });
  worker.emit("message", { type: "segment", side: "mic", text: "在庫", startMs: 10, endMs: 900 });
  worker.emit("message", { type: "error", message: "boom" });
  const stopped = engine.stop();
  worker.emit("message", { type: "finished" });
  await stopped;
  assert.deepEqual(seen, ["voice mic true 10", "text mic 在庫 10-900", "error 文字起こし（Parakeet）でエラー: boom"]);
});

test("real Parakeet model transcribes the synthetic fixture", { skip: process.env.MEETING_VOICE_REAL_MODEL !== "1" && "set MEETING_VOICE_REAL_MODEL=1" }, async () => {
  const { runRealModelCheck } = await import("./helpers/real-model.ts");
  const text = await runRealModelCheck();
  assert.match(text, /保留/);
});

test("real Parakeet worker thread produces side-tagged text", { skip: process.env.MEETING_VOICE_REAL_MODEL !== "1" && "set MEETING_VOICE_REAL_MODEL=1" }, async () => {
  const { synthesize } = await import("./helpers/real-model.ts");
  const modelDir = process.env.MEETING_VOICE_MODEL_DIR!;
  const texts: string[] = [];
  const engine = createParakeet(modelDir, { voice: () => {}, text: (u) => texts.push(`${u.side}:${u.text}`), pending: () => {}, error: (m) => texts.push(`error:${m}`) });
  const pcm = synthesize("注文を保留にします。");
  for (let off = 0, t = 0; off < pcm.length; off += 3200, t += 100) engine.write("system", pcm.subarray(off, off + 3200), t);
  await engine.stop();
  assert.ok(texts.some((t) => t.startsWith("system:") && t.includes("保留")), texts.join("|"));
});
