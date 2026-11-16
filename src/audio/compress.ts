// After a meeting stops, its WAV files become AAC (.m4a) with macOS afconvert. The WAV is removed only
// after the m4a exists and afinfo can read it.
import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function compressAudio(wav: string, m4a: string): Promise<void> {
  const tmp = `${m4a}.partial.m4a`;
  try {
    await run("afconvert", ["-f", "m4af", "-d", "aac", wav, tmp]);
    await run("afinfo", [tmp]);
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw Error("empty m4a");
    await run("mv", ["-f", tmp, m4a]);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw Error(`音声の圧縮に失敗しました。WAV は残しています: ${error instanceof Error ? error.message.slice(0, 200) : ""}`);
  }
  rmSync(wav, { force: true });
}
