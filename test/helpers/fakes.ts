import type { CaptureFn, EngineFactory } from "../../src/meeting/recorder.ts";
import type { SpeechCallbacks } from "../../src/speech/types.ts";

export function fakeHardware() {
  const state: { cb: SpeechCallbacks | null } = { cb: null };
  const engines: EngineFactory = async (kind, _sides, cb) => {
    if (kind === "gemini") throw Error("GEMINI_API_KEY が設定されていません。");
    if (kind === "soniox") throw Error("SONIOX_API_KEY が設定されていません。");
    state.cb = cb;
    return { write: () => {}, stop: async () => {} };
  };
  const capture: CaptureFn = async (sources, on) => {
    on.event({ event: "ready", sources });
    return { stop: async () => {}, exited: () => true };
  };
  return { engines, capture, state };
}
