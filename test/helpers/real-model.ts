// Real-model check: synthesizes Japanese speech with macOS `say` (no real person's voice), converts it to
// 16 kHz mono, and runs it through the Parakeet worker logic. Model dir: MEETING_VOICE_MODEL_DIR or the data folder.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRecognizer } from "../../src/speech/parakeet-worker.ts";
import { createSideProcessor } from "../../src/speech/side-processor.ts";
import { pcmToFloat } from "../../src/speech/types.ts";

export function synthesize(text: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "mv-say-"));
  execFileSync("say", ["-v", "Kyoko", "-o", join(dir, "a.aiff"), text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(dir, "a.aiff"), join(dir, "a.wav")]);
  const wav = readFileSync(join(dir, "a.wav"));
  const data = wav.indexOf(Buffer.from("data"));
  return Buffer.concat([Buffer.alloc(16000), wav.subarray(data + 8), Buffer.alloc(32000)]);
}

export async function runRealModelCheck(): Promise<string> {
  const modelDir = process.env.MEETING_VOICE_MODEL_DIR ?? join(homedir(), ".meeting-voice-mcp", "models", "parakeet-tdt-ctc-0.6b-ja-int8");
  const { recognize, newVad } = createRecognizer(modelDir);
  const p = createSideProcessor({ vad: newVad(), recognize });
  const pcm = synthesize("在庫が足りないときは、注文を保留にします。");
  const texts: string[] = [];
  for (let off = 0, t = 0; off < pcm.length; off += 3200, t += 100) texts.push(...p.accept(pcmToFloat(pcm.subarray(off, off + 3200)), t).segments.map((s) => s.text));
  texts.push(...p.flush().segments.map((s) => s.text));
  return texts.join(" ");
}
