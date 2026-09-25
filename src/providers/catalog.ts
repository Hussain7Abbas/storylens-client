import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { Settings } from "../config";
import type { CapabilityStatus, ModelOption, ProviderName } from "../types";
import { ClientError } from "../types";
import { cliEnvironment, executablePath, stopProcess } from "./process";

type RpcMessage = { id?: number; method?: string; result?: unknown; error?: unknown; type?: string; request_id?: string; response?: unknown };
const codexModel = z.object({
  id: z.string(), model: z.string(), displayName: z.string().optional(), hidden: z.boolean().optional(),
  inputModalities: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
});
const codexPage = z.object({ data: z.array(codexModel), nextCursor: z.string().nullable().optional() });
const claudeModel = z.object({
  value: z.string(), resolvedModel: z.string().optional(), displayName: z.string().optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
});

function modelAliases(provider: ProviderName, model: string): string[] {
  if (provider === "claude" && model === "claude-sonnet-5") return ["claude-sonnet5"];
  if (provider === "codex" && model === "gpt-6-sol") return ["codex-sol6"];
  if (provider === "codex" && model === "gpt-5.6-luna") return ["codex-luna5.6"];
  return [];
}

async function queryModels(
  executable: string, args: string[], initial: RpcMessage[], request: (id: number, cursor?: string) => RpcMessage,
  response: (msg: RpcMessage) => { models: unknown[]; cursor?: string } | null,
): Promise<unknown[]> {
  const path = await executablePath(executable);
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: "pipe", windowsHide: true, detached: process.platform !== "win32", shell: process.platform === "win32" && path.toLowerCase().endsWith(".cmd"), env: cliEnvironment(path) });
    const models: unknown[] = [];
    let buffer = "", done = false, currentId = 2;
    const initialize = initial.find(message => message.method === "initialize");
    const afterInitialize = initial.filter(message => message.method !== "initialize");
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); stopProcess(child);
      error ? reject(error) : resolve(models);
    };
    const timer = setTimeout(() => finish(new ClientError("CATALOG_TIMEOUT", "Provider model discovery timed out.", 503)), 12_000);
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 3_000_000) { finish(new ClientError("CATALOG_TOO_LARGE", "Provider catalog is too large.", 503)); return; }
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && !done) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line) as RpcMessage;
          if (msg.error && (msg.id === initialize?.id || msg.id === currentId || msg.request_id === "models")) throw new ClientError("CATALOG_FAILED", "Provider rejected model discovery. Check its CLI installation and sign-in.", 503);
          if (initialize && msg.id === initialize.id) {
            if (!msg.result) throw new ClientError("CATALOG_FAILED", "Provider initialization returned no result.", 503);
            for (const message of afterInitialize) child.stdin.write(`${JSON.stringify(message)}\n`);
            child.stdin.write(`${JSON.stringify(request(currentId))}\n`);
            newline = buffer.indexOf("\n");
            continue;
          }
          if (initialize && msg.id !== currentId) {
            newline = buffer.indexOf("\n");
            continue;
          }
          const page = response(msg);
          if (page) {
            models.push(...page.models);
            if (page.cursor && models.length < 500) child.stdin.write(`${JSON.stringify(request(++currentId, page.cursor))}\n`);
            else finish();
          }
        } catch (error) {
          if (error instanceof SyntaxError) { /* Ignore provider log lines */ }
          else finish(error as Error);
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("close", () => { if (!done) finish(new ClientError("CATALOG_FAILED", "Provider did not return a model catalog.", 503)); });
    if (initialize) child.stdin.write(`${JSON.stringify(initialize)}\n`);
    else {
      for (const message of afterInitialize) child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.write(`${JSON.stringify(request(currentId))}\n`);
    }
  });
}

async function discoverCodex(path: string): Promise<ModelOption[]> {
  const entries = await queryModels(path, ["app-server", "--stdio", "-c", "mcp_servers={}"], [
    { method: "initialize", id: 1, result: undefined, ...{ params: { clientInfo: { name: "storylens_client", version: "0.1.0" } } } },
    { method: "initialized", ...{ params: {} } },
  ], (id, cursor) => ({ method: "model/list", id, ...{ params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) } } }), msg => {
    if (typeof msg.id !== "number" || msg.id < 2 || !msg.result) return null;
    const page = codexPage.parse(msg.result);
    return { models: page.data, cursor: page.nextCursor ?? undefined };
  });
  return entries.map(entry => codexModel.parse(entry)).filter(model => model.inputModalities?.includes("text") !== false && !model.id.includes("auto-review")).map(model => {
    const efforts = model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [];
    return { id: `codex:${model.model}`, provider: "codex", providerModel: model.model, label: model.displayName ?? model.model,
      efforts: efforts.length ? efforts : ["default"], defaultEffort: model.defaultReasoningEffort ?? efforts[0] ?? "default", aliases: modelAliases("codex", model.model) };
  });
}

async function discoverClaude(path: string): Promise<ModelOption[]> {
  const entries = await queryModels(path, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--no-session-persistence"], [],
    () => ({ type: "control_request", request_id: "models", ...{ request: { subtype: "initialize" } } }),
    msg => {
      if (msg.type !== "control_response") return null;
      const body = z.object({ request_id: z.literal("models"), response: z.object({ models: z.array(claudeModel) }) }).safeParse(msg.response);
      return body.success ? { models: body.data.response.models } : null;
    });
  const unique = new Map<string, ModelOption>();
  for (const raw of entries) {
    const model = claudeModel.parse(raw);
    if (model.value === "default") continue;
    const resolved = model.resolvedModel ?? model.value;
    const id = `claude:${model.value.includes("[") ? model.value : resolved}`;
    if (unique.has(id)) continue;
    const efforts = model.supportedEffortLevels?.length ? model.supportedEffortLevels : ["default"];
    unique.set(id, { id, provider: "claude", providerModel: model.value, label: model.displayName ?? resolved,
      efforts, defaultEffort: efforts.includes("high") ? "high" : efforts[0], aliases: modelAliases("claude", resolved) });
  }
  return [...unique.values()];
}

export async function discoverCatalog(settings: Settings): Promise<{ models: ModelOption[]; providers: CapabilityStatus[] }> {
  const results = await Promise.allSettled([discoverClaude(settings.claudePath), discoverCodex(settings.codexPath)]);
  const providers: CapabilityStatus[] = [];
  const models: ModelOption[] = [];
  for (const [index, result] of results.entries()) {
    const provider: ProviderName = index === 0 ? "claude" : "codex";
    if (result.status === "fulfilled") { models.push(...result.value); providers.push({ provider, available: result.value.length > 0 }); }
    else providers.push({ provider, available: false, error: result.reason instanceof Error ? result.reason.message : "Model discovery failed." });
  }
  for (const extra of settings.extraModels) {
    const id = `${extra.provider}:${extra.model}`;
    if (!models.some(model => model.id === id)) models.push({ id, provider: extra.provider, providerModel: extra.model, label: `${extra.label} (manual)`, efforts: extra.efforts, defaultEffort: extra.efforts[0], aliases: modelAliases(extra.provider, extra.model) });
  }
  return { models, providers };
}
