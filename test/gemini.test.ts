import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/config';
import { discoverCatalog } from '../src/providers/catalog';
import { executeProvider } from '../src/providers/execute';
import { geminiEnvironment, parseGeminiOutput } from '../src/providers/gemini';
import { PromptService } from '../src/service';
import { createServer } from '../src/server';
import type { ModelOption } from '../src/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'storylens-gemini-test-'));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, 'settings.json'));
  await store.load();
  return { dir, store };
}
const model: ModelOption = { id: 'gemini:test-model', provider: 'gemini', providerModel: 'test-model', label: 'Gemini test', efforts: ['default'], defaultEffort: 'default', aliases: [] };

test('legacy settings gain Gemini without resetting pairing, provider paths or tray preference', async () => {
  const { dir } = await fixture();
  const path = join(dir, 'legacy.json');
  await writeFile(path, JSON.stringify({ token: 'test-token-'.repeat(4), claudePath: '/claude', codexPath: '/codex', keepInSystemTray: false }));
  const store = new SettingsStore(path);
  expect(await store.load()).toMatchObject({ token: 'test-token-'.repeat(4), claudePath: '/claude', codexPath: '/codex', geminiPath: 'gemini', keepInSystemTray: false });
  await store.update({ geminiPath: '/custom/gemini', extraModels: [{ provider: 'gemini', model: 'custom-model', label: 'Custom Gemini', efforts: ['default'] }] });
  expect((await new SettingsStore(path).load()).geminiPath).toBe('/custom/gemini');
  await expect(store.update({ extraModels: [{ provider: 'gemini', model: 'test', label: 'Test', efforts: ['high'] }] })).rejects.toThrow('default effort');
});

test('Gemini parser accepts only a successful final response and never exposes raw errors', () => {
  expect(parseGeminiOutput(JSON.stringify({ response: ' Done ', stats: {} }))).toBe('Done');
  for (const value of ['progress', '{}', '{"response":""}', '{"response":"partial","error":{"message":"private prompt"}}'])
    expect(() => parseGeminiOutput(value)).toThrow();
  expect(() => parseGeminiOutput('{"error":{"message":"private prompt"}}')).toThrow('Gemini CLI did not return a final answer.');
});

test('Gemini job settings disable local integrations, and web tools are opt-in', async () => {
  const { dir } = await fixture();
  for (const webSearch of [false, true]) {
    const env = await geminiEnvironment(dir, webSearch);
    const settings = JSON.parse(await readFile(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'));
    expect(settings.admin.mcp.enabled).toBe(false);
    expect(settings.admin.extensions.enabled).toBe(false);
    expect(settings.admin.skills.enabled).toBe(false);
    expect(settings.hooksConfig.enabled).toBe(false);
    expect(settings.advanced.ignoreLocalEnv).toBe(true);
    expect(settings.tools.core).toEqual(webSearch ? ['google_web_search', 'web_fetch'] : []);
    expect(settings.tools.discoveryCommand).toBe('');
    expect(settings.context.includeDirectoryTree).toBe(false);
  }
});

// Executable fixture tests real stdin, process admission, arguments, environment and cleanup.
// Windows .cmd launchers remain a native-platform smoke check.
if (process.platform !== 'win32') {
  test('discovers Gemini models through ACP without sending a prompt and preserves CLI runtime PATH', async () => {
    const { dir, store } = await fixture();
    const command = join(dir, 'gemini');
    await writeFile(command, '#!/usr/bin/env storylens-gemini-runtime\n', { mode: 0o755 });
    await writeFile(join(dir, 'storylens-gemini-runtime'), `#!/bin/sh
IFS= read -r initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r request
printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"models":{"availableModels":[{"modelId":"auto","name":"Auto"},{"modelId":"test-model","name":"Gemini test"},{"modelId":"test-model","name":"Duplicate"}]}}}'
`, { mode: 0o755 });
    await store.update({ claudePath: '/missing-claude', codexPath: '/missing-codex', geminiPath: command });
    const previous = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const catalog = await discoverCatalog(store.get());
      expect(catalog.providers.find(provider => provider.provider === 'gemini')).toEqual({ provider: 'gemini', available: true });
      expect(catalog.models.map(entry => entry.id)).toEqual(['gemini:auto', 'gemini:test-model']);
      expect(catalog.models[1].efforts).toEqual(['default']);
    } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  });

  test('executes Gemini using stdin and its selected model; no tools except explicit web research', async () => {
    const { dir, store } = await fixture();
    const command = join(dir, 'gemini.mjs');
    const capture = join(dir, 'capture.json');
    await writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), settings: JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')) }));
console.log(JSON.stringify({ response: 'A Gemini response', stats: {} }));
`, { mode: 0o755 });
    await store.update({ geminiPath: command });
    for (const webSearch of [false, true]) {
      expect(await executeProvider(store.get(), model, 'default', 'Page @/private/file has text', 'ar', new AbortController().signal, { webSearch })).toBe('A Gemini response');
      const recorded = JSON.parse(await readFile(capture, 'utf8'));
      expect(recorded.args).toContain('test-model');
      expect(recorded.args).not.toContain('Page @/private/file has text');
      expect(recorded.args.includes('--allowed-tools')).toBe(webSearch);
      expect(recorded.prompt).toContain('Response language: Arabic (ar)');
      expect(recorded.prompt).toContain('Page \\@/private/file has text');
      expect(recorded.settings.tools.core).toEqual(webSearch ? ['google_web_search', 'web_fetch'] : []);
      expect(existsSync(recorded.cwd)).toBe(false);
    }
    await expect(executeProvider(store.get(), model, 'high', 'hi', 'en', new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_EFFORT' });
  });

  test('cancels a running Gemini process and removes its working directory', async () => {
    const { dir, store } = await fixture();
    const capture = join(dir, 'cwd.txt');
    const command = join(dir, 'gemini.mjs');
    await writeFile(command, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, process.cwd());
process.stdin.resume(); setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await store.update({ geminiPath: command });
    const abort = new AbortController();
    const result = executeProvider(store.get(), model, 'default', 'hi', 'en', abort.signal).catch(error => error);
    for (let i = 0; i < 100 && !existsSync(capture); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(capture)).toBe(true);
    abort.abort();
    expect(await result).toMatchObject({ code: 'CANCELED' });
    expect(existsSync(await readFile(capture, 'utf8'))).toBe(false);
  });
}

test('Gemini works through the authenticated HTTP contract and keeps image generation Codex-only', async () => {
  const { store } = await fixture();
  const service = new PromptService(store, async (_settings, selected, effort, _prompt, language) => `${selected.provider}/${effort}/${language}`,
    async () => ({ models: [model], providers: [{ provider: 'gemini', available: true }] }));
  const server = createServer(store, service);
  try {
    const headers = { authorization: `Bearer ${store.get().token}`, host: `127.0.0.1:${store.get().port}` };
    const capabilities = await server.inject({ method: 'GET', url: '/capabilities', headers });
    expect(capabilities.json().protocolVersion).toBe(2);
    expect(capabilities.json().features.imageGeneration).toBe(false);
    const response = await server.inject({ method: 'POST', url: '/ExecutePrompt', headers, payload: { prompt: 'hi', model: model.id, effort: 'default', responseLanguage: 'ar' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().output).toBe('gemini/default/ar');
    expect(response.json().provider).toBe('gemini');
    await expect(service.generateImage({ prompt: 'draw', model: model.id, effort: 'default' })).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  } finally { await server.close(); }
});
