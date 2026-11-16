export const nonce = document.body.dataset.nonce ?? "";

export type Side = "mic" | "system";
export type Utterance = { seq: number; id: string; side: Side; startMs: number; endMs: number; text: string; echoOf?: string };
export type MeetingMeta = { id: string; title: string; startedAt: string; endedAt?: string; engine: EngineKind; status: "recording" | "stopped" | "saved"; agentSession: string | null; interrupted?: boolean; excerpts?: string[]; audioGaps?: { side: Side; fromMs: number; toMs: number }[] };
export type RecordingStatus = { meetingId: string | null; title: string | null; elapsedMs: number; engine: EngineKind | null; sources: Record<Side, "ok" | "denied" | "off">; levels: Record<Side, number>; pending: number; target: string | null; error: string | null; audioGaps: { side: Side; fromMs: number; toMs: number }[] };
export type ServerStatus = { version: string; recording: RecordingStatus; model: { state: string; received: number; total: number }; gemini: boolean; soniox: boolean; plugin: boolean };
export type SegmentInfo = { segment: number; utteranceSeqs: number[]; sealedAt: string; deliveredAt: string | null };
export type MeetingDetail = { meta: MeetingMeta; utterances: Utterance[]; segments: SegmentInfo[]; states: { segment: number; state: "sealed" | "claimed" | "delivered"; resent: boolean }[]; audio: Record<Side, "m4a" | "wav" | null> };

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "x-nonce": nonce } });
  if (!res.ok) throw Error(`${res.status}`);
  return res.json() as Promise<T>;
}
export const audioUrl = (id: string, side: Side) => `/api/audio/${id}/${side}?nonce=${encodeURIComponent(nonce)}`;
export function clock(startedAt: string, offsetMs: number) {
  return new Date(Date.parse(startedAt) + offsetMs).toLocaleTimeString("ja-JP", { hour12: false });
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c !== null) e.append(c);
  return e;
}
export const SIDE_LABEL: Record<Side, string> = { mic: "自分側", system: "相手側" };

export type EngineKind = "parakeet" | "gemini" | "soniox";
const ENGINE_LABELS: Record<EngineKind, string> = { parakeet: "Parakeet", gemini: "Gemini", soniox: "Soniox" };
export function engineLabel(engine: EngineKind): string {
  return ENGINE_LABELS[engine] ?? engine;
}
/** Where the audio goes, shown under the live meeting. */
export function engineFoot(engine: EngineKind): string {
  return engine === "parakeet" ? "音声はこのMacで文字起こしされています" : `音声は ${engineLabel(engine)} で文字起こしされています`;
}
