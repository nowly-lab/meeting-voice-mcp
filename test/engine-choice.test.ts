import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEngine } from "../src/meeting/engine-choice.ts";

test("defaultEngine picks soniox when the key is set", () => {
  assert.deepEqual(defaultEngine({ SONIOX_API_KEY: "k" }), { engine: "soniox", note: null });
});

test("defaultEngine falls back to parakeet without a key", () => {
  for (const env of [{}, { SONIOX_API_KEY: "  " }]) {
    const r = defaultEngine(env);
    assert.equal(r.engine, "parakeet");
    assert.match(r.note ?? "", /SONIOX_API_KEY がないので Parakeet/);
  }
});
