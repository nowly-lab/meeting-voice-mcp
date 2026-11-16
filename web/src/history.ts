import { audioUrl, el, type MeetingDetail, type MeetingMeta, type Utterance } from "./api.ts";
import { segmentBlocks } from "./segments.ts";

function minutes(m: MeetingMeta) {
  if (!m.endedAt) return m.status === "recording" ? "録音中" : "";
  return `${Math.max(1, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60000))}分`;
}

export function renderHistory(root: HTMLElement, list: MeetingMeta[], selected: MeetingDetail | undefined, opts: { query: string; onSearch(q: string): void }): void {
  const search = el("input", { class: "search", type: "search", placeholder: "会議を検索", value: opts.query, "aria-label": "会議を検索" });
  search.addEventListener("input", () => opts.onSearch(search.value));
  const items = list.map((m) => el("a", { class: `item${m.id === selected?.meta.id ? " sel" : ""}`, href: `#history=${m.id}`, "data-id": m.id },
    el("div", { class: "t" }, m.title),
    el("div", { class: "s" }, `${new Date(m.startedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${minutes(m)} · ${m.engine === "gemini" ? "Gemini" : "Parakeet"}`),
    m.excerpts?.length ? el("div", { class: "s" }, m.excerpts[0]!) : null));
  const side = el("aside", { class: "side" }, search, ...(items.length ? items : [el("p", { class: "s" }, "会議はまだありません")]));
  const main = el("div", { class: "main" });
  if (!selected) {
    main.append(el("div", { class: "empty" }, el("h2", {}, "会議を選んでください"), el("p", {}, "左の一覧から選ぶと、文字起こしと音声が出ます。")));
  } else {
    const d = selected;
    main.append(el("h1", {}, d.meta.title), el("div", { class: "meta" },
      el("span", {}, `${new Date(d.meta.startedAt).toLocaleString("ja-JP", { hour12: false })}${d.meta.endedAt ? `–${new Date(d.meta.endedAt).toLocaleTimeString("ja-JP", { hour12: false })}` : ""}`),
      el("span", { class: "chip" }, d.meta.engine === "gemini" ? "Gemini" : "Parakeet"), el("span", { class: "chip" }, `${d.segments.length}区切り`),
      d.meta.interrupted ? el("span", { class: "chip" }, "中断して保存") : null));
    const players: Partial<Record<"mic" | "system", HTMLAudioElement>> = {};
    for (const s of ["mic", "system"] as const) {
      if (!d.audio[s]) continue;
      const a = el("audio", { controls: "", preload: "metadata", src: audioUrl(d.meta.id, s), "data-side": s });
      players[s] = a;
      main.append(el("div", { class: "s" }, s === "mic" ? "自分側（マイク）" : "相手側（Macの音）"), a);
    }
    if (!d.audio.mic && !d.audio.system) main.append(el("p", { class: "foot" }, d.meta.status === "recording" ? "録音中は再生できません" : "音声はありません（圧縮中かもしれません）"));
    const onPlay = (u: Utterance) => {
      const p = players[u.side];
      if (!p) return;
      for (const other of Object.values(players)) if (other !== p) other?.pause();
      p.currentTime = u.startMs / 1000;
      void p.play().catch(() => {});
    };
    main.append(el("h2", { style: "font-size:18px;margin:18px 0 10px" }, "文字起こし"), ...segmentBlocks(d, { onPlay, title: (n) => `区切り ${String(n).padStart(2, "0")}` }));
  }
  root.replaceChildren(el("div", { class: "layout" }, side, main));
}
