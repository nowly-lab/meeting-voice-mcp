import { test } from "node:test";
import assert from "node:assert/strict";
import { createSoniox, type SonioxConnect } from "../src/speech/soniox.ts";
import type { VadFactory } from "../src/speech/gemini-live.ts";
import type { Side } from "../src/store/store.ts";

type Conn = { side: Side; sent: number; finished: boolean; closed: boolean; cb: Parameters<SonioxConnect>[1] };
function fakes() {
  const conns: Conn[] = [];
  const connect: SonioxConnect = async (side, cb) => {
    const c: Conn = { side, sent: 0, finished: false, closed: false, cb };
    conns.push(c);
    return { sendAudio: () => void c.sent++, finish: () => void (c.finished = true), close: () => void (c.closed = true) };
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
const msg = (o: unknown) => JSON.stringify(o);
const texts = (seen: string[]) => seen.filter((s) => s.startsWith("text ") || s.startsWith("error "));
const opts = (f: ReturnType<typeof fakes>, sides: Side[], extra: object = {}) => ({ apiKey: "k", model: "stt-rt-v5", language: "ja", sides, connect: f.connect, vad: f.vad, ...extra });

test("opens one connection per side", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic", "system"]), r.cb);
  assert.deepEqual(f.conns.map((c) => c.side).sort(), ["mic", "system"]);
  e.write("mic", Buffer.alloc(320), 0);
  assert.equal(f.conns.find((c) => c.side === "mic")!.sent, 1);
  assert.equal(f.conns.find((c) => c.side === "system")!.sent, 0);
  await e.stop();
  assert.ok(f.conns.every((c) => c.closed));
});

test("joins final tokens into one utterance at <end>, on the recording timeline", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["system"]), r.cb);
  const c = f.conns[0]!;
  e.write("system", Buffer.alloc(3200), 1000);
  c.cb.onMessage(msg({ tokens: [{ text: "在庫が", start_ms: 0, end_ms: 600, is_final: true }, { text: "足り", start_ms: 600, end_ms: 900, is_final: false }] }));
  assert.deepEqual(texts(r.seen), [], "nothing before <end>; non-final tokens never count");
  c.cb.onMessage(msg({ tokens: [{ text: "足りない", start_ms: 600, end_ms: 1400, is_final: true }, { text: "<end>", is_final: true }] }));
  assert.deepEqual(texts(r.seen), ["text system 在庫が足りない 1000-2400"]);
  await e.stop();
  assert.deepEqual(texts(r.seen), ["text system 在庫が足りない 1000-2400"], "stop does not repeat it");
});

test("voice and pending come from the local VAD", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  f.voice("mic", true, 100);
  f.voice("mic", false, 900);
  assert.deepEqual(r.seen, ["voice mic true 100", "voice mic false 900", "pending mic 900"]);
  await e.stop();
});

test("reconnect keeps times on the recording timeline and resends buffered audio", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  e.write("mic", Buffer.alloc(320), 0);
  f.conns[0]!.cb.onClose(1006, "");
  e.write("mic", Buffer.alloc(320), 5000);
  e.write("mic", Buffer.alloc(320), 5010);
  await sleep(10);
  const second = f.conns[1]!;
  assert.equal(second.sent, 2, "audio written during the reconnect is sent after it");
  assert.equal(f.conns[0]!.closed, true);
  second.cb.onMessage(msg({ tokens: [{ text: "決済", start_ms: 100, end_ms: 500, is_final: true }, { text: "<end>", is_final: true }] }));
  assert.deepEqual(texts(r.seen), ["text mic 決済 5100-5500"]);
  f.conns[0]!.cb.onMessage(msg({ tokens: [{ text: "古い", start_ms: 0, end_ms: 10, is_final: true }, { text: "<end>", is_final: true }] }));
  assert.deepEqual(texts(r.seen), ["text mic 決済 5100-5500"], "messages from a replaced connection are ignored");
  await e.stop();
});

