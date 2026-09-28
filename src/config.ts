import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** Story Lens API base URL: HTTPS, or HTTP on this computer for development. */
export const apiUrlSchema = z.string().max(500).url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "API URL must use HTTPS (or HTTP on localhost).");
/** Story Lens account session shared by the paired extension; crawling uses it to reach the API. */
export const accountSchema = z.object({ apiUrl: apiUrlSchema, token: z.string().min(1).max(4096) }).strict();
export type Account = z.infer<typeof accountSchema>;

const schema = z.object({
  port: z.number().int().min(1024).max(65535).default(43127),
  token: z.string().min(32),
  keepInSystemTray: z.boolean().default(true),
  claudePath: z.string().max(1024).default("claude"),
  codexPath: z.string().max(1024).default("codex"),
  account: accountSchema.nullable().default(null),
  extraModels: z.array(z.object({ provider: z.enum(["claude", "codex"]), model: z.string().regex(/^[a-zA-Z0-9.:[\]-]+$/), label: z.string().min(1).max(100), efforts: z.array(z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])).min(1) })).default([]),
}).strict();
export type Settings = z.infer<typeof schema>;

export class SettingsStore {
  private settings?: Settings;
  private readonly listeners = new Set<(settings: Settings) => void>();
  constructor(private readonly path: string) {}
  /** Called after every persisted change; returns an unsubscribe function. */
  onChange(listener: (settings: Settings) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async load(): Promise<Settings> {
    if (this.settings) return this.settings;
    try { this.settings = schema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.settings = schema.parse({ token: randomBytes(32).toString("hex") });
      await this.persist();
    }
    return this.settings;
  }
  get(): Settings { if (!this.settings) throw new Error("Settings not loaded"); return this.settings; }
  async update(patch: Partial<Settings>): Promise<Settings> {
    this.settings = schema.parse({ ...this.get(), ...patch });
    await this.persist();
    for (const listener of this.listeners) listener(this.settings);
    return this.settings;
  }
  async rotate(): Promise<Settings> { return this.update({ token: randomBytes(32).toString("hex") }); }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(this.get(), null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }
}
