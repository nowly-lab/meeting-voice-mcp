import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main } from "../src/cli.ts";

test("--version prints the package version", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  let out = "";
  const code = await main(["--version"], {}, { out: (s) => (out += s), err: () => {} });
  assert.equal(code, 0);
  assert.equal(out.trim(), pkg.version);
});
