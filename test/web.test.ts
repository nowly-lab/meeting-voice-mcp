import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startServer, type RunningServer } from "../src/server.ts";
import { createWavWriter } from "../src/audio/wav.ts";
import { compressAudio } from "../src/audio/compress.ts";
import type { CaptureFn, EngineFactory } from "../src/meeting/recorder.ts";
import type { SpeechCallbacks } from "../src/speech/types.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const skip = !existsSync(CHROME) && "Google Chrome is not installed";
let browser: Browser;
before(async () => { if (!skip) { execFileSync(process.execPath, ["scripts/build-web.mjs"]); browser = await chromium.launch({ executablePath: CHROME, headless: true }); } });
after(async () => { await browser?.close(); });

async function boot(opts: { denySystem?: boolean } = {}) {
  const state: { cb: SpeechCallbacks | null } = { cb: null };
  const engines: EngineFactory = async (_k, _s, cb) => { state.cb = cb; return { write: () => {}, stop: async () => {} }; };
  const capture: CaptureFn = async (sources, on) => {
    if (opts.denySystem) on.event({ event: "denied", side: "system", message: "no permission" });
    on.event({ event: "ready", sources: opts.denySystem ? ["mic"] : sources });
    return { stop: async () => {}, exited: () => true };
  };
  const s = await startServer({ dataDir: mkdtempSync(join(tmpdir(), "mv-web-")), env: {}, capture, engines, openUrl: () => {} });
  return { s, state };
}
async function open(s: RunningServer, hash = "") {
  const page = await browser.newPage();
  await page.goto(`${s.url}/${hash}`);
  return page;
}

test("idle page waits for Claude and lists the setup checks", { skip }, async () => {
  const { s } = await boot();
  const page = await open(s);
  await page.getByText("Claudeから録音を始めるのを待っています").waitFor();
  assert.equal(await page.locator(".check").count(), 5);
  await page.close(); await s.close();
});

test("live page shows segments with sent, waiting and the echo mark", { skip }, async () => {
  const { s, state } = await boot();
  const m = await s.recorder.start({ title: "注文フローの整理", agentSession: "session-A", silenceSeconds: 1 });
  state.cb!.text({ side: "system", text: "在庫が足りないときは保留", startMs: 0, endMs: 500 });
  state.cb!.text({ side: "mic", text: "在庫が足りないときは保留に", startMs: 900, endMs: 1400 });
  await new Promise((r) => setTimeout(r, 3000)); // 1 s after the last utterance end (1.4 s) seals segment 1
  const d1 = await s.bridge.poll("session-A", 0, new AbortController().signal);
  s.bridge.ack(d1!.id);
  state.cb!.text({ side: "mic", text: "決済が完了したら", startMs: 3000, endMs: 3400 });
  await new Promise((r) => setTimeout(r, 2500));
  const page = await open(s);
  await page.getByText("注文フローの整理").first().waitFor();
  await page.locator(".state.sent").first().waitFor();
  assert.match(await page.locator(".state.sent").first().innerText(), /^送信済み \d{1,2}:\d{2}:\d{2}$/);
  assert.equal(await page.locator(".state.wait").first().innerText(), "待機中（Claudeが作業中）");
  assert.equal(await page.locator(".u.echo").count(), 1);
  assert.equal(await page.locator(".rec").innerText(), "録音中");
  await page.close(); await s.recorder.stop(); await s.close();
  void m;
});

test("no target: the page says how many segments wait", { skip }, async () => {
  const { s, state } = await boot();
  await s.recorder.start({ agentSession: null, silenceSeconds: 1 });
  state.cb!.text({ side: "mic", text: "一", startMs: 0, endMs: 100 });
  await new Promise((r) => setTimeout(r, 1500));
  const page = await open(s);
  await page.getByText("届け先なし（1 件待ち）").waitFor();
  await page.close(); await s.recorder.stop(); await s.close();
});

test("system audio denied shows the permission banner and keeps recording", { skip }, async () => {
  const { s } = await boot({ denySystem: true });
  await s.recorder.start({ agentSession: "A" });
  const page = await open(s);
  await page.getByText("Macの音の許可がありません").waitFor();
  assert.equal(await page.locator(".meter[data-side=system] .need").innerText(), "許可が必要");
  await page.close(); await s.recorder.stop(); await s.close();
});

