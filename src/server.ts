// The one local server: MCP (/mcp), the plugin bridge (/api/bridge/*), the read-only page and its APIs.
// Listens on 127.0.0.1 only, checks Host, refuses Origin on /mcp and the bridge, and requires the token
// from server.json there. Page APIs need the per-page nonce and only read.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DeliveryBridge } from "./bridge/bridge.ts";
import { ensureCaptureBinary } from "./capture/build.ts";
import { startCapture } from "./capture/helper.ts";
import { Recorder, type CaptureFn, type EngineFactory, type LiveEvent } from "./meeting/recorder.ts";
import { createMcpServer } from "./mcp/tools.ts";
import { createGeminiLive, DEFAULT_GEMINI_MODEL } from "./speech/gemini-live.ts";
import { ensureParakeetModel, modelReady, parakeetDir, SILERO_DIRECTORY, SILERO_FILES } from "./speech/model.ts";
import { createParakeet } from "./speech/parakeet.ts";
import { MeetingStore } from "./store/store.ts";
import { VERSION } from "./version.ts";

export const SESSION_HEADER = "x-meeting-voice-session";
const MAX_BODY = 1024 * 1024;
const WEB_DIR = fileURLToPath(new URL("../web/dist/", import.meta.url));

type Env = Record<string, string | undefined>;
export type ServerOptions = {
  dataDir: string;
  port?: number;
  env?: Env;
  open?: boolean;
  capture?: CaptureFn;
  engines?: EngineFactory;
  openUrl?: (url: string) => void;
  recover?: boolean;
};
export type RunningServer = { url: string; port: number; token: string; store: MeetingStore; bridge: DeliveryBridge; recorder: Recorder; close(): Promise<void> };

type ModelProgress = { state: "missing" | "downloading" | "ready" | "error"; received: number; total: number; error?: string };

export function defaultEngines(dataDir: string, env: Env, progress: ModelProgress): EngineFactory {
  let download: Promise<string> | null = null;
  const startDownload = () => {
    download ??= ensureParakeetModel(dataDir, { onProgress: (r, t) => Object.assign(progress, { state: "downloading", received: r, total: t }) })
      .then((d) => { Object.assign(progress, { state: "ready" }); return d; })
      .catch((e) => { Object.assign(progress, { state: "error", error: e instanceof Error ? e.message : String(e) }); download = null; throw e; });
    download.catch(() => {});
  };
  return async (kind, sides, cb, language) => {
    if (kind === "gemini") {
      const apiKey = env.GEMINI_API_KEY?.trim();
      if (!apiKey) throw Error("GEMINI_API_KEY が設定されていません。サーバーを起動する環境に GEMINI_API_KEY を設定するか、engine: \"parakeet\" を使ってください。");
      const vadModelDir = await ensureParakeetModel(dataDir, { files: SILERO_FILES, directory: SILERO_DIRECTORY });
      return createGeminiLive({ apiKey, model: env.MEETING_VOICE_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL, language, sides, vadModelDir }, cb);
    }
    if (!modelReady(parakeetDir(dataDir))) {
      startDownload();
      const pct = progress.total ? Math.floor((progress.received / progress.total) * 100) : 0;
      throw Error(`文字起こしモデル（Parakeet、約 650 MB）をダウンロード中です（${pct}%）。終わってからもう一度 start_recording を呼んでください。recording_status か画面で進み具合を見られます。`);
    }
    return createParakeet(parakeetDir(dataDir), cb);
  };
}

export function defaultCapture(dataDir: string): CaptureFn {
  return async (sources, on) => startCapture(await ensureCaptureBinary(dataDir), sources, on);
}

export function openInBrowser(env: Env): (url: string) => void {
  return (url) => {
    if (env.MEETING_VOICE_BROWSER === "none") return;
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".m4a": "audio/mp4", ".wav": "audio/wav" };

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = statSync(file).size;
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "no-store" });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

const PAGE_FALLBACK = `<!doctype html><meta charset="utf-8"><title>meeting-voice-mcp</title><body><div id="app"></div><script>window.__NONCE__="%NONCE%"</script><script type="module" src="/assets/main.js"></script>`;

