// Demo server for live-and-history.yaml. The real server, recorder, segmenter, delivery queue and page run
// unchanged; only audio capture and speech recognition are replaced by a script of fixed Japanese lines
// (no microphone, no Mac audio, no real voice). It also plays the agent: it starts the recording over
// /mcp as session "demo" once <out>/ready exists, acks each delivered segment as the plugin would, and
// stops the recording at the end.
// Usage: node .maestro/demo/demo-server.ts <dataDir> <out>   → prints the page URL, then waits for <out>/ready
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../src/server.ts";
import type { CaptureFn, EngineFactory } from "../../src/meeting/recorder.ts";
import type { SpeechCallbacks } from "../../src/speech/types.ts";

const [dataDir, out] = process.argv.slice(2) as [string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let speech: SpeechCallbacks | null = null;
let t0 = 0;
const engines: EngineFactory = async (_k, _s, cb) => { speech = cb; return { write: () => {}, stop: async () => {} }; };
const capture: CaptureFn = async (sources, on) => { on.event({ event: "ready", sources }); t0 = Date.now(); return { stop: async () => {}, exited: () => true }; };
const s = await startServer({ dataDir, env: {}, capture, engines, openUrl: () => {} });
console.log(s.url);

const now = () => Date.now() - t0;
async function say(side: "mic" | "system", text: string, ms: number) {
  const start = now();
  speech!.voice(side, true, start);
  await sleep(ms);
  speech!.voice(side, false, now());
  speech!.text({ side, text, startMs: start, endMs: now() });
  await sleep(700);
}
async function tool(name: string, args: object) {
  await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${s.token}`, "x-meeting-voice-session": "demo" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
}
async function deliverOne() {
  const d = await s.bridge.poll("demo", 15_000, new AbortController().signal);
  if (d) { await sleep(900); s.bridge.ack(d.id); }
}

while (!existsSync(join(out, "ready"))) await sleep(200);
await sleep(11_000);
await tool("start_recording", { title: "注文フローの整理", instructions: "届いた区切りから event-storming-mcp の全体像を直す" });
await sleep(1500);
await say("mic", "注文が確定したら、在庫を引き当てます。", 2200);
await say("system", "在庫が足りないときは、注文を保留にしましょう。", 2600);
await deliverOne();
await sleep(800);
await say("mic", "決済が完了したら、発送の準備に進みます。", 2400);
await say("system", "キャンセルされたら、引き当てた在庫を戻します。", 2400);
await deliverOne();
await sleep(2500);
await tool("stop_recording", {});
await sleep(60_000);
await s.close();
process.exit(0);
