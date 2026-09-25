import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/config";
import { createServer } from "../src/server";
import { PromptService } from "../src/service";
import { executeProvider, parseClaudeOutput, parseCodexOutput } from "../src/providers/execute";
import type { ModelOption } from "../src/types";

const model: ModelOption = { id: "codex:gpt-6-sol", provider: "codex", providerModel: "gpt-6-sol", label: "Sol", efforts: ["low", "medium"], defaultEffort: "medium", aliases: ["codex-sol6"] };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(execute: typeof executeProvider = async () => "A plain text result") {
  const dir = await mkdtemp(join(tmpdir(), "storylens-test-")); dirs.push(dir);
  const settings = new SettingsStore(join(dir, "settings.json")); await settings.load();
  const service = new PromptService(settings, execute, async () => ({ models: [model], providers: [{ provider: "codex", available: true }, { provider: "claude", available: false }] }));
  await service.refresh();
  const server = createServer(settings, service);
  const headers = { host: `127.0.0.1:${settings.get().port}`, authorization: `Bearer ${settings.get().token}` };
  return { server, headers, settings, service };
}

describe("ExecutePrompt boundary", () => {
  test("rejects missing credentials and website origins before running a provider", async () => {
    let calls = 0;
    const { server, headers } = await fixture(async () => { calls++; return "ok"; });
    const body = { prompt: "hello", model: model.id, effort: "low" };
    expect((await server.inject({ method: "POST", url: "/ExecutePrompt", headers: { host: headers.host }, payload: body })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/ExecutePrompt", headers: { ...headers, origin: "https://evil.example" }, payload: body })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/ExecutePrompt", headers: { ...headers, host: "attacker.example" }, payload: body })).statusCode).toBe(403);
    expect(calls).toBe(0);
    await server.close();
  });
  test("validates dynamic model effort and returns final text", async () => {
    const { server, headers } = await fixture();
    const unknown = await server.inject({ method: "POST", url: "/ExecutePrompt", headers, payload: { prompt: "hello", model: model.id, effort: "max" } });
    expect(unknown.statusCode).toBe(422);
    const valid = await server.inject({ method: "POST", url: "/ExecutePrompt", headers, payload: { prompt: "hello", model: "codex-sol6", effort: "low" } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().output).toBe("A plain text result");
    expect(valid.json().model).toBe(model.id);
    const caps = await server.inject({ method: "GET", url: "/capabilities", headers });
    expect(caps.json().models[0].efforts).toEqual(["low", "medium"]);
    await server.close();
  });
  test("limits concurrent provider work", async () => {
    const releases: (() => void)[] = [];
    const { service, server } = await fixture(() => new Promise<string>(resolve => { releases.push(() => resolve("done")); }));
    const input = { prompt: "hello", model: model.id, effort: "low" };
    const first = service.executePrompt(input); const second = service.executePrompt(input);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.activeCount()).toBe(2);
    await expect(service.executePrompt(input)).rejects.toMatchObject({ code: "BUSY" });
    releases.forEach(release => release()); await Promise.all([first, second]);
    expect(service.activeCount()).toBe(0);
    await server.close();
  });
  test("streams a terminal result and cancels running work on shutdown", async () => {
    const { server, headers } = await fixture();
    const streamed = await server.inject({ method: "POST", url: "/ExecutePrompt", headers: { ...headers, accept: "application/x-ndjson" }, payload: { prompt: "hello", model: model.id, effort: "low" } });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body.trim().split("\n").map(line => JSON.parse(line).type)).toEqual(["started", "result"]);
    await server.close();

    let canceled = false;
    const second = await fixture((_settings, _model, _effort, _prompt, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => { canceled = true; reject(new Error("canceled")); }, { once: true });
    }));
    const pending = second.service.executePrompt({ prompt: "hello", model: model.id, effort: "low" }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    second.service.cancelAll();
    await pending;
    expect(canceled).toBe(true);
    expect(second.service.activeCount()).toBe(0);
    await second.server.close();
  });
});

test("provider parsers return final messages, not progress or tool text", () => {
  expect(parseClaudeOutput('{"type":"system"}\n{"type":"result","is_error":false,"result":"OK"}\n')).toBe("OK");
  expect(parseCodexOutput('{"type":"item.completed","item":{"type":"command_execution","text":"private"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n')).toBe("OK");
});
