// Decides where a segment ends: both sides silent for silenceMs with at least one utterance waiting,
// or forceMs of talk without such a pause. Also drops the mic copy of speaker audio (echo).
import type { Side, Utterance } from "../store/store.ts";

export type SegmenterOptions = { silenceMs: number; forceMs: number; transcriptWaitMs: number };
export type SealedSegment = { segment: number; utterances: Utterance[]; forced: boolean };

const ECHO_WINDOW_MS = 3000;
const ECHO_SIMILARITY = 0.8;

function normalize(text: string) {
  return text.replace(/[\s、。，．,.!?！？「」『』（）()・…ー〜~"'`]/g, "");
}

function longestCommonSubstring(a: string, b: string) {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1]! + 1;
        if (row[j]! > best) best = row[j]!;
      }
    }
    prev = row;
  }
  return best;
}

export function nearlySame(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  const short = Math.min(x.length, y.length);
  if (short === 0) return false;
  return longestCommonSubstring(x, y) >= Math.ceil(short * ECHO_SIMILARITY);
}

export function sealSegment(open: Utterance[], segment: number, forced: boolean): SealedSegment {
  return { segment, utterances: [...open].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq), forced };
}

export class Segmenter {
  private readonly opts: SegmenterOptions;
  private readonly onSeal: (s: SealedSegment) => void;
  private open: Utterance[] = [];
  private recentSystem: Utterance[] = [];
  private active: Record<Side, boolean> = { mic: false, system: false };
  private lastQuietAt = 0;
  private pending: Partial<Record<Side, number>> = {};
  private next = 1;

  constructor(opts: SegmenterOptions, onSeal: (s: SealedSegment) => void) {
    this.opts = opts;
    this.onSeal = onSeal;
  }

  voice(side: Side, active: boolean, atMs: number): void {
    this.active[side] = active;
    if (!active) this.lastQuietAt = Math.max(this.lastQuietAt, atMs);
  }

  pendingTranscript(side: Side, atMs: number): void {
    this.pending[side] = atMs;
  }

  /** Adds an utterance; returns it marked with echoOf when it is the mic copy of speaker audio. */
  utterance(u: Utterance): Utterance | null {
    delete this.pending[u.side];
    this.lastQuietAt = Math.max(this.lastQuietAt, u.endMs);
    if (u.side === "system") {
      this.recentSystem = [...this.recentSystem.filter((s) => u.startMs - s.startMs <= ECHO_WINDOW_MS), u];
    } else {
      const source = this.recentSystem.find((s) => Math.abs(u.startMs - s.startMs) <= ECHO_WINDOW_MS && nearlySame(s.text, u.text));
      if (source) return { ...u, echoOf: source.id };
    }
    this.open.push(u);
    return u;
  }

  tick(nowMs: number): void {
    if (this.open.length === 0) return;
    const first = Math.min(...this.open.map((u) => u.startMs));
    if (nowMs - first >= this.opts.forceMs) return this.seal(true);
    if (this.active.mic || this.active.system) return;
    if (nowMs - this.lastQuietAt < this.opts.silenceMs) return;
    const waiting = Object.values(this.pending).filter((at): at is number => at !== undefined);
    if (waiting.length > 0 && nowMs - Math.min(...waiting) < this.opts.transcriptWaitMs) return;
    this.seal(false);
  }

  flush(_nowMs: number): void {
    if (this.open.length > 0) this.seal(false);
  }

  private seal(forced: boolean) {
    const sealed = sealSegment(this.open, this.next++, forced);
    this.open = [];
    this.pending = {};
    this.onSeal(sealed);
  }
}
