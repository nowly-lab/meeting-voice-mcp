// One side's VAD + recognizer on a millisecond timeline anchored to the capture helper's timestamps.
import { SAMPLE_RATE } from "./types.ts";

export type VadLike = {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
};
export type SideResult = { voice: { active: boolean; atMs: number }[]; segments: { text: string; startMs: number; endMs: number }[] };

export const VAD_SETTINGS = { threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 15, windowSize: 512 };
const PER_MS = SAMPLE_RATE / 1000;
const MAX_GAP_FILL_MS = 60_000;
const GAP_TOLERANCE_MS = 100;

export function createSideProcessor({ vad, recognize }: { vad: VadLike; recognize(samples: Float32Array): string }) {
  let index = 0;
  let baseMs: number | null = null;
  let detected = false;
  const now = () => (baseMs ?? 0) + index / PER_MS;

  function drain(out: SideResult) {
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      vad.pop();
      const text = recognize(seg.samples).trim();
      if (!text) continue;
      out.segments.push({ text, startMs: Math.round((baseMs ?? 0) + seg.start / PER_MS), endMs: Math.round((baseMs ?? 0) + (seg.start + seg.samples.length) / PER_MS) });
    }
  }
  function feed(samples: Float32Array, out: SideResult) {
    vad.acceptWaveform(samples);
    index += samples.length;
    const d = vad.isDetected();
    if (d !== detected) {
      detected = d;
      out.voice.push({ active: d, atMs: Math.round(now()) });
    }
    drain(out);
  }

  return {
    accept(samples: Float32Array, atMs: number): SideResult {
      const out: SideResult = { voice: [], segments: [] };
      if (baseMs === null) baseMs = atMs;
      const gap = atMs - now();
      if (gap > GAP_TOLERANCE_MS) {
        if (gap <= MAX_GAP_FILL_MS) {
          feed(new Float32Array(Math.round(gap * PER_MS)), out);
        } else {
          vad.flush();
          drain(out);
          if (detected) { detected = false; out.voice.push({ active: false, atMs: Math.round(now()) }); }
          baseMs = atMs - index / PER_MS;
        }
      }
      feed(samples, out);
      return out;
    },
    flush(): SideResult {
      const out: SideResult = { voice: [], segments: [] };
      vad.flush();
      drain(out);
      if (detected) { detected = false; out.voice.push({ active: false, atMs: Math.round(now()) }); }
      return out;
    },
  };
}
