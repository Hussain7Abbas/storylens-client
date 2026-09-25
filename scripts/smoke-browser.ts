// Manual Chrome end-to-end check against a running, paired desktop client.
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const settings = JSON.parse(await readFile(join(homedir(), "Library/Application Support/storylens-client/settings.json"), "utf8")) as { token: string; port: number };
const model = process.env.STORYLENS_SMOKE_MODEL ?? "claude:claude-sonnet-5";
const effort = process.env.STORYLENS_SMOKE_EFFORT ?? "low";
const extensionPath = resolve(process.env.STORYLENS_EXTENSION_PATH ?? "../extension/.output/chrome-mv3");
const profile = await mkdtemp(join(tmpdir(), "storylens-chrome-smoke-"));
const site = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><body><article><h1>The lantern voyage</h1><p>Mira carried a blue lantern across the sea to find her brother Tarek. A storm delayed her, but the lighthouse keeper helped them reunite.</p></article></body></html>");
});
await new Promise<void>(resolve => site.listen(45271, "127.0.0.1", resolve));
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async value => {
    await chrome.storage.local.set({ "storylens-desktop-client": value });
  }, { ...settings, model, effort });
  const sitePage = await context.newPage();
  await sitePage.goto("http://127.0.0.1:45271/");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await sitePage.bringToFront();
  await popup.getByRole("button", { name: "Summarize page" }).evaluate(button => (button as HTMLButtonElement).click());
  await popup.close();
  await sitePage.locator("#storylens-page-summary").waitFor({ timeout: 20_000 });
  await sitePage.waitForFunction(() => {
    const host = document.querySelector("#storylens-page-summary");
    return host?.shadowRoot?.textContent?.includes("Mira") ?? false;
  }, undefined, { timeout: 80_000 });
  console.log(`Chrome summary smoke test passed with ${model}: result on original page.`);
} finally {
  await context?.close();
  site.close();
  await rm(profile, { recursive: true, force: true });
}
