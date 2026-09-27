import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/config";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function settingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storylens-settings-test-"));
  directories.push(directory);
  return join(directory, "settings.json");
}
test("new installs keep the companion in the system tray by default", async () => {
  const store = new SettingsStore(await settingsPath());
  expect((await store.load()).keepInSystemTray).toBe(true);
});
test("existing settings gain the tray default without changing their pairing token", async () => {
  const path = await settingsPath();
  const token = "existing-test-token".repeat(4);
  await writeFile(path, JSON.stringify({ token, port: 43127, claudePath: "claude", codexPath: "codex", extraModels: [] }));
  const store = new SettingsStore(path);
  expect((await store.load()).keepInSystemTray).toBe(true);
  expect(store.get().token).toBe(token);
});
test("tray preference persists across launches and rejects non-boolean values", async () => {
  const path = await settingsPath();
  const store = new SettingsStore(path);
  await store.load();
  await store.update({ keepInSystemTray: false });
  expect((await new SettingsStore(path).load()).keepInSystemTray).toBe(false);
  await expect(store.update(JSON.parse('{"keepInSystemTray":"false"}'))).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8")).keepInSystemTray).toBe(false);
});
