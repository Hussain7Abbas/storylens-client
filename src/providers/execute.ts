import { z } from "zod";
import type { Settings } from "../config";
import type { ModelOption, ResponseLanguage } from "../types";
import { ClientError } from "../types";
import { runCli, withWorkDir } from "./process";

const claudeResult = z.object({ type: z.literal("result"), is_error: z.boolean().optional(), result: z.string().optional(), subtype: z.string().optional() });

export function parseClaudeOutput(stdout: string): string {
  let last: z.infer<typeof claudeResult> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    const parsed = claudeResult.safeParse(event);
    if (parsed.success) last = parsed.data;
  }
  if (!last) {
    try {
      const parsed = claudeResult.safeParse(JSON.parse(stdout));
      if (parsed.success) last = parsed.data;
    } catch { /* No structured result */ }
  }
  if (!last || last.is_error || !last.result?.trim()) throw new ClientError("PROVIDER_RESULT", last?.result?.slice(0, 500) || "Claude did not return a final answer.");
  return last.result.trim();
}

export function parseCodexOutput(stdout: string): string {
  let result = "";
  let failed = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    const parsed = z.object({ type: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }).optional() }).safeParse(event);
    if (!parsed.success) continue;
    if (parsed.data.type === "turn.failed") failed = true;
    if (parsed.data.type === "item.completed" && parsed.data.item?.type === "agent_message" && parsed.data.item.text) result = parsed.data.item.text;
  }
  if (failed || !result.trim()) throw new ClientError("PROVIDER_RESULT", "Codex did not return a final answer.");
  return result.trim();
}

export async function executeProvider(settings: Settings, model: ModelOption, effort: string, prompt: string, responseLanguage: ResponseLanguage, signal: AbortSignal): Promise<string> {
  return withWorkDir(async cwd => {
    const language = responseLanguage === "ar" ? "Arabic" : "English";
    const localizedPrompt = `Response language: ${language} (${responseLanguage}). Write the final answer in ${language}.\n\n${prompt}`;
    if (model.provider === "claude") {
      const args = ["-p", "--model", model.providerModel, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-session-persistence"];
      if (effort !== "default") args.push("--effort", effort);
      const { stdout } = await runCli(settings.claudePath, args, localizedPrompt, { cwd, signal, timeoutMs: 240_000, maxBytes: 1_500_000 });
      return parseClaudeOutput(stdout);
    }
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0", "--disable", "browser_use", "--disable", "computer_use", "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "shell_tool", "-m", model.providerModel];
    if (effort !== "default") args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
    const { stdout } = await runCli(settings.codexPath, args, localizedPrompt, { cwd, signal, timeoutMs: 240_000, maxBytes: 1_500_000 });
    return parseCodexOutput(stdout);
  });
}
