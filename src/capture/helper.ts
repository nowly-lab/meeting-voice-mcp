// Runs the capture helper and turns its JSON lines into events and PCM per side.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { Side } from "../store/store.ts";

const LineSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ready"), sources: z.array(z.enum(["mic", "system"])) }),
  z.object({ event: z.literal("audio"), source: z.enum(["mic", "system"]), timestampMs: z.number(), pcm: z.string() }),
  z.object({ event: z.literal("denied"), side: z.enum(["mic", "system"]), message: z.string() }),
  z.object({ event: z.literal("error"), message: z.string() }),
  z.object({ event: z.literal("stopped") }),
]);
export type CaptureEvent =
  | { event: "ready"; sources: Side[] }
  | { event: "denied"; side: Side; message: string }
  | { event: "error"; message: string }
  | { event: "stopped" };

export type CaptureHandle = { stop(): Promise<void>; exited(): boolean };
export type StartCapture = typeof startCapture;

const MAX_LINE = 1024 * 1024;

export function startCapture(
  binary: string,
  sources: Side[],
  on: { event(e: CaptureEvent): void; pcm(side: Side, chunk: Buffer): void },
): Promise<CaptureHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--capture", sources.join(",")], { stdio: ["pipe", "pipe", "pipe"] });
    let ready = false;
    let exited = false;
    let lastError = "";
    const closed = new Promise<void>((r) => child.on("close", () => { exited = true; r(); }));
    const handle: CaptureHandle = {
      async stop() {
        if (!exited) {
          child.stdin.write('{"command":"stop"}\n');
          child.stdin.end();
          const t = setTimeout(() => child.kill("SIGKILL"), 5000);
          await closed;
          clearTimeout(t);
        }
      },
      exited: () => exited,
    };
    child.stderr.on("data", () => {});
    child.on("error", (e) => { if (!ready) reject(e); });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line.length > MAX_LINE) return;
      let parsed;
      try { parsed = LineSchema.safeParse(JSON.parse(line)); } catch { return; }
      if (!parsed.success) return;
      const e = parsed.data;
      if (e.event === "audio") return on.pcm(e.source, Buffer.from(e.pcm, "base64"));
      if (e.event === "error") lastError = e.message;
      if (e.event === "ready") { ready = true; on.event(e); return resolve(handle); }
      on.event(e);
    });
    void closed.then(() => {
      if (!ready) reject(Error(lastError || "The capture helper exited before it was ready."));
      else on.event({ event: "stopped" });
    });
  });
}
