// Chrome integration check for the novel-site launcher and embedded popup.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const extensionPath = resolve(process.env.STORYLENS_EXTENSION_PATH ?? "../extension/.output/chrome-mv3");
const profile = await mkdtemp(join(tmpdir(), "storylens-launcher-smoke-"));
const site = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; frame-src 'none'" });
  response.end("<!doctype html><html><body><article><h1>A novel chapter</h1><p>Once upon a time.</p></article></body></html>");
});
await new Promise<void>(resolve => site.listen(45272, "0.0.0.0", resolve));
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("http://127.0.0.1:45272/");
  await page.waitForTimeout(1000);
  if (await page.locator("#storylens-page-launcher").count()) throw new Error("Launcher appeared on an unregistered domain.");

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "storylens-website-selector-cache:127.0.0.1": { website: "127.0.0.1", novel: {}, chapter: {} },
    });
  });
  await page.goto("http://127.0.0.1:45272/");
  await page.locator("#storylens-page-launcher").waitFor({ timeout: 20_000 });
  await page.locator("#storylens-page-launcher").evaluate(host => {
    (host.shadowRoot?.querySelector("#launcher") as HTMLButtonElement).click();
  });
  const popupRoot = page.frameLocator("#storylens-page-launcher >> iframe").locator("#root");
  await popupRoot.waitFor({ timeout: 20_000 });
  await popupRoot.locator("button").first().waitFor({ timeout: 20_000 });
  await page.locator("#storylens-page-launcher").evaluate(host => {
    const shadow = host.shadowRoot;
    if (shadow?.querySelector("#panel")?.hasAttribute("hidden")) throw new Error("Popup did not open.");
    (shadow?.querySelector("#close") as HTMLButtonElement).click();
    if (!shadow?.querySelector("#panel")?.hasAttribute("hidden")) throw new Error("Popup did not close.");
  });
  if (errors.some(error => error.includes("Refused to frame"))) throw new Error(errors.join("\n"));
  console.log("Chrome launcher smoke test passed: registered domain, embedded popup, and close control.");
} finally {
  await context?.close();
  site.close();
  await rm(profile, { recursive: true, force: true });
}
