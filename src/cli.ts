#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureCaptureBinary } from "./capture/build.ts";
import { ensureServer, healthy, runStdio } from "./mcp/stdio.ts";
import { openInBrowser, startServer } from "./server.ts";
import { modelReady, parakeetDir } from "./speech/model.ts";
import { MeetingStore } from "./store/store.ts";
import { VERSION } from "./version.ts";

const run = promisify(execFile);

export const USAGE = `meeting-voice-mcp ${VERSION}
Record the meeting mic and Mac audio, transcribe them, and deliver silence-separated segments to Claude.

Usage:
  meeting-voice-mcp              start the local server (or open its page if it runs)
  meeting-voice-mcp mcp          MCP over stdio (starts the server in the background)
  meeting-voice-mcp status       show the server and recording state
  meeting-voice-mcp stop         stop the server
  meeting-voice-mcp doctor       check permissions, models and the Claude Code plugin
  meeting-voice-mcp install-plugin   show how to install the Claude Code plugin
  meeting-voice-mcp --version
`;

export type IO = { out: (s: string) => void; err: (s: string) => void };
export type Env = Record<string, string | undefined>;

export function dataDirFrom(env: Env): string {
  return env.MEETING_VOICE_MCP_DATA_DIR?.trim() || join(homedir(), ".meeting-voice-mcp");
}

export const PLUGIN_INSTRUCTIONS = `Claude Code プラグイン（区切りをセッションに自動で届ける）を入れるには、Claude Code の中で:
  /plugin marketplace add nowly-lab/meeting-voice-mcp
  /plugin install meeting-voice@meeting-voice-mcp
入れた後に Claude Code を起動し直すと meeting_voice ツールが使えます（Claude Code 2.1.287 以上、対話セッション）。
プラグインのないエージェントは MCP（stdio）を登録してください:
  claude mcp add meeting-voice -- npx -y github:nowly-lab/meeting-voice-mcp mcp
`;

async function control(dataDir: string, path: string, method = "POST") {
  const info = new MeetingStore(dataDir).readServerInfo();
  if (!(await healthy(info))) return null;
  const res = await fetch(`http://127.0.0.1:${info!.port}${path}`, { method, headers: { authorization: `Bearer ${info!.token}` } });
  return res.json() as Promise<Record<string, unknown>>;
}

export async function doctor(dataDir: string, env: Env, io: IO): Promise<number> {
  const lines: [boolean, string][] = [];
  const darwin = Number(release().split(".")[0]);
  lines.push([process.platform === "darwin" && darwin >= 23, `macOS 14.6 以上（Darwin ${release()}）`]);
  let binary: string | null = null;
  try {
    binary = await ensureCaptureBinary(dataDir);
    lines.push([true, "録音部品をビルドした"]);
  } catch (e) {
    lines.push([false, e instanceof Error ? e.message : String(e)]);
  }
  if (binary) {
    try {
      const { stdout } = await run(binary, ["--permissions"]);
      const mic = /"microphone":"(\w[\w-]*)"/.exec(stdout)?.[1] ?? "unknown";
      lines.push([mic === "authorized", `マイクの許可: ${mic}（ターミナルのアプリに付きます）`]);
    } catch {
      lines.push([false, "マイクの許可を確かめられません"]);
    }
  }
  lines.push([true, "Macの音の許可: 録音を始めたときに macOS が尋ねます（システム設定 > プライバシーとセキュリティ > 画面とシステムオーディオ録音）"]);
  lines.push([modelReady(parakeetDir(dataDir)), `Parakeet モデル: ${modelReady(parakeetDir(dataDir)) ? "ダウンロード済み" : "未ダウンロード（最初の start_recording で約 650 MB を取得）"}`]);
  lines.push([Boolean(env.GEMINI_API_KEY?.trim()), `GEMINI_API_KEY: ${env.GEMINI_API_KEY?.trim() ? "あり（無料枠のキーでは送った音声が Google に使われることがあります）" : "なし（Gemini は使えません。Parakeet は使えます）"}`]);
  try {
    const { stdout } = await run("claude", ["plugin", "list"], { timeout: 15000 });
    lines.push([/meeting-voice/.test(stdout), `Claude Code プラグイン: ${/meeting-voice/.test(stdout) ? "入っている" : "入っていない（meeting-voice-mcp install-plugin）"}`]);
  } catch {
    lines.push([false, "Claude Code プラグイン: claude コマンドが見つかりません"]);
  }
  lines.push([true, "ヘッドホンをすすめます（スピーカーの音をマイクが拾うと、近い発言を自分側から外します）"]);
  for (const [ok, text] of lines) io.out(`${ok ? "✓" : "✗"} ${text}\n`);
  return lines.every(([ok]) => ok) ? 0 : 1;
}

export async function main(argv: string[], env: Env, io: IO): Promise<number> {
  const [command] = argv;
  const dataDir = dataDirFrom(env);
  if (command === "--version" || command === "-v") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined || command === "serve") {
    const background = argv.includes("--background");
    const store = new MeetingStore(dataDir);
    const existing = store.readServerInfo();
    if (await healthy(existing)) {
      if (!background) {
        io.out(`meeting-voice-mcp は動いています: http://127.0.0.1:${existing!.port}/\n`);
        openInBrowser(env)(`http://127.0.0.1:${existing!.port}/`);
      }
      return 0;
    }
    let server;
    try {
      server = await startServer({ dataDir, env, open: !background && !argv.includes("--no-open") });
    } catch (error) {
      if ((error as { code?: string }).code === "ALREADY_RUNNING") {
        io.out("meeting-voice-mcp は別のプロセスで起動中です\n");
        return 0;
      }
      throw error;
    }
    io.out(`meeting-voice-mcp ${VERSION}: ${server.url}/ （止めるには Ctrl+C か meeting-voice-mcp stop）\n`);
    const shutdown = () => void server.close().finally(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  }
  if (command === "mcp") {
    await runStdio(dataDir);
    return await new Promise<number>(() => {});
  }
  if (command === "status") {
    const s = await control(dataDir, "/api/control/status");
    io.out(s ? `${JSON.stringify(s, null, 2)}\n` : "meeting-voice-mcp は動いていません\n");
    return s ? 0 : 1;
  }
  if (command === "stop") {
    const s = await control(dataDir, "/api/control/stop");
    io.out(s ? "止めました\n" : "meeting-voice-mcp は動いていません\n");
    return 0;
  }
  if (command === "doctor") return doctor(dataDir, env, io);
  if (command === "install-plugin") {
    io.out(PLUGIN_INSTRUCTIONS);
    return 0;
  }
  if (command === "ensure") {
    const info = await ensureServer(dataDir);
    io.out(`${JSON.stringify({ port: info.port })}\n`);
    return 0;
  }
  io.err(USAGE);
  return 2;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }).then(
    (code) => (process.exitCode = code),
  );
}
