import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createSoniox, defaultConnect, type SonioxConnect } from "../src/speech/soniox.ts";
import type { VadFactory } from "../src/speech/gemini-live.ts";
import type { Side } from "../src/store/store.ts";

type Conn = { side: Side; sent: number; finished: boolean; closed: boolean; keepalives: number; cb: Parameters<SonioxConnect>[1] };
function fakes(o: { delayMs?: number; delayFrom?: number; failFrom?: number } = {}) {
  const conns: Conn[] = [];
  let calls = 0;
  const connect: SonioxConnect = async (side, cb) => {
    calls++;
    if (o.failFrom !== undefined && calls > o.failFrom) throw Error("Unexpected server response: 503");
    if (o.delayMs && calls > (o.delayFrom ?? 0)) await sleep(o.delayMs);
    const c: Conn = { side, sent: 0, finished: false, closed: false, keepalives: 0, cb };
    conns.push(c);
    return { sendAudio: () => void c.sent++, finish: () => void (c.finished = true), keepalive: () => void c.keepalives++, close: () => void (c.closed = true) };
  };
  let vadCb: Parameters<VadFactory>[0] | null = null;
  const vad: VadFactory = (cb) => { vadCb = cb; return { write: () => {}, stop: async () => {} }; };
  return { conns, connect, vad, calls: () => calls, voice: (side: Side, active: boolean, atMs: number) => vadCb!.voice(side, active, atMs) };
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
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1 }), r.cb);
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
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1 }), r.cb);
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

test("times stay on the recording timeline when the audio sent has holes", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["system"]), r.cb);
  const c = f.conns[0]!;
  for (let t = 0; t < 1000; t += 100) e.write("system", Buffer.alloc(3200), t); // 0–1000 ms sent
  for (let t = 1500; t < 2500; t += 100) e.write("system", Buffer.alloc(3200), t); // Mac audio resumed at 1500 ms
  // Soniox counts only what it received: 1000–1500 ms of its time is recording time 1500–2000 ms.
  c.cb.onMessage(msg({ tokens: [{ text: "再開", start_ms: 1000, end_ms: 1500, is_final: true }, { text: "<end>", is_final: true }] }));
  c.cb.onMessage(msg({ tokens: [{ text: "前", start_ms: 200, end_ms: 400, is_final: true }, { text: "<end>", is_final: true }] }));
  c.cb.onMessage(msg({ tokens: [{ text: "またぐ", start_ms: 900, end_ms: 1100, is_final: true }, { text: "<end>", is_final: true }] }));
  assert.deepEqual(texts(r.seen), ["text system 再開 1500-2000", "text system 前 200-400", "text system またぐ 900-1600"]);
  await e.stop();
});

test("repeated retryable errors back off and are reported, and the side keeps retrying", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1, retryMaxMs: 4 }), r.cb);
  for (let i = 0; i < 8; i++) {
    f.conns.at(-1)!.cb.onMessage(msg({ error_code: 503, error_type: "service_unavailable" }));
    await sleep(20);
  }
  assert.equal(f.conns.length, 9, "one new connection per error, never a burst");
  const errors = r.seen.filter((s) => s.startsWith("error "));
  assert.equal(errors.length, 1, "reported once after several failures in a row");
  assert.match(errors[0]!, /Soniox/);
  await e.stop();
});

test("a burst of errors on one connection opens only one new connection", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1, retryMaxMs: 4 }), r.cb);
  const first = f.conns[0]!;
  first.cb.onMessage(msg({ error_code: 429, error_type: "rate_limit" }));
  first.cb.onClose(1011, "");
  await sleep(20);
  assert.equal(f.conns.length, 2);
  await e.stop();
});

test("when connecting keeps failing, the side keeps retrying instead of giving up", async () => {
  const f = fakes({ failFrom: 1 }); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1, retryMaxMs: 2 }), r.cb);
  f.conns[0]!.cb.onClose(1006, "");
  await sleep(60);
  assert.ok(f.calls() > 7, `still retrying after the 5th failure (${f.calls()} calls)`);
  assert.equal(r.seen.filter((s) => s.startsWith("error ")).length, 1);
  await e.stop();
  const after = f.calls();
  await sleep(20);
  assert.equal(f.calls(), after, "stop ends the retries");
});

