import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const schema = z.object({
  port: z.number().int().min(1024).max(65535).default(43127),
  token: z.string().min(32),
  claudePath: z.string().max(1024).default("claude"),
  codexPath: z.string().max(1024).default("codex"),
  extraModels: z.array(z.object({ provider: z.enum(["claude", "codex"]), model: z.string().regex(/^[a-zA-Z0-9.:[\]-]+$/), label: z.string().min(1).max(100), efforts: z.array(z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])).min(1) })).default([]),
}).strict();
export type Settings = z.infer<typeof schema>;

export class SettingsStore {
  private settings?: Settings;
  constructor(private readonly path: string) {}
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
