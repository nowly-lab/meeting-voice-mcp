// Bundles the page into web/dist (index.html, assets/main.js, assets/style.css).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../web/", import.meta.url));
mkdirSync(`${root}dist/assets`, { recursive: true });
await build({ entryPoints: [`${root}src/main.ts`], bundle: true, format: "esm", target: "es2022", outfile: `${root}dist/assets/main.js`, logLevel: "warning", minify: true });
copyFileSync(`${root}src/style.css`, `${root}dist/assets/style.css`);
copyFileSync(`${root}index.html`, `${root}dist/index.html`);
console.log("web: built web/dist");
