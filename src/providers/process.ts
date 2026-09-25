import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ClientError } from "../types";

const binFolders = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export async function executablePath(configured: string): Promise<string> {
  const envPaths = (process.env.PATH ?? "").split(delimiter);
  const home = homedir();
  const candidates = configured.includes("/") || configured.includes("\\")
    ? [configured]
    : [...envPaths, ...binFolders, join(home, ".local/bin"), join(home, ".npm-global/bin")].flatMap(folder =>
        process.platform === "win32"
          ? [join(folder, `${configured}.exe`), join(folder, `${configured}.cmd`), join(folder, configured)]
          : [join(folder, configured)]);
  if (process.platform !== "win32" && !configured.includes("/") && !configured.includes("\\")) {
    for (const folder of [join(home, ".nvm/versions/node"), join(home, ".bun/bin")]) {
      if (folder.endsWith("node")) {
        try { for (const version of (await readdir(folder)).reverse()) candidates.push(join(folder, version, "bin", configured)); }
        catch { /* No NVM install */ }
      } else candidates.push(join(folder, configured));
    }
  }
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); }
    catch { /* Try next location */ }
  }
  throw new ClientError("CLI_NOT_FOUND", `Executable ${configured} was not found. Set its path in the desktop app.`, 503);
}

export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { child.kill("SIGTERM"); }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Exited */ } }, 2_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
}

export async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "storylens-client-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export async function runCli(
  command: string, args: string[], input: string, options: { signal?: AbortSignal; timeoutMs: number; cwd: string; maxBytes?: number },
): Promise<{ stdout: string; stderr: string }> {
  const path = await executablePath(command);
  const child = spawn(path, args, {
    cwd: options.cwd, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32",
    shell: process.platform === "win32" && path.toLowerCase().endsWith(".cmd"),
    env: { ...process.env, PATH: [path.substring(0, path.lastIndexOf(process.platform === "win32" ? "\\" : "/")), process.env.PATH].filter(Boolean).join(delimiter) },
  });
  const maxBytes = options.maxBytes ?? 2_000_000;
  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  let bytes = 0, failure: ClientError | undefined;
  const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) { failure = new ClientError("OUTPUT_TOO_LARGE", "Provider output exceeded the limit."); stopProcess(child); return; }
    if (stream === "stdout") stdoutChunks.push(chunk);
    else stderrChunks.push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk as Buffer, "stdout"));
  child.stderr.on("data", chunk => collect(chunk as Buffer, "stderr"));
  const timer = setTimeout(() => { failure = new ClientError("TIMEOUT", "The provider took too long.", 504); stopProcess(child); }, options.timeoutMs);
  const abort = () => { failure = new ClientError("CANCELED", "Request canceled.", 499); stopProcess(child); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  try {
    const exitCode = await new Promise<number>((res, rej) => {
      child.once("error", rej);
      child.once("close", code => res(code ?? 1));
    });
    if (failure) throw failure;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (exitCode !== 0) throw new ClientError("PROVIDER_FAILED", stderr.trim().slice(0, 500) || `Provider exited with status ${exitCode}.`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
