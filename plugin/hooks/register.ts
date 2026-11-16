// meeting-voice Claude Code mod: the meeting_voice tool (relayed to the local server with this session's id)
// and the delivery of meeting segments into this session. The logic lives in delivery.ts.
import type { Register } from "claude-code";
import { createLink, TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, type PluginHost, type ServerInfo } from "./delivery";

const SERVER_START = ["npx", "-y", "github:nowly-lab/meeting-voice-mcp", "ensure"];

export const register: Register = (on) => {
  let link: ReturnType<typeof createLink> | null = null;
  let toolName: string | null = null;
  let tick: { cancel(): void } | null = null;

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const home = (await $.env.get("HOME")) ?? "";
    const dataDir = (await $.env.get("MEETING_VOICE_MCP_DATA_DIR"))?.trim() || `${home}/.meeting-voice-mcp`;
    const start = (await $.env.get("MEETING_VOICE_MCP_START"))?.trim();
    const host: PluginHost = {
      sessionId: () => $.session.id(),
      async readServerInfo(): Promise<ServerInfo | null> {
        try {
          const info = JSON.parse(await $.fs.read(`${dataDir}/server.json`)) as Partial<ServerInfo>;
          return typeof info.port === "number" && typeof info.token === "string" ? { port: info.port, pid: info.pid ?? 0, token: info.token } : null;
        } catch {
          return null;
        }
      },
      async startServer() {
        await $.process.run(start ? start.split(" ") : SERVER_START, { timeoutMs: 180_000 });
      },
      fetch: (url, init) => $.http.fetch(url, init),
      submit: (text) => $.prompt.submit({ text }) as Promise<{ drop?: unknown } | undefined>,
      async append(text) {
        const stored = (await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } })) as { deny?: string } | undefined;
        if (stored && typeof stored.deny === "string") throw Error(stored.deny);
      },
      log: (text) => void $.ui.log(text),
    };
    link = createLink(host);
    try {
      const registered = await $.tool.register({ name: "meeting_voice", description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>, isDeferred: false });
      toolName = registered.tool;
    } catch (error) {
      $.ui.log(`meeting-voice: the meeting_voice tool is not available in this session (${error instanceof Error ? error.message : String(error)}).`);
    }
    tick = $.clock.every(1000, () => void link?.pollOnce());
    return result;
  });

  on("tool.call", async ($, e, next) => {
    if (!link || !toolName || e.tool !== toolName) return next(e);
    const { tool: _t, tool_use_id: _id, agentId: _a, consent: _c, ...input } = e as unknown as Record<string, unknown>;
    const answer = await link.callTool(input);
    return "deny" in answer ? { deny: answer.deny } : { result: answer.text };
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      link?.turnStarted();
      void link?.reportState(false);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      link?.turnEnded();
      void link?.reportState(true);
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    tick?.cancel();
    tick = null;
    return next(e);
  });
};
