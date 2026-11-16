// Builds the Swift capture helper into the data folder the first time, and again only when its sources change.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const NATIVE_SOURCES = ["AudioCapture.swift", "CaptureAdmission.swift", "InputDevices.swift"].map((f) =>
  fileURLToPath(new URL(`../../native/${f}`, import.meta.url)),
);

export type Compile = (sources: string[], output: string) => Promise<void>;

export const swiftc: Compile = async (sources, output) => {
  await run("xcrun", ["swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-target", "arm64-apple-macosx14.6", ...sources,
    "-o", output, "-framework", "AVFoundation", "-framework", "CoreAudio"], { maxBuffer: 16 * 1024 * 1024 });
};

export async function ensureCaptureBinary(dataDir: string, compile: Compile = swiftc, sources: string[] = NATIVE_SOURCES): Promise<string> {
  const hash = createHash("sha256");
  for (const s of sources) hash.update(readFileSync(s));
  const bin = join(dataDir, "bin");
  const target = join(bin, `meeting-voice-capture-${hash.digest("hex").slice(0, 12)}`);
  if (existsSync(target)) return target;
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await compile(sources, tmp);
  } catch (error) {
    throw Error(`Building the capture helper failed. Install the Xcode command line tools (xcode-select --install). ${error instanceof Error ? error.message.slice(0, 500) : ""}`);
  }
  renameSync(tmp, target);
  return target;
}