test("a session limit error reconnects", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  f.conns[0]!.cb.onMessage(msg({ error_code: 413, error_type: "session_duration_exceeded", error_message: "Maximum session duration reached" }));
  await sleep(10);
  assert.equal(f.conns.length, 2);
  assert.deepEqual(texts(r.seen), []);
  await e.stop();
});

test("auth errors stop without retrying and name SONIOX_API_KEY", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  f.conns[0]!.cb.onMessage(msg({ error_code: 401, error_type: "unauthenticated", error_message: "Invalid API key" }));
  f.conns[0]!.cb.onClose(1008, "");
  await sleep(20);
  assert.equal(f.conns.length, 1);
  assert.equal(r.seen.filter((s) => s.startsWith("error ")).length, 1);
  assert.match(r.seen.find((s) => s.startsWith("error "))!, /SONIOX_API_KEY/);
  await e.stop();
});

test("an exhausted balance says so", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  f.conns[0]!.cb.onMessage(msg({ error_code: 402, error_type: "payment_required" }));
  assert.match(r.seen.find((s) => s.startsWith("error "))!, /残高/);
  await e.stop();
});

test("a malformed message is reported as an error", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"]), r.cb);
  f.conns[0]!.cb.onMessage("not json");
  assert.match(r.seen.find((s) => s.startsWith("error "))!, /Soniox/);
  await e.stop();
});

test("a failed first connection rejects and names SONIOX_API_KEY", async () => {
  const r = record();
  const connect: SonioxConnect = async () => { throw Error("Unexpected server response: 401"); };
  await assert.rejects(createSoniox({ apiKey: "bad", model: "m", language: "ja", sides: ["mic"], connect, vad: fakes().vad }, r.cb), /SONIOX_API_KEY/);
});

test("stop flushes final tokens after the server finishes", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { finishWaitMs: 2000 }), r.cb);
  const c = f.conns[0]!;
  e.write("mic", Buffer.alloc(320), 300);
  c.cb.onMessage(msg({ tokens: [{ text: "言いかけ", start_ms: 0, end_ms: 400, is_final: true }] }));
  const stopping = e.stop();
  await sleep(5);
  assert.equal(c.finished, true);
  c.cb.onMessage(msg({ tokens: [{ text: "の文", start_ms: 400, end_ms: 700, is_final: true }], finished: true }));
  await stopping;
  assert.deepEqual(texts(r.seen), ["text mic 言いかけの文 300-1000"]);
  assert.equal(c.closed, true);
});

test("stop does not wait forever for finished", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { finishWaitMs: 30 }), r.cb);
  e.write("mic", Buffer.alloc(320), 0);
  f.conns[0]!.cb.onMessage(msg({ tokens: [{ text: "途中", start_ms: 0, end_ms: 200, is_final: true }] }));
  await e.stop();
  assert.deepEqual(texts(r.seen), ["text mic 途中 0-200"]);
});

test("real Soniox transcribes the synthetic fixture", { skip: !process.env.SONIOX_API_KEY || process.env.MEETING_VOICE_REAL_SONIOX !== "1" ? "set SONIOX_API_KEY and MEETING_VOICE_REAL_SONIOX=1" : false }, async () => {
  const { synthesize } = await import("./helpers/real-model.ts");
  const r = record();
  const voice = fakes();
  const e = await createSoniox({ apiKey: process.env.SONIOX_API_KEY!, model: process.env.MEETING_VOICE_SONIOX_MODEL ?? "stt-rt-v5", language: "ja", sides: ["mic"], vad: voice.vad }, r.cb);
  const pcm = synthesize("注文を保留にします。");
  for (let off = 0, t = 0; off < pcm.length; off += 3200, t += 100) { e.write("mic", pcm.subarray(off, off + 3200), t); await sleep(100); }
  for (let i = 0; i < 40; i++) { e.write("mic", Buffer.alloc(3200), 4000 + i * 100); await sleep(100); }
  await e.stop();
  assert.ok(r.seen.some((s) => s.startsWith("text mic") && s.includes("保留")), r.seen.join("|"));
});
