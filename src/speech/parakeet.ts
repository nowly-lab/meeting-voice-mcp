// Parakeet engine: forwards PCM to the worker thread and its results to the callbacks.
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Side } from "../store/store.ts";
import type { SpeechCallbacks, SpeechEngine } from "./types.ts";

type WorkerLike = { on(event: "message" | "error" | "exit", fn: (m: never) => void): void; postMessage(m: unknown, transfer?: ArrayBuffer[]): void; terminate(): Promise<number> };
const workerFile = new URL(`./parakeet-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

export function createParakeet(modelDir: string, cb: SpeechCallbacks, opts: { spawnWorker?: () => WorkerLike } = {}): SpeechEngine {
  const worker = opts.spawnWorker ? opts.spawnWorker() : (new Worker(workerFile, { workerData: { modelDir } }) as unknown as WorkerLike);
  let finished: (() => void) | null = null;
  let stopped = false;
  worker.on("message", (m: { type: string; side: Side; active: boolean; atMs: number; text: string; startMs: number; endMs: number; message: string }) => {
    if (m.type === "voice") cb.voice(m.side, m.active, m.atMs);
    else if (m.type === "segment") cb.text({ side: m.side, text: m.text, startMs: m.startMs, endMs: m.endMs });
    else if (m.type === "error") cb.error(`文字起こし（Parakeet）でエラー: ${m.message}`);
    else if (m.type === "finished") finished?.();
  });
  worker.on("error", (e: Error) => cb.error(`文字起こし（Parakeet）が止まりました: ${e.message}`));
  worker.on("exit", () => finished?.());
  return {
    write(side, pcm, atMs) {
      if (stopped) return;
      const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      worker.postMessage({ type: "pcm", side, atMs, pcm: copy }, [copy]);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const done = new Promise<void>((r) => (finished = r));
      worker.postMessage({ type: "stop" });
      await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))]);
      await worker.terminate();
    },
  };
}
