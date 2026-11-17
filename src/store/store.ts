// The data folder, kept the way Plannotator keeps its Inbox: one folder per meeting, append-only
// jsonl records and one global sequence number. No database.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export type Side = "mic" | "system";

export const UtteranceSchema = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  side: z.enum(["mic", "system"]),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  echoOf: z.string().optional(),
});
export type Utterance = z.infer<typeof UtteranceSchema>;

export const MeetingMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  engine: z.enum(["parakeet", "gemini", "soniox"]),
  language: z.string(),
  instructions: z.string(),
  agentSession: z.string().nullable(),
  silenceSeconds: z.number(),
  status: z.enum(["recording", "stopped", "saved"]),
  interrupted: z.boolean().optional(),
  /** Real audio that arrived behind already-written idle silence and could not be kept (capture time, ms). */
  audioGaps: z.array(z.object({ side: z.enum(["mic", "system"]), fromMs: z.number(), toMs: z.number() })).max(1000).optional(),
});
export type MeetingMeta = z.infer<typeof MeetingMetaSchema>;

export const SegmentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sealed"), segment: z.number().int().positive(), utteranceSeqs: z.array(z.number().int()), at: z.string(), forced: z.boolean().optional() }),
  z.object({ type: z.literal("claimed"), segment: z.number().int().positive(), by: z.string(), at: z.string() }),
  z.object({ type: z.literal("released"), segment: z.number().int().positive(), at: z.string() }),
  z.object({ type: z.literal("delivered"), segment: z.number().int().positive(), session: z.string(), at: z.string() }),
]);
export type SegmentEvent = z.infer<typeof SegmentEventSchema>;

const ServerInfoSchema = z.object({ port: z.number().int(), pid: z.number().int(), token: z.string() });
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

function writeAtomic(file: string, text: string, mode?: number) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A line cut short by a crash: skip it, keep the rest.
    }
  }
  return out;
}

export class MeetingStore {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, "meetings"), { recursive: true, mode: 0o700 });
  }

  private meetingDir(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid meeting id");
    return join(this.dataDir, "meetings", id);
  }

  nextSeq(): number {
    const file = join(this.dataDir, "seq.json");
    let current = 0;
    try {
      current = z.object({ seq: z.number().int() }).parse(JSON.parse(readFileSync(file, "utf8"))).seq;
    } catch {
      current = 0;
    }
    const next = current + 1;
    writeAtomic(file, JSON.stringify({ seq: next }));
    return next;
  }

  createMeeting(meta: Omit<MeetingMeta, "id" | "status">): MeetingMeta {
    const full: MeetingMeta = MeetingMetaSchema.parse({ ...meta, id: randomUUID(), status: "recording" });
    mkdirSync(join(this.meetingDir(full.id), "audio"), { recursive: true, mode: 0o700 });
    writeAtomic(join(this.meetingDir(full.id), "meeting.json"), JSON.stringify(full, null, 2));
    return full;
  }

  updateMeeting(id: string, patch: Partial<MeetingMeta>): MeetingMeta {
    const next = MeetingMetaSchema.parse({ ...this.readMeta(id), ...patch, id });
    writeAtomic(join(this.meetingDir(id), "meeting.json"), JSON.stringify(next, null, 2));
    return next;
  }

  appendUtterance(id: string, u: Utterance): void {
    appendFileSync(join(this.meetingDir(id), "utterances.jsonl"), `${JSON.stringify(UtteranceSchema.parse(u))}\n`);
  }

  appendSegmentEvent(id: string, e: SegmentEvent): void {
    appendFileSync(join(this.meetingDir(id), "segments.jsonl"), `${JSON.stringify(SegmentEventSchema.parse(e))}\n`);
  }

  readMeta(id: string): MeetingMeta {
    return MeetingMetaSchema.parse(JSON.parse(readFileSync(join(this.meetingDir(id), "meeting.json"), "utf8")));
  }

  readMeeting(id: string): { meta: MeetingMeta; utterances: Utterance[]; segments: SegmentEvent[] } {
    const dir = this.meetingDir(id);
    return {
      meta: this.readMeta(id),
      utterances: readJsonl(join(dir, "utterances.jsonl"), UtteranceSchema),
      segments: readJsonl(join(dir, "segments.jsonl"), SegmentEventSchema),
    };
  }

  private allMeta(): MeetingMeta[] {
    const root = join(this.dataDir, "meetings");
    const metas: MeetingMeta[] = [];
    for (const name of readdirSync(root)) {
      try {
        metas.push(this.readMeta(name));
      } catch {
        // Not a meeting folder, or one being created.
      }
    }
    return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listMeetings(offset: number, limit: number): MeetingMeta[] {
    return this.allMeta().slice(offset, offset + limit);
  }

  search(query: string, offset: number, limit: number): { meta: MeetingMeta; excerpts: string[] }[] {
    const q = query.trim();
    const hits: { meta: MeetingMeta; excerpts: string[] }[] = [];
    for (const meta of this.allMeta()) {
      const excerpts = readJsonl(join(this.meetingDir(meta.id), "utterances.jsonl"), UtteranceSchema)
        .filter((u) => u.text.includes(q))
        .slice(0, 5)
        .map((u) => u.text.slice(0, 200));
      if (meta.title.includes(q) || excerpts.length > 0) hits.push({ meta, excerpts });
    }
    return hits.slice(offset, offset + limit);
  }

  audioPath(id: string, side: Side, ext: "wav" | "m4a"): string {
    return join(this.meetingDir(id), "audio", `${side}.${ext}`);
  }

  writeServerInfo(info: ServerInfo): void {
    writeAtomic(join(this.dataDir, "server.json"), JSON.stringify(ServerInfoSchema.parse(info)), 0o600);
  }

  readServerInfo(): ServerInfo | null {
    try {
      return ServerInfoSchema.parse(JSON.parse(readFileSync(join(this.dataDir, "server.json"), "utf8")));
    } catch {
      return null;
    }
  }

  clearServerInfo(pid: number): void {
    const info = this.readServerInfo();
    if (info && info.pid === pid) writeAtomic(join(this.dataDir, "server.json"), "{}", 0o600);
  }
}
