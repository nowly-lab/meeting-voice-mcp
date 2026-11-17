import type { EngineKind } from "./recorder.ts";

/** The engine for a recording that names none: Soniox when its key is set, otherwise Parakeet on this Mac, with the reason. */
export function defaultEngine(env: { SONIOX_API_KEY?: string }): { engine: EngineKind; note: string | null } {
  if (env.SONIOX_API_KEY?.trim()) return { engine: "soniox", note: null };
  return { engine: "parakeet", note: "SONIOX_API_KEY がないので Parakeet で始めました（Soniox を使うには、サーバーを起動する環境に SONIOX_API_KEY を設定してください）。" };
}
