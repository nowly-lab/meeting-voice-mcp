import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, sealSegment } from "../src/segment/segmenter.ts";
import type { Utterance } from "../src/store/store.ts";

let n = 0;
const u = (side: "mic" | "system", startMs: number, text: string): Utterance => ({ seq: ++n, id: `u${n}`, side, startMs, endMs: startMs + 400, text });
function make(opts: Partial<{ silenceMs: number; forceMs: number; transcriptWaitMs: number }> = {}) {
  const sealed: { segment: number; utterances: Utterance[]; forced: boolean }[] = [];
  const s = new Segmenter({ silenceMs: 3000, forceMs: 60000, transcriptWaitMs: 0, ...opts }, (x) => sealed.push(x));
  return { s, sealed };
}

test("seals after both sides are silent for silenceMs", () => {
  const { s, sealed } = make();
  s.voice("mic", true, 0); s.utterance(u("mic", 0, "注文が確定したら")); s.voice("mic", false, 1000);
  s.voice("system", true, 1200); s.utterance(u("system", 1200, "在庫を引き当てる")); s.voice("system", false, 2000);
  s.tick(4999);
  assert.equal(sealed.length, 0);
  s.tick(5000);
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0]!.segment, 1);
  assert.equal(sealed[0]!.utterances.length, 2);
  assert.equal(sealed[0]!.forced, false);
});

test("does not seal while one side is still talking", () => {
  const { s, sealed } = make();
  s.voice("mic", true, 0); s.utterance(u("mic", 0, "あ")); s.voice("mic", false, 500);
  s.voice("system", true, 600);
  s.tick(10000);
  assert.equal(sealed.length, 0);
});

test("does not seal silence with no utterances", () => {
  const { s, sealed } = make();
  s.voice("mic", true, 0); s.voice("mic", false, 100);
  s.tick(10000);
  assert.equal(sealed.length, 0);
});

test("forces a segment after forceMs of talking", () => {
  const { s, sealed } = make();
  s.voice("mic", true, 0); s.utterance(u("mic", 0, "長い話"));
  s.tick(59999);
  assert.equal(sealed.length, 0);
  s.tick(60000);
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0]!.forced, true);
});

test("gemini waits for a pending transcript, up to transcriptWaitMs", () => {
  const { s, sealed } = make({ transcriptWaitMs: 5000 });
  s.voice("mic", true, 0); s.utterance(u("mic", 0, "一")); s.voice("mic", false, 1000);
  s.voice("system", true, 1100); s.pendingTranscript("system", 1500); s.voice("system", false, 1500);
  s.tick(4600);
  assert.equal(sealed.length, 0, "waits for the pending transcript");
  s.utterance(u("system", 1100, "二"));
  s.tick(4700);
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0]!.utterances.length, 2);
  const b = make({ transcriptWaitMs: 5000 });
  b.s.voice("mic", true, 0); b.s.utterance(u("mic", 0, "一")); b.s.voice("mic", false, 1000);
  b.s.pendingTranscript("system", 1000);
  b.s.tick(5999);
  assert.equal(b.sealed.length, 0);
  b.s.tick(6000);
  assert.equal(b.sealed.length, 1, "gives up waiting after 5 s");
});

test("removes the mic copy of speaker audio within 3 s", () => {
  const { s, sealed } = make();
  s.utterance(u("system", 1000, "在庫が足りないときは保留"));
  const echo = s.utterance(u("mic", 2500, "在庫が足りないときは、保留に"));
  assert.ok(echo?.echoOf, "marked as echo");
  const late = s.utterance(u("mic", 5000, "在庫が足りないときは保留"));
  assert.equal(late?.echoOf, undefined, "more than 3 s later is kept");
  s.flush(9000);
  assert.deepEqual(sealed[0]!.utterances.map((x) => x.side), ["system", "mic"]);
});

test("flush seals open utterances and numbers go up from 1", () => {
  const { s, sealed } = make();
  s.utterance(u("mic", 0, "一")); s.flush(100);
  s.utterance(u("mic", 200, "二")); s.flush(300);
  s.flush(400);
  assert.deepEqual(sealed.map((x) => x.segment), [1, 2]);
});

test("sealSegment keeps start order", () => {
  const r = sealSegment([u("mic", 2000, "b"), u("system", 1000, "a")], 7, false);
  assert.deepEqual(r.utterances.map((x) => x.text), ["a", "b"]);
  assert.equal(r.segment, 7);
});
