import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressAudio } from "../src/audio/compress.ts";
import { createWavWriter, fixWavHeader } from "../src/audio/wav.ts";

test("wav writer produces a valid header with the data size", async () => {
  const d = mkdtempSync(join(tmpdir(), "mv-wav-"));
  const w = createWavWriter(join(d, "a.wav"));
  w.write(Buffer.alloc(32000, 1));
  await w.close();
  const b = readFileSync(join(d, "a.wav"));
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.readUInt32LE(40), 32000);
  assert.equal(b.readUInt32LE(24), 16000);
});

test("fixWavHeader repairs sizes after a crash", () => {
  const d = mkdtempSync(join(tmpdir(), "mv-wav-"));
  const w = createWavWriter(join(d, "a.wav"));
  w.write(Buffer.alloc(1000));
  // no close: header still says 0
  fixWavHeader(join(d, "a.wav"));
  assert.equal(readFileSync(join(d, "a.wav")).readUInt32LE(40), 1000);
});

test("compressAudio makes an m4a and removes the wav", async () => {
  const d = mkdtempSync(join(tmpdir(), "mv-cmp-"));
  const w = createWavWriter(join(d, "a.wav"));
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  w.write(pcm);
  await w.close();
  await compressAudio(join(d, "a.wav"), join(d, "a.m4a"));
  assert.ok(statSync(join(d, "a.m4a")).size > 0);
  assert.equal(existsSync(join(d, "a.wav")), false);
});

test("compressAudio keeps the wav when conversion fails", async () => {
  const d = mkdtempSync(join(tmpdir(), "mv-cmp-"));
  writeFileSync(join(d, "bad.wav"), "not audio");
  await assert.rejects(compressAudio(join(d, "bad.wav"), join(d, "bad.m4a")));
  assert.equal(existsSync(join(d, "bad.wav")), true);
});