export class AlreadyRunning extends Error {
  readonly code = "ALREADY_RUNNING";
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One server per data folder: an exclusive lock file holding the owner's pid and a random id. */
export function acquireServerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "server.lock");
  const owner = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, owner }));
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).owner === owner) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = 0;
      try {
        holder = Number(JSON.parse(readFileSync(file, "utf8")).pid) || 0;
      } catch {
        holder = 0;
      }
      if (holder && alive(holder)) throw new AlreadyRunning(`meeting-voice-mcp is already running for this data folder (pid ${holder}).`);
      rmSync(file, { force: true });
    }
  }
  throw new AlreadyRunning("meeting-voice-mcp is already running for this data folder.");
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  // Taken before any await, so two starts in a race cannot both pass.
  const releaseLock = acquireServerLock(opts.dataDir);
  try {
    return await startLockedServer(opts, releaseLock);
  } catch (error) {
    releaseLock();
    throw error;
  }
}

async function startLockedServer(opts: ServerOptions, releaseLock: () => void): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const store = new MeetingStore(opts.dataDir);
  const bridge = new DeliveryBridge(store);
  const token = randomBytes(24).toString("hex");
  const nonces = new Set<string>();
  const sse = new Set<ServerResponse>();
  const progress: ModelProgress = { state: modelReady(parakeetDir(opts.dataDir)) ? "ready" : "missing", received: 0, total: 0 };
  const plugins = new Map<string, { idle: boolean; at: number }>();
  const broadcast = (e: LiveEvent | { type: string; [k: string]: unknown }) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const r of sse) r.write(line);
  };
  const recorder = new Recorder({
    store,
    bridge,
    capture: opts.capture ?? defaultCapture(opts.dataDir),
    engines: opts.engines ?? defaultEngines(opts.dataDir, env, progress),
    clock: Date.now,
    events: broadcast,
  });
  if (opts.recover !== false) await recorder.recoverInterrupted();
  const openUrl = opts.openUrl ?? openInBrowser(env);
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const pageUrl = (meetingId?: string) => (meetingId ? `${base()}/#history=${meetingId}` : `${base()}/`);

  const checkHost = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  const checkAgent = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin !== undefined) { send(res, 403, { error: "Origin is not allowed" }); return false; }
    if (req.headers.authorization !== `Bearer ${token}`) { send(res, 401, { error: "Missing or wrong token" }); return false; }
    return true;
  };
  const checkNonce = (req: IncomingMessage, url: URL, res: ServerResponse) => {
    const n = (req.headers["x-nonce"] as string | undefined) ?? url.searchParams.get("nonce") ?? "";
    if (!nonces.has(n)) { send(res, 403, { error: "Reload the page" }); return false; }
    return true;
  };

  const server = createServer(async (req, res) => {
    try {
      if (!checkHost(req)) return send(res, 421, { error: "Wrong host" });
      const url = new URL(req.url ?? "/", base());
      const path = url.pathname;

      if (path === "/mcp") {
        if (!checkAgent(req, res)) return;
        const session = (req.headers[SESSION_HEADER] as string | undefined)?.slice(0, 200) || null;
        const mcp = createMcpServer({ recorder, store, bridge, session, pageUrl, openUrl });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
        return;
      }

      if (path.startsWith("/api/bridge/") || path.startsWith("/api/control/")) {
        if (req.method !== "POST" && path !== "/api/control/health") return send(res, 405, { error: "POST only" });
        if (!checkAgent(req, res)) return;
        const body = req.method === "POST" ? await readBody(req) : {};
        if (path === "/api/control/health") return send(res, 200, { ok: true, version: VERSION, pid: process.pid });
        if (path === "/api/control/status") return send(res, 200, { version: VERSION, recording: recorder.status(), model: progress, plugins: [...plugins.keys()] });
        if (path === "/api/control/stop") {
          send(res, 200, { ok: true });
          setTimeout(() => void running.close().then(() => process.exit(0)), 50);
          return;
        }
        if (path === "/api/bridge/poll") {
          const b = z.object({ session: z.string().min(1).max(200), waitMs: z.number().int().min(0).max(25000) }).parse(body);
          plugins.set(b.session, { idle: plugins.get(b.session)?.idle ?? true, at: Date.now() });
          const ac = new AbortController();
          res.on("close", () => ac.abort());
          const delivery = await bridge.poll(b.session, b.waitMs, ac.signal);
          if (delivery) broadcast({ type: "claimed", meetingId: delivery.meetingId, segments: delivery.segments });
          return send(res, 200, { delivery });
        }
        if (path === "/api/bridge/ack" || path === "/api/bridge/release") {
          const b = z.object({ id: z.string().uuid() }).parse(body);
          if (path.endsWith("ack")) bridge.ack(b.id); else bridge.release(b.id);
          broadcast({ type: "status", status: recorder.status() });
          return send(res, 200, { ok: true });
        }
        if (path === "/api/bridge/state") {
          const b = z.object({ session: z.string().min(1).max(200), idle: z.boolean() }).parse(body);
          plugins.set(b.session, { idle: b.idle, at: Date.now() });
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: "Not found" });
      }

      if (req.method !== "GET") return send(res, 404, { error: "Not found" });

      if (path === "/" || path === "/index.html") {
        const nonce = randomUUID();
        nonces.add(nonce);
        if (nonces.size > 200) nonces.delete(nonces.values().next().value!);
        const indexFile = join(WEB_DIR, "index.html");
        const html = (existsSync(indexFile) ? readFileSync(indexFile, "utf8") : PAGE_FALLBACK).replace("%NONCE%", nonce);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        });
        return res.end(html);
      }
      if (path.startsWith("/assets/")) {
        const file = resolve(WEB_DIR, `.${path}`);
        if (!file.startsWith(WEB_DIR) || !existsSync(file)) return send(res, 404, { error: "Not found" });
        return sendFile(req, res, file);
      }
      if (path.startsWith("/api/")) {
        if (!checkNonce(req, url, res)) return;
        if (path === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ type: "status", status: recorder.status() })}\n\n`);
          sse.add(res);
          req.on("close", () => sse.delete(res));
          return;
        }
        if (path === "/api/status") {
          const now = Date.now();
          return send(res, 200, {
            version: VERSION,
            recording: recorder.status(),
            model: progress,
            gemini: Boolean(env.GEMINI_API_KEY?.trim()),
            plugin: [...plugins.values()].some((p) => now - p.at < 60_000),
          });
        }
        if (path === "/api/meetings") {
          const q = url.searchParams.get("q")?.trim();
          return send(res, 200, q ? store.search(q, 0, 100).map((h) => ({ ...h.meta, excerpts: h.excerpts })) : store.listMeetings(0, 200));
        }
        const m = /^\/api\/meetings\/([0-9a-f-]{36})$/.exec(path);
        if (m) {
          const r = store.readMeeting(m[1]!);
          const delivered = new Map<number, string>();
          for (const e of r.segments) if (e.type === "delivered") delivered.set(e.segment, e.at);
          const segments = r.segments.flatMap((e) => (e.type === "sealed" ? [{ segment: e.segment, utteranceSeqs: e.utteranceSeqs, sealedAt: e.at, deliveredAt: delivered.get(e.segment) ?? null }] : []));
          const audio = Object.fromEntries((["mic", "system"] as const).map((s) => [s, existsSync(store.audioPath(r.meta.id, s, "m4a")) ? "m4a" : existsSync(store.audioPath(r.meta.id, s, "wav")) && r.meta.status !== "recording" ? "wav" : null]));
          return send(res, 200, { meta: r.meta, utterances: r.utterances, segments, states: bridge.segmentStates(r.meta.id), audio });
        }
        const a = /^\/api\/audio\/([0-9a-f-]{36})\/(mic|system)$/.exec(path);
        if (a) {
          for (const ext of ["m4a", "wav"] as const) {
            const file = store.audioPath(a[1]!, a[2] as "mic" | "system", ext);
            if (existsSync(file)) return sendFile(req, res, file);
          }
          return send(res, 404, { error: "No audio" });
        }
        return send(res, 404, { error: "Not found" });
      }
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : "Bad request" });
    }
  });

  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => r());
  });
  port = (server.address() as { port: number }).port;
  // Claim expiry belongs to the server's lifetime, not to a recording (a final segment can be claimed after stop).
  const maintenance = setInterval(() => bridge.releaseExpiredClaims(), 5_000);
  maintenance.unref();
  store.writeServerInfo({ port, pid: process.pid, token });

  const running: RunningServer = {
    url: base(),
    port,
    token,
    store,
    bridge,
    recorder,
    async close() {
      clearInterval(maintenance);
      if (recorder.activeMeetingId()) await recorder.stop().catch(() => {});
      await recorder.idle();
      for (const r of sse) r.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.clearServerInfo(process.pid);
      releaseLock();
    },
  };
  if (opts.open) openUrl(pageUrl());
  return running;
}
