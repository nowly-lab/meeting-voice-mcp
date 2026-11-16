#!/usr/bin/env node
// Speaks the capture helper protocol for tests. FAKE_CAPTURE_MODE: "ok" | "deny-system" | "fail".
import { createInterface } from "node:readline";
const mode = process.env.FAKE_CAPTURE_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sources = process.argv[3].split(",");
if (mode === "fail") { out({ event: "error", message: "No audio source could start." }); process.exit(1); }
const running = mode === "deny-system" ? sources.filter((s) => s !== "system") : sources;
if (mode === "deny-system") out({ event: "denied", side: "system", message: "Create system audio tap failed" });
out({ event: "ready", sources: running });
const pcm = Buffer.alloc(3200, 1).toString("base64");
let t = 0;
const timer = setInterval(() => { for (const s of running) out({ event: "audio", source: s, timestampMs: t, pcm }); t += 100; }, 10);
createInterface({ input: process.stdin }).on("line", (l) => { if (l.includes("stop")) stop(); }).on("close", stop);
function stop() { clearInterval(timer); out({ event: "stopped" }); process.exit(0); }
