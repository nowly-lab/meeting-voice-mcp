import type { Side, Utterance } from "../store/store.ts";

export type SpeechEngine = { write(side: Side, pcm: Buffer, atMs: number): void; stop(): Promise<void> };
export type SpeechCallbacks = {
  voice(side: Side, active: boolean, atMs: number): void;
  text(u: Omit<Utterance, "seq" | "id">): void;
  pending(side: Side, atMs: number): void;
  error(message: string): void;
};
export const SAMPLE_RATE = 16000;
export function pcmToFloat(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}
