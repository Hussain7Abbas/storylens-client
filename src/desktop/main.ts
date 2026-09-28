import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, shell, Menu, nativeImage, Tray } from "electron";
import { StoryLensApi } from "../backend/api";
import { SettingsStore } from "../config";
import { CrawlSession } from "../crawl/session";
import { createServer } from "../server";
import { PromptService } from "../service";
import { ClientError } from "../types";

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let quitting = false;
  let server: ReturnType<typeof createServer> | undefined;
  let service: PromptService | undefined;
  let status = "Starting local service…";
  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  const crawl = new CrawlSession({
    account: () => settings.get().account,
    execute: (input, signal) => {
      if (!service) throw new ClientError("SERVICE_STOPPED", "The local AI service is not running.", 503);
      return service.executePrompt(input, signal);
    },
    onChange: snapshot => window?.webContents.send("crawl:changed", snapshot),
  });
  const rowKey = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.length > 100) throw new Error("Invalid character.");
    return value;
  };

  function showWindow(): void {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  function updateTray(): void {
    if (!settings.get().keepInSystemTray) { tray?.destroy(); tray = undefined; return; }
    if (tray) return;
    try {
      const icon = nativeImage.createFromPath(join(__dirname, "icon.png")).resize({ width: 20, height: 20 });
      tray = new Tray(icon);
      tray.setToolTip("Story Lens — local AI companion");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open Story Lens", click: showWindow },
        { type: "separator" },
        { label: "Quit Story Lens", click: () => app.quit() },
      ]));
      tray.on("double-click", showWindow);
    } catch {
      // If the OS tray is unavailable, closing the window must still quit.
      tray = undefined;
    }
  }
  function fromWindow(event: Electron.IpcMainInvokeEvent): void {
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(join(__dirname, "index.html")).href) throw new Error("Unexpected IPC sender.");
  }
  async function startServer(): Promise<void> {
    service = new PromptService(settings);
    server = createServer(settings, service);
    try {
      await server.listen({ host: "127.0.0.1", port: settings.get().port });
      status = `Listening on 127.0.0.1:${settings.get().port}`;
    } catch (error) {
      status = `Service could not start: ${error instanceof Error ? error.message : "unknown error"}`;
      await server.close().catch(() => {});
      server = undefined;
    }
    void service.refresh().then(() => window?.webContents.send("client:changed")).catch(() => {});
    window?.webContents.send("client:changed");
  }
  async function stopServer(): Promise<void> {
    service?.cancelAll();
    await server?.close().catch(() => {});
    server = undefined;
  }
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.whenReady().then(async () => {
    await settings.load();
    // The shared account arrives through the local service; refresh the window when it changes.
    settings.onChange(() => window?.webContents.send("client:changed"));
    ipcMain.handle("client:state", async event => {
      fromWindow(event);
      // The renderer never sees the account session token.
      const { account, ...visible } = settings.get();
      return { settings: visible, account: account ? { apiUrl: account.apiUrl } : null, status, capabilities: service ? await service.catalog() : null };
    });
    ipcMain.handle("client:save", async (event, patch: unknown) => {
      fromWindow(event);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings.");
      const value = patch as Record<string, unknown>;
      if (Object.keys(value).some(key => !["port", "claudePath", "codexPath", "keepInSystemTray"].includes(key))) throw new Error("Unsupported setting.");
      const previous = settings.get();
      await settings.update(value);
      const current = settings.get();
      if (current.port !== previous.port || current.claudePath !== previous.claudePath || current.codexPath !== previous.codexPath) {
        await stopServer();
        await startServer();
        if (!server) { await settings.update({ port: previous.port, claudePath: previous.claudePath, codexPath: previous.codexPath }); await startServer(); throw new Error("Could not apply connection settings. Previous settings restored."); }
      }
      updateTray();
      return { status };
    });
    ipcMain.handle("client:rotate", async event => { fromWindow(event); service?.cancelAll(); await settings.rotate(); return settings.get().token; });
    ipcMain.handle("client:copy", async event => { fromWindow(event); clipboard.writeText(settings.get().token); });
    ipcMain.handle("client:refresh", async event => { fromWindow(event); return service?.refresh(); });
    ipcMain.handle("crawl:state", event => { fromWindow(event); return crawl.snapshot(); });
    ipcMain.handle("crawl:novels", async event => {
      fromWindow(event);
      const account = settings.get().account;
      if (!account) return [];
      return (await new StoryLensApi(account).novels()).map(({ id, name }) => ({ id, name }));
    });
    ipcMain.handle("crawl:start", (event, input: unknown) => { fromWindow(event); return crawl.start(input); });
    ipcMain.handle("crawl:stop", event => { fromWindow(event); crawl.stop(); return crawl.snapshot(); });
    ipcMain.handle("crawl:resume", (event, pages: unknown) => { fromWindow(event); return crawl.resume(pages); });
    ipcMain.handle("crawl:update", (event, key: unknown, patch: unknown) => { fromWindow(event); return crawl.updateRow(rowKey(key), patch); });
    ipcMain.handle("crawl:remove", (event, key: unknown) => { fromWindow(event); return crawl.removeRow(rowKey(key)); });
    ipcMain.handle("crawl:save", (event, key: unknown) => { fromWindow(event); return crawl.saveRow(rowKey(key)); });
    ipcMain.handle("crawl:saveAll", event => { fromWindow(event); return crawl.saveAll(); });
    ipcMain.handle("crawl:reset", event => { fromWindow(event); return crawl.reset(); });
    window = new BrowserWindow({ width: 1080, height: 880, minWidth: 440, minHeight: 560, title: "Story Lens Client", backgroundColor: "#f7f7fb", autoHideMenuBar: true, webPreferences: {
      preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const allowed = new Set(["https://storylens.iscoded.com/en/", "https://storylens.iscoded.com/en/privacy/", "https://storylens.iscoded.com/en/terms/"]);
      if (allowed.has(url)) void shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", event => event.preventDefault());
    updateTray();
    window.on("close", event => {
      if (!quitting && settings.get().keepInSystemTray && tray) {
        event.preventDefault();
        window?.hide();
      }
    });
    window.on("closed", () => { window = undefined; app.quit(); });
    await window.loadFile(join(__dirname, "index.html"));
    await startServer();
  }).catch(error => { console.error("Story Lens Client startup failed", error); app.quit(); });
  app.on("before-quit", () => { quitting = true; tray?.destroy(); tray = undefined; crawl.cancel(); service?.cancelAll(); void server?.close(); });
}