test("a close with code 1000 during the meeting also reconnects", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1 }), r.cb);
  f.conns[0]!.cb.onClose(1000, "");
  await sleep(10);
  assert.equal(f.conns.length, 2);
  await e.stop();
});

test("stop during a reconnect closes the new connection and adds no text after stop", async () => {
  const f = fakes({ delayMs: 30, delayFrom: 1 }); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { retryBaseMs: 1 }), r.cb);
  f.conns[0]!.cb.onClose(1006, "");
  await sleep(5); // the second connection is still opening
  await e.stop();
  await sleep(50);
  assert.equal(f.conns.length, 2);
  assert.ok(f.conns.every((c) => c.closed), "no connection is left open");
  f.conns[1]!.cb.onMessage(msg({ tokens: [{ text: "後", start_ms: 0, end_ms: 10, is_final: true }, { text: "<end>", is_final: true }] }));
  assert.deepEqual(texts(r.seen), []);
});

test("stop does not wait for finished once the connection has closed", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic"], { finishWaitMs: 5000 }), r.cb);
  const c = f.conns[0]!;
  const started = Date.now();
  const stopping = e.stop();
  await sleep(5);
  c.cb.onClose(1006, "");
  await stopping;
  assert.ok(Date.now() - started < 1000);
});

test("a side with no audio gets keepalives so Soniox does not drop it", async () => {
  const f = fakes(); const r = record();
  const e = await createSoniox(opts(f, ["mic", "system"], { keepaliveMs: 10 }), r.cb);
  const mic = f.conns.find((c) => c.side === "mic")!;
  const system = f.conns.find((c) => c.side === "system")!;
  for (let i = 0; i < 6; i++) { e.write("mic", Buffer.alloc(320), i * 10); await sleep(5); }
  await sleep(30);
  assert.ok(system.keepalives >= 2, `system keepalives ${system.keepalives}`);
  assert.equal(mic.keepalives <= 3, true);
  await e.stop();
});

async function localSoniox(opts: { reject?: number } = {}) {
  const seen: { auth?: string; frames: { text: boolean; data: string; bytes: number }[] } = { frames: [] };
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => { seen.auth = info.req.headers.authorization; opts.reject ? done(false, opts.reject) : done(true); },
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      const buf = data as Buffer;
      seen.frames.push({ text: !isBinary, data: isBinary ? "" : buf.toString(), bytes: buf.length });
      if (!isBinary && buf.length === 0) {
        ws.send(JSON.stringify({ tokens: [{ text: "保留", start_ms: 0, end_ms: 300, is_final: true }, { text: "<end>", is_final: true }], finished: true }));
        ws.close(1000);
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { seen, url: `ws://127.0.0.1:${port}`, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

test("defaultConnect sends the key in the header, the config first, audio as binary and an empty text frame to finish", async () => {
  const server = await localSoniox();
  const r = record();
  const e = await createSoniox({ apiKey: "test-key", model: "stt-rt-v5", language: "ja", sides: ["mic"], connect: defaultConnect("test-key", "stt-rt-v5", "ja", server.url), vad: fakes().vad }, r.cb);
  e.write("mic", Buffer.alloc(3200), 2000);
  await sleep(50);
  await e.stop();
  assert.equal(server.seen.auth, "Bearer test-key");
  const [config, audio, finish] = server.seen.frames;
  assert.equal(config!.text, true);
  assert.deepEqual(JSON.parse(config!.data), { model: "stt-rt-v5", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, language_hints: ["ja"], enable_endpoint_detection: true });
  assert.deepEqual([audio!.text, audio!.bytes], [false, 3200]);
  assert.deepEqual([finish!.text, finish!.bytes], [true, 0]);
  assert.deepEqual(texts(r.seen), ["text mic 保留 2000-2300"]);
  await server.close();
});

test("defaultConnect: a refused handshake rejects and names SONIOX_API_KEY", async () => {
  const server = await localSoniox({ reject: 401 });
  await assert.rejects(createSoniox({ apiKey: "bad", model: "m", language: "ja", sides: ["mic"], connect: defaultConnect("bad", "m", "ja", server.url), vad: fakes().vad }, record().cb), /SONIOX_API_KEY.*401/);
  await server.close();
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
