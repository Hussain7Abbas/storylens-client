import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
import type { Settings } from "../config";
import type { GeneratedImage, ModelOption } from "../types";
import { ClientError } from "../types";
import { runCli, withWorkDir } from "./process";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const IMAGE_BYTES_LIMIT = 8_000_000;

/** Codex saves generated images under `$CODEX_HOME/generated_images/`. */
export function codexImageFolder(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images");
}

export function imageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

type ImageEvidence = { base64?: string; paths: string[]; revisedPrompt?: string; failure?: string };

/** Collects base64 results and saved paths from Codex image generation events, ignoring every other item. */
export function parseCodexImageEvents(stdout: string): ImageEvidence {
  const evidence: ImageEvidence = { paths: [] };
  const visit = (value: unknown, imageItem: boolean): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, imageItem); return; }
    const record = value as Record<string, unknown>;
    const isImage = imageItem || (typeof record.type === "string" && /image_?generation/i.test(record.type));
    if (isImage) {
      for (const key of ["saved_path", "savedPath"]) if (typeof record[key] === "string") evidence.paths.push(record[key] as string);
      if (typeof record.result === "string" && record.result.length > 100) evidence.base64 = record.result;
      for (const key of ["revised_prompt", "revisedPrompt"]) if (typeof record[key] === "string") evidence.revisedPrompt = record[key] as string;
      const failure = record.failure ?? record.error;
      if (failure && typeof failure === "object" && typeof (failure as { message?: unknown }).message === "string") evidence.failure = (failure as { message: string }).message;
      else if (typeof failure === "string") evidence.failure = failure;
    }
    for (const [key, entry] of Object.entries(record)) if (key !== "result") visit(entry, isImage);
  };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line), false); } catch { /* Ignore log lines */ }
  }
  return evidence;
}

async function newestImage(folder: string, since: number, depth = 3): Promise<string | undefined> {
  let best: { path: string; time: number } | undefined;
  const walk = async (dir: string, level: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && level < depth) await walk(path, level + 1);
      else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs >= since && (!best || info.mtimeMs > best.time)) best = { path, time: info.mtimeMs };
      }
    }
  };
  await walk(folder, 0);
  return best?.path;
}

async function readImage(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > IMAGE_BYTES_LIMIT) throw new ClientError("OUTPUT_TOO_LARGE", "Generated image exceeded the size limit.");
  return readFile(path);
}

/** Picks the generated image: inline base64 first, then a reported path, then the newest file Codex wrote during this run. */
export async function resolveGeneratedImage(evidence: ImageEvidence, folders: string[], since: number): Promise<Buffer> {
  if (evidence.base64) {
    const bytes = Buffer.from(evidence.base64.replace(/^data:image\/[a-z]+;base64,/, ""), "base64");
    if (imageMimeType(bytes)) return bytes;
  }
  for (const path of evidence.paths)
    if (imageExtensions.has(extname(path).toLowerCase()) && folders.some(folder => inside(folder, path)))
      return readImage(path);
  for (const folder of folders) {
    const path = await newestImage(folder, since);
    if (path) return readImage(path);
  }
  throw new ClientError("PROVIDER_RESULT", evidence.failure?.slice(0, 500) || "Codex did not return an image.");
}

export function imagePrompt(prompt: string): string {
  return `Use your image generation tool exactly once to create one image from the brief below, then reply with one short sentence describing the image. Do not ask questions.
Create an original illustration: do not copy official artwork, cover art, or the designs of existing adaptations or well-known characters, and do not add text, captions, watermarks or signatures.

${prompt}`;
}

export async function generateCodexImage(settings: Settings, model: ModelOption, effort: string, prompt: string, signal: AbortSignal): Promise<GeneratedImage> {
  if (model.provider !== "codex") throw new ClientError("UNSUPPORTED_PROVIDER", "Image generation requires a Codex model.", 422);
  return withWorkDir(async cwd => {
    const since = Date.now() - 1_000;
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0", "--disable", "browser_use", "--disable", "computer_use", "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "shell_tool", "--enable", "image_generation", "-m", model.providerModel];
    if (effort !== "default") args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
    const { stdout } = await runCli(settings.codexPath, args, imagePrompt(prompt), { cwd, signal, timeoutMs: 300_000, maxBytes: 30_000_000 });
    const evidence = parseCodexImageEvents(stdout);
    const bytes = await resolveGeneratedImage(evidence, [codexImageFolder(), cwd], since);
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new ClientError("PROVIDER_RESULT", "Codex returned an unsupported image format.");
    return { mimeType, data: bytes.toString("base64"), revisedPrompt: evidence.revisedPrompt };
  });
}
