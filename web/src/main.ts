import { get, nonce, type MeetingDetail, type MeetingMeta, type ServerStatus, type Side } from "./api.ts";
import { renderHistory } from "./history.ts";
import { renderLive, type LiveState } from "./live.ts";

const root = document.getElementById("app")!;
const live: LiveState = { status: null, detail: null, recent: [], talking: { mic: false, system: false } };
let tab: "live" | "history" = "live";
let historyList: MeetingMeta[] = [];
let historySelected: MeetingDetail | undefined;
let query = "";

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith("history")) tab = "history";
  else tab = "live";
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  void refresh();
}

async function refresh() {
  if (tab === "live") {
    live.status = await get<ServerStatus>("/api/status");
    live.recent = await get<MeetingMeta[]>("/api/meetings");
    const id = live.status.recording.meetingId;
    live.detail = id ? await get<MeetingDetail>(`/api/meetings/${id}`) : null;
    renderLive(root, live);
  } else {
    historyList = await get<MeetingMeta[]>(`/api/meetings${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    const m = /history=([0-9a-f-]{36})/.exec(location.hash) ?? /meeting=([0-9a-f-]{36})/.exec(location.hash);
    const id = m?.[1] ?? historyList[0]?.id;
    historySelected = id ? await get<MeetingDetail>(`/api/meetings/${id}`) : undefined;
    renderHistory(root, historyList, historySelected, { query, onSearch: (q) => { query = q; void refreshSoon(); } });
    const search = root.querySelector<HTMLInputElement>(".search");
    if (search && document.activeElement !== search && query) { search.focus(); search.setSelectionRange(query.length, query.length); }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void refresh(); }, 250);
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.addEventListener("click", () => { location.hash = b.dataset.tab === "history" ? "history" : ""; });
window.addEventListener("hashchange", route);

const events = new EventSource(`/api/events?nonce=${encodeURIComponent(nonce)}`);
events.onmessage = (m) => {
  const e = JSON.parse(m.data) as { type: string; side?: Side; active?: boolean; status?: ServerStatus["recording"] };
  if (e.type === "partial" && e.side) live.talking[e.side] = Boolean(e.active);
  if (e.type === "status" && e.status && live.status && tab === "live" && e.status.meetingId === live.status.recording.meetingId) {
    live.status.recording = e.status;
    // Level updates redraw only the meters.
    for (const side of ["mic", "system"] as const) {
      const bar = root.querySelector<HTMLElement>(`.meter[data-side=${side}] .bar i`);
      if (bar) bar.style.width = `${Math.min(100, Math.round((e.status.levels[side] ?? 0) * 400))}%`;
    }
    return;
  }
  if (tab === "live" || e.type === "segment") refreshSoon();
};
route();
