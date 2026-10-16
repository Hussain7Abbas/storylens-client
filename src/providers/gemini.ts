import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ClientError } from "../types";

/** Keep the CLI's existing login, while overriding tools and local customizations per job. */
export async function geminiEnvironment(cwd: string, webSearch = false): Promise<NodeJS.ProcessEnv> {
  const tools = webSearch ? ["google_web_search", "web_fetch"] : [];
  const settings = {
    admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
    hooksConfig: { enabled: false },
    tools: { core: tools, allowed: tools, discoveryCommand: "", callCommand: "" },
    mcp: { serverCommand: "" },
    context: { fileName: "STORYLENS_NO_CONTEXT.md", includeDirectoryTree: false, includeDirectories: [], discoveryMaxDirs: 0 },
    advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, checkpointing: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
  };
  const path = join(cwd, "gemini-settings.json");
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path, GEMINI_CLI_SURFACE: "storylens", NO_COLOR: "1" };
}

const resultSchema = z.object({ response: z.string().optional(), error: z.unknown().optional() });
export function parseGeminiOutput(stdout: string): string {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new ClientError("PROVIDER_RESULT", "Gemini CLI did not return a structured final answer."); }
  const result = resultSchema.safeParse(value);
  // Never surface tool output or raw provider errors (which can contain the prompt).
  if (!result.success || result.data.error || !result.data.response?.trim())
    throw new ClientError("PROVIDER_RESULT", "Gemini CLI did not return a final answer. Check its sign-in and selected model.");
  return result.data.response.trim();
}
