import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiLive, type LiveConnect, type VadFactory } from "../src/speech/gemini-live.ts";
import type { Side } from "../src/store/store.ts";

type Conn = { side: Side; handle?: string; sent: number; closed: boolean; cb: Parameters<LiveConnect>[2] };
function fakes(opts: { failAuth?: boolean } = {}) {
  const conns: Conn[] = [];
  const connect: LiveConnect = async (side, handle, cb) => {
    if (opts.failAuth) throw Object.assign(Error("API key not valid"), { code: 1008 });
    const c: Conn = { side, handle, sent: 0, closed: false, cb };
    conns.push(c);
    return { sendAudio: () => void c.sent++, close: () => void (c.closed = true) };
  };
  let vadCb: Parameters<VadFactory>[0] | null = null;
  const vad: VadFactory = (cb) => { vadCb = cb; return { write: () => {}, stop: async () => {} }; };
  return { conns, connect, vad, voice: (side: Side, active: boolean, atMs: number) => vadCb!.voice(side, active, atMs) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = () => { const seen: string[] = []; return { seen, cb: {
  voice: (s: Side, a: boolean, t: number) => seen.push(`voice ${s} ${a} ${t}`),
  text: (u: { side: Side; text: string; startMs: number; endMs: number }) => seen.push(`text ${u.side} ${u.text} ${u.startMs}-${u.endMs}`),
  pending: (s: Side, t: number) => seen.push(`pending ${s} ${t}`), error: (m: string) => seen.push(`error ${m}`) } }; };

test("opens one Live connection per side", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["mic", "system"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  assert.deepEqual(f.conns.map((c) => c.side).sort(), ["mic", "system"]);
  e.write("mic", Buffer.alloc(320), 0);
  assert.equal(f.conns.find((c) => c.side === "mic")!.sent, 1);
  await e.stop();
  assert.ok(f.conns.every((c) => c.closed));
});

test("joins transcription pieces into one utterance after the voice ends", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["system"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  const sys = f.conns[0]!;
  f.voice("system", true, 1000);
  sys.cb.onTranscription("在庫が");
  sys.cb.onTranscription("足りない");
  f.voice("system", false, 2500);
  await sleep(5);
  sys.cb.onTranscription("ときは保留");
  await sleep(40);
  assert.deepEqual(r.seen, ["voice system true 1000", "voice system false 2500", "pending system 2500", "text system 在庫が足りないときは保留 1000-2500"]);
  await e.stop();
});

test("goAway reconnects with the resumption handle and resends buffered audio", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["mic"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  const first = f.conns[0]!;
  first.cb.onResumptionHandle("h1");
  first.cb.onGoAway();
  e.write("mic", Buffer.alloc(320), 100);
  e.write("mic", Buffer.alloc(320), 120);
  await sleep(10);
  const second = f.conns[1]!;
  assert.equal(second.handle, "h1");
  assert.equal(second.sent, 2, "audio written during the reconnect is sent after it");
  assert.equal(first.closed, true);
  await e.stop();
});

test("an unexpected close also reconnects", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["mic"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  f.conns[0]!.cb.onResumptionHandle("h9");
  f.conns[0]!.cb.onClose(1011, "internal");
  await sleep(10);
  assert.equal(f.conns[1]?.handle, "h9");
  await e.stop();
});

test("an auth failure rejects and names GEMINI_API_KEY", async () => {
  const f = fakes({ failAuth: true }); const r = record();
  await assert.rejects(createGeminiLive({ apiKey: "bad", model: "m", language: "ja", sides: ["mic"], connect: f.connect, vad: f.vad }, r.cb), /GEMINI_API_KEY/);
});

test("real Gemini Live transcribes the synthetic fixture", { skip: !process.env.GEMINI_API_KEY || process.env.MEETING_VOICE_REAL_GEMINI !== "1" ? "set GEMINI_API_KEY and MEETING_VOICE_REAL_GEMINI=1" : false }, async () => {
  const { synthesize } = await import("./helpers/real-model.ts");
  const r = record();
  const voice = fakes();
  const e = await createGeminiLive({ apiKey: process.env.GEMINI_API_KEY!, model: process.env.MEETING_VOICE_GEMINI_MODEL ?? "gemini-3.8-live", language: "ja", sides: ["mic"], vad: voice.vad, quietMs: 1200 }, r.cb);
  const pcm = synthesize("注文を保留にします。");
  voice.voice("mic", true, 0);
  for (let off = 0, t = 0; off < pcm.length; off += 3200, t += 100) { e.write("mic", pcm.subarray(off, off + 3200), t); await sleep(100); }
  voice.voice("mic", false, 3000);
  for (let i = 0; i < 30; i++) { e.write("mic", Buffer.alloc(3200), 4000 + i * 100); await sleep(100); }
  await sleep(4000);
  await e.stop();
  assert.ok(r.seen.some((s) => s.startsWith("text mic") && s.includes("保留")), r.seen.join("|"));
});

test("F1: text arriving after the quiet timer is still emitted with the utterance times", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["mic"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  f.voice("mic", true, 1000);
  f.voice("mic", false, 2000);
  await sleep(40);
  f.conns[0]!.cb.onTranscription("遅れて届いた文字");
  await sleep(40);
  assert.ok(r.seen.includes("text mic 遅れて届いた文字 1000-2000"), r.seen.join("|"));
  await e.stop();
});

test("F1: a fragment after a partial emission becomes its own utterance; stop flushes pending text", async () => {
  const f = fakes(); const r = record();
  const e = await createGeminiLive({ apiKey: "k", model: "m", language: "ja", sides: ["mic"], connect: f.connect, vad: f.vad, quietMs: 20 }, r.cb);
  f.voice("mic", true, 0); f.voice("mic", false, 500);
  f.conns[0]!.cb.onTranscription("前半");
  await sleep(40);
  f.conns[0]!.cb.onTranscription("後半");
  await e.stop();
  assert.deepEqual(r.seen.filter((s) => s.startsWith("text")), ["text mic 前半 0-500", "text mic 後半 0-500"]);
});
