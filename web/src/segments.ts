import { clock, el, SIDE_LABEL, type MeetingDetail, type Utterance } from "./api.ts";

export function stateLabel(d: MeetingDetail, segment: number): { cls: string; text: string } {
  const info = d.segments.find((s) => s.segment === segment);
  if (info?.deliveredAt) return { cls: "sent", text: `送信済み ${new Date(info.deliveredAt).toLocaleTimeString("ja-JP", { hour12: false })}` };
  if (!d.meta.agentSession) return { cls: "none", text: "届け先なし" };
  return { cls: "wait", text: "待機中（Claudeが作業中）" };
}

export function utteranceRow(d: MeetingDetail, u: Utterance, onPlay?: (u: Utterance) => void): HTMLElement {
  const play = onPlay ? el("button", { class: "play", title: "この発言から再生", "aria-label": "この発言から再生" }, "▶") : null;
  play?.addEventListener("click", () => onPlay!(u));
  return el("div", { class: `u${u.echoOf ? " echo" : ""}`, "data-seq": String(u.seq) }, play ?? el("span"), el("time", {}, clock(d.meta.startedAt, u.startMs)),
    el("span", { class: `side-${u.side}` }, SIDE_LABEL[u.side]), el("span", { class: "txt" }, u.text));
}

/** Utterances grouped into their segments; utterances not yet in a segment come last. */
export function segmentBlocks(d: MeetingDetail, opts: { onPlay?: (u: Utterance) => void; title?: (n: number) => string } = {}): HTMLElement[] {
  const bySeq = new Map(d.utterances.map((u) => [u.seq, u]));
  const used = new Set<number>();
  const blocks = d.segments.map((s) => {
    const st = stateLabel(d, s.segment);
    const rows = s.utteranceSeqs.flatMap((q) => { used.add(q); const u = bySeq.get(q); return u ? [utteranceRow(d, u, opts.onPlay)] : []; });
    return el("section", { class: "seg", "data-segment": String(s.segment) },
      el("header", {}, el("span", {}, opts.title ? opts.title(s.segment) : "Claudeに送った区切り"), el("span", { class: `state ${st.cls}` }, st.text)), ...rows);
  });
  const rest = d.utterances.filter((u) => !used.has(u.seq) && (!u.echoOf || true) && !d.segments.some((s) => s.utteranceSeqs.includes(u.seq)));
  if (rest.length) blocks.push(el("section", { class: "seg open" }, el("header", {}, el("span", {}, "まだ区切っていない発言"), el("span", { class: "state open" }, "話し中")), ...rest.map((u) => utteranceRow(d, u, opts.onPlay))));
  return blocks;
}
