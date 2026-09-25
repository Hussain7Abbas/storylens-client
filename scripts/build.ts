import { cp } from "node:fs/promises";

await Bun.build({ entrypoints: ["src/desktop/renderer.ts"], outdir: "dist/desktop", target: "browser", format: "iife", throw: true });
await cp("src/desktop/index.html", "dist/desktop/index.html");
await cp("src/desktop/style.css", "dist/desktop/style.css");
