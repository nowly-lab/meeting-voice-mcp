import { el, type MeetingDetail, type MeetingMeta, type ServerStatus, type Side } from "./api.ts";
import { segmentBlocks } from "./segments.ts";

export type LiveState = { status: ServerStatus | null; detail: MeetingDetail | null; recent: MeetingMeta[]; talking: Record<Side, boolean> };

function elapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

function sidebar(state: LiveState) {
  const items = state.recent.slice(0, 12).map((m) =>
    el("a", { class: `item${m.id === state.status?.recording.meetingId ? " sel" : ""}`, href: `#history=${m.id}` },
      el("div", { class: "t" }, m.title), el("div", { class: "s" }, m.status === "recording" ? "録音中" : new Date(m.startedAt).toLocaleString("ja-JP", { hour12: false }))));
  return el("aside", { class: "side" }, el("h3", {}, "最近の会議"), ...items);
}

function checks(s: ServerStatus) {
  const model = s.model.state === "ready" ? ["ok", "ダウンロード済み"] : s.model.state === "downloading" ? ["ng", `ダウンロード中 ${s.model.total ? Math.floor((s.model.received / s.model.total) * 100) : 0}%`] : ["ng", "最初の録音で取得"];
  const rows: [string, string, string][] = [
    ["マイクの許可", "na", "録音開始時に確認"],
    ["Macの音の許可", "na", "録音開始時に確認"],
    ["文字起こしモデル", model[0]!, model[1]!],
    ["Claude Codeプラグイン", s.plugin ? "ok" : "ng", s.plugin ? "● 接続中" : "未接続（get_new_utterances で読めます）"],
    ["Gemini", s.gemini ? "ok" : "ng", s.gemini ? "使える（GEMINI_API_KEY）" : "GEMINI_API_KEY なし"],
  ];
  return el("div", { class: "checks" }, el("h4", {}, "準備"), ...rows.map(([name, cls, text]) => el("div", { class: "check" }, el("span", {}, name), el("span", { class: cls }, text))));
}

export function renderLive(root: HTMLElement, state: LiveState): void {
  const s = state.status;
  const main = el("div", { class: "main" });
  const rec = s?.recording;
  if (!s || !rec?.meetingId || !state.detail) {
    main.append(el("div", { class: "empty" }, el("div", { style: "font-size:40px" }, "🎙"), el("h2", {}, "Claudeから録音を始めるのを待っています"),
      el("p", {}, "Claude Code で録音を始めると、ここに会話が表示されます。"), s ? checks(s) : el("p", {}, "読み込み中…"), el("p", { class: "foot" }, "録音の開始・停止はClaudeから操作します。")));
  } else {
    const d = state.detail;
    main.append(el("h1", {}, d.meta.title), el("div", { class: "meta" }, el("span", { class: "rec" }, "録音中"), el("span", {}, elapsed(rec.elapsedMs)), el("span", { class: "chip" }, rec.engine === "gemini" ? "Gemini" : "Parakeet"),
      el("span", { class: "chip" }, rec.target ? `Claude Code: ${rec.target.slice(0, 8)}` : "届け先なし")));
    if (rec.sources.system === "denied") {
      main.append(el("div", { class: "banner", role: "alert" }, el("b", {}, "Macの音の許可がありません"),
        "相手側の音声を録音するには、システム設定 > プライバシーとセキュリティ > 画面とシステムオーディオ録音 で、サーバーを起動したターミナルのアプリを許可してください。マイクのみで録音を続けています。"));
    } else if (rec.error) {
      main.append(el("div", { class: "banner err", role: "alert" }, el("b", {}, "エラー"), rec.error));
    }
    if (!rec.target && rec.pending > 0) main.append(el("div", { class: "banner" }, el("b", {}, `届け先なし（${rec.pending} 件待ち）`), "Claude Code のセッションで take_delivery を呼ぶと、待っている区切りが届きます。"));
    const meter = (side: Side, label: string) => {
      const bar = el("div", { class: "bar" }, el("i", { style: `width:${Math.min(100, Math.round((rec.levels[side] ?? 0) * 400))}%` }));
      return el("div", { class: "meter", "data-side": side }, el("span", {}, label), bar, rec.sources[side] === "denied" ? el("span", { class: "need" }, "許可が必要") : null);
    };
    main.append(el("div", { class: "meters" }, meter("mic", "マイク"), meter("system", "Macの音")));
    main.append(...segmentBlocks(d));
    const talking = (["mic", "system"] as const).filter((x) => state.talking[x]);
    if (talking.length) main.append(el("div", { class: "partial" }, `${talking.map((x) => (x === "mic" ? "自分側" : "相手側")).join("・")}が話しています…`));
    main.append(el("p", { class: "foot" }, d.meta.engine === "gemini" ? "音声は Gemini で文字起こしされています" : "音声はこのMacで文字起こしされています"));
  }
  root.replaceChildren(el("div", { class: "layout" }, sidebar(state), main));
}
