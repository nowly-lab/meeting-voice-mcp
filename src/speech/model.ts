// Parakeet TDT-CTC 0.6B Japanese int8 (CC-BY-4.0, converted by sherpa-onnx) and Silero VAD.
// The same pinned files as ai-silent-meeting-bot; each is used only after its size and SHA-256 match.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type ModelFile = { name: string; url: string; bytes: number; sha256: string };
const REVISION = "bef18eb066808c90bd0f5df5be685767b0732de8";
const BASE = `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/${REVISION}`;
export const PARAKEET_FILES: readonly ModelFile[] = [
  { name: "model.int8.onnx", url: `${BASE}/model.int8.onnx`, bytes: 655542604, sha256: "3addd00ef5bd1742078389e540b77394e4a508bdf2f4c9ad1b4a76d93e76598e" },
  { name: "tokens.txt", url: `${BASE}/tokens.txt`, bytes: 28557, sha256: "732f64c53909f2620c713f4106b487d92e6f54a6915b3cd3d1dbd32f9f4f392a" },
  { name: "silero_vad.onnx", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", bytes: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" },
];
export const PARAKEET_DIRECTORY = "parakeet-tdt-ctc-0.6b-ja-int8";
const MARKER = "verified.json";
const MAX_REDIRECTS = 5;
const MarkerSchema = z.array(z.object({ name: z.string(), bytes: z.number(), sha256: z.string() })).max(16);

export class ModelError extends Error {}

export function modelReady(dir: string, files: readonly ModelFile[] = PARAKEET_FILES): boolean {
  try {
    const marker = MarkerSchema.parse(JSON.parse(readFileSync(join(dir, MARKER), "utf8")));
    return files.every((f) => {
      const e = marker.find((m) => m.name === f.name);
      if (!e || e.bytes !== f.bytes || e.sha256 !== f.sha256) return false;
      const st = lstatSync(join(dir, f.name), { throwIfNoEntry: false });
      return !!st?.isFile() && st.size === f.bytes;
    });
  } catch {
    return false;
  }
}

async function open(url: string, fetcher: typeof fetch) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (new URL(current).protocol !== "https:") throw new ModelError("モデルの取得先を確認できません。");
    let res: Response;
    try {
      res = await fetcher(current, { redirect: "manual" });
    } catch {
      throw new ModelError("モデルをダウンロードできません。ネットワークを確認してください。");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new ModelError("モデルの取得先を確認できません。");
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new ModelError(`モデルをダウンロードできません（HTTP ${res.status}）。`);
    return res.body;
  }
  throw new ModelError("モデルの取得先を確認できません。");
}

async function download(file: ModelFile, dir: string, fetcher: typeof fetch, onBytes: (n: number) => void) {
  const target = join(dir, file.name);
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  const body = await open(file.url, fetcher);
  const hash = createHash("sha256");
  let size = 0;
  let fd: number | null = openSync(partial, "wx", 0o600);
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > file.bytes) throw new ModelError("ダウンロードしたモデルを確認できません。");
      hash.update(chunk);
      writeSync(fd, chunk);
      onBytes(chunk.byteLength);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (size !== file.bytes || hash.digest("hex") !== file.sha256) throw new ModelError("ダウンロードしたモデルを確認できません。");
    renameSync(partial, target);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(partial, { force: true });
    throw error instanceof ModelError ? error : new ModelError("モデルをダウンロードできません。ネットワークを確認してください。");
  }
}

export async function ensureParakeetModel(
  dataDir: string,
  opts: { files?: readonly ModelFile[]; directory?: string; fetch?: typeof fetch; onProgress?: (received: number, total: number) => void } = {},
): Promise<string> {
  const files = opts.files ?? PARAKEET_FILES;
  const dir = join(dataDir, "models", opts.directory ?? PARAKEET_DIRECTORY);
  if (modelReady(dir, files)) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(join(dir, MARKER), { force: true });
  const total = files.reduce((s, f) => s + f.bytes, 0);
  let received = 0;
  try {
    for (const f of files) await download(f, dir, opts.fetch ?? fetch, (n) => opts.onProgress?.((received += n), total));
  } catch (error) {
    for (const f of files) rmSync(join(dir, f.name), { force: true });
    throw error;
  }
  writeFileSync(join(dir, MARKER), JSON.stringify(files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))), { mode: 0o600 });
  return dir;
}

export const SILERO_FILES: readonly ModelFile[] = PARAKEET_FILES.filter((f) => f.name === "silero_vad.onnx");
export const SILERO_DIRECTORY = "silero-vad";
export const parakeetDir = (dataDir: string) => join(dataDir, "models", PARAKEET_DIRECTORY);
