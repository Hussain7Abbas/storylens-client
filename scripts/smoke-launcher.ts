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
await new Promise<void>(resolve => site.listen(45272, "127.0.0.1", resolve));
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
  const circle = page.locator("#storylens-page-launcher #launcher");
  const panel = page.locator("#storylens-page-launcher #panel");
  await page.waitForFunction(() => {
    const image = document.querySelector("#storylens-page-launcher")?.shadowRoot?.querySelector("img");
    return image?.complete && image.naturalWidth > 0;
  });
  const dragTo = async (x: number, y: number) => {
    const rect = await circle.boundingBox();
    if (!rect) throw new Error("Circle is missing.");
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + rect.width / 2, y + rect.height / 2, { steps: 8 });
    await page.mouse.up();
    if (await panel.isVisible()) throw new Error("Dragging opened the popup.");
  };
  const assertBounds = async () => {
    for (const locator of [circle, panel]) {
      if (!await locator.isVisible()) continue;
      const rect = await locator.boundingBox();
      const viewport = page.viewportSize();
      if (!rect || !viewport || rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1)
        throw new Error(`Launcher or popup escaped the viewport: ${JSON.stringify({ rect, viewport })}`);
    }
  };
  await dragTo(20, 20);
  await circle.click();
  const popupRoot = page.frameLocator("#storylens-page-launcher >> iframe").locator("#root");
  await popupRoot.waitFor({ timeout: 20_000 });
  await popupRoot.locator("button").first().waitFor({ timeout: 20_000 });
  const topLeftCircle = await circle.boundingBox();
  const topLeftPanel = await panel.boundingBox();
  if (!topLeftCircle || !topLeftPanel || topLeftPanel.x < topLeftCircle.x + topLeftCircle.width)
    throw new Error("Top-left launcher did not open its popup to the right.");
  await assertBounds();
  await page.locator("#storylens-page-launcher").evaluate(host => {
    const shadow = host.shadowRoot;
    if (shadow?.querySelector("#panel")?.hasAttribute("hidden")) throw new Error("Popup did not open.");
    (shadow?.querySelector("#close") as HTMLButtonElement).click();
    if (!shadow?.querySelector("#panel")?.hasAttribute("hidden")) throw new Error("Popup did not close.");
  });
  await page.reload();
  await circle.waitFor();
  await page.waitForFunction(() => {
    const rect = document.querySelector("#storylens-page-launcher")?.getBoundingClientRect();
    return rect && Math.abs(rect.x - 20) < 1 && Math.abs(rect.y - 20) < 1;
  });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Missing viewport.");
  await dragTo(viewport.width + 100, viewport.height + 100);
  await assertBounds();
  await circle.click();
  const bottomRightCircle = await circle.boundingBox();
  const bottomRightPanel = await panel.boundingBox();
  if (!bottomRightCircle || !bottomRightPanel || bottomRightPanel.x + bottomRightPanel.width > bottomRightCircle.x || bottomRightPanel.y + bottomRightPanel.height > bottomRightCircle.y)
    throw new Error("Bottom-right launcher did not open its popup to the left and above.");
  await assertBounds();
  await page.setViewportSize({ width: 420, height: 500 });
  await page.waitForFunction(() => {
    const rect = document.querySelector("#storylens-page-launcher")?.getBoundingClientRect();
    return rect && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
  });
  await assertBounds();
  await page.reload();
  await circle.waitFor();
  await assertBounds();
  await circle.click();
  await panel.waitFor();
  await assertBounds();
  if (errors.some(error => error.includes("Refused to frame"))) throw new Error(errors.join("\n"));
  console.log("Chrome launcher smoke test passed: logo, drag persistence, viewport clamping, popup placement, and close control.");
} finally {
  await context?.close();
  site.close();
  await rm(profile, { recursive: true, force: true });
}
