import { readFileSync } from "node:fs";
import { join } from "node:path";

/** This build's version from `package.json`, which packaging ships beside `dist/`. */
export const CLIENT_VERSION: string = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version;
