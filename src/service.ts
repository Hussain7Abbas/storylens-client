import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SettingsStore } from "./config";
import { discoverCatalog } from "./providers/catalog";
import { executeProvider } from "./providers/execute";
import type { Capabilities, ExecuteOutput, ModelOption } from "./types";
import { ClientError } from "./types";

export const LIMITS = { promptBytes: 500_000, outputBytes: 1_000_000, timeoutMs: 240_000, concurrent: 2 } as const;
const requestSchema = z.object({ prompt: z.string().min(1), model: z.string().min(1).max(200), effort: z.string().min(1).max(20) }).strict();

export class PromptService {
  private capabilities?: Capabilities;
  private readonly active = new Set<AbortController>();
  constructor(private readonly settings: SettingsStore, private readonly execute = executeProvider, private readonly discover = discoverCatalog) {}
  async refresh(): Promise<Capabilities> {
    const catalog = await this.discover(this.settings.get());
    this.capabilities = { protocolVersion: 1, models: catalog.models, providers: catalog.providers, limits: LIMITS };
    return this.capabilities;
  }
  async catalog(): Promise<Capabilities> { return this.capabilities ?? this.refresh(); }
  cancelAll(): void { for (const controller of this.active) controller.abort(); }
  activeCount(): number { return this.active.size; }
  async executePrompt(input: unknown, signal?: AbortSignal): Promise<ExecuteOutput> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new ClientError("INVALID_REQUEST", "Expected nonempty prompt, model, and effort.", 400);
    const { prompt, model: requestedModel, effort } = parsed.data;
    if (Buffer.byteLength(prompt, "utf8") > LIMITS.promptBytes) throw new ClientError("PROMPT_TOO_LARGE", "Prompt exceeds the 500 KB limit.", 413);
    const models = (await this.catalog()).models;
    const model: ModelOption | undefined = models.find(item => item.id === requestedModel || item.aliases.includes(requestedModel));
    if (!model) throw new ClientError("UNKNOWN_MODEL", "Selected model is unavailable. Refresh the model list.", 422);
    if (!model.efforts.includes(effort)) throw new ClientError("UNSUPPORTED_EFFORT", "Selected effort is unavailable for this model.", 422);
    if (this.active.size >= LIMITS.concurrent) throw new ClientError("BUSY", "Desktop client is busy. Try again shortly.", 429);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.active.add(controller);
    const started = Date.now();
    try {
      const output = await this.execute(this.settings.get(), model, effort, prompt, controller.signal);
      if (Buffer.byteLength(output, "utf8") > LIMITS.outputBytes) throw new ClientError("OUTPUT_TOO_LARGE", "Provider answer exceeded the limit.");
      return { requestId: randomUUID(), output, model: model.id, provider: model.provider, effort, durationMs: Date.now() - started };
    } finally {
      this.active.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
}