test("history: list, search, transcript and play from an utterance", { skip }, async () => {
  const { s, state } = await boot();
  const m = await s.recorder.start({ title: "返品対応のルール検討", agentSession: "A" });
  state.cb!.text({ side: "mic", text: "返品を受け付けたら", startMs: 2000, endMs: 3000 });
  await s.recorder.stop();
  await s.recorder.idle();
  // Give the meeting real audio (fake capture wrote an empty WAV).
  const wav = join(tmpdir(), `mv-${Date.now()}.wav`);
  const w = createWavWriter(wav);
  const pcm = Buffer.alloc(32000 * 6);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 6000), i * 2);
  w.write(pcm); await w.close();
  await compressAudio(wav, s.store.audioPath(m.id, "mic", "m4a"));
  const other = s.store.createMeeting({ title: "在庫連携の仕様確認", startedAt: new Date(Date.now() - 86400000).toISOString(), engine: "gemini", language: "ja", instructions: "", agentSession: null, silenceSeconds: 3 });
  s.store.updateMeeting(other.id, { status: "saved", endedAt: new Date().toISOString() });
  const page = await open(s, `#history=${m.id}`);
  await page.locator(".item").nth(1).waitFor();
  assert.equal(await page.locator(".item").count(), 2);
  await page.locator(".search").fill("在庫");
  await page.waitForFunction(() => document.querySelectorAll(".item").length === 1);
  await page.goto(`${s.url}/#history=${m.id}`);
  await page.getByRole("heading", { name: "返品対応のルール検討" }).waitFor();
  await page.locator("audio[data-side=mic]").waitFor();
  await page.locator(".u .play").first().click();
  const t = await page.locator("audio[data-side=mic]").evaluate((a: HTMLAudioElement) => a.currentTime);
  assert.ok(t >= 2 && t < 3.5, `currentTime ${t}`);
  await page.close(); await s.close();
});

test("F6: a permission loss after the page loaded shows the banner", { skip }, async () => {
  let onEvent: ((e: { event: "denied"; side: "system"; message: string }) => void) | null = null;
  const engines: EngineFactory = async () => ({ write: () => {}, stop: async () => {} });
  const capture: CaptureFn = async (sources, on) => { onEvent = on.event as never; on.event({ event: "ready", sources }); return { stop: async () => {}, exited: () => true }; };
  const s = await startServer({ dataDir: mkdtempSync(join(tmpdir(), "mv-web-")), env: {}, capture, engines, openUrl: () => {} });
  await s.recorder.start({ agentSession: "A" });
  const page = await open(s);
  await page.locator(".rec").waitFor();
  await new Promise((r) => setTimeout(r, 500));
  onEvent!({ event: "denied", side: "system", message: "lost" });
  await page.getByText("Macの音の許可がありません").waitFor({ timeout: 3000 });
  await page.close(); await s.recorder.stop(); await s.close();
});

test("F7: a #meeting= link opens that meeting in history", { skip }, async () => {
  const { s, state } = await boot();
  const m = await s.recorder.start({ title: "深いリンク", agentSession: "A" });
  state.cb!.text({ side: "mic", text: "一", startMs: 0, endMs: 100 });
  await s.recorder.stop();
  const page = await open(s, `#meeting=${m.id}`);
  await page.getByRole("heading", { name: "深いリンク" }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-tab=history]").getAttribute("aria-selected"), "true");
  await page.close(); await s.close();
});

test("R3-1: history shows the missing-audio mark for a meeting with audio gaps", { skip }, async () => {
  const { s } = await boot();
  const m = s.store.createMeeting({ title: "欠けのある会議", startedAt: new Date().toISOString(), engine: "parakeet", language: "ja", instructions: "", agentSession: null, silenceSeconds: 3 });
  s.store.updateMeeting(m.id, { status: "saved", endedAt: new Date().toISOString(), audioGaps: [{ side: "system", fromMs: 500, toMs: 2600 }] });
  const page = await open(s, `#history=${m.id}`);
  await page.getByText("音声の欠け 2.1秒").waitFor({ timeout: 5000 });
  await page.close(); await s.close();
});
