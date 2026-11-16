#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.ts";

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

export async function main(argv: string[], env: Env, io: IO): Promise<number> {
  const [command] = argv;
  if (command === "--version" || command === "-v") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    io.out(USAGE);
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
