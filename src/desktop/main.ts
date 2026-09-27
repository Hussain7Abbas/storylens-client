import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, shell, Menu, nativeImage, Tray } from "electron";
import { SettingsStore } from "../config";
import { createServer } from "../server";
import { PromptService } from "../service";

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let quitting = false;
  let server: ReturnType<typeof createServer> | undefined;
  let service: PromptService | undefined;
  let status = "Starting local service…";
  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));

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
    ipcMain.handle("client:state", async event => {
      fromWindow(event);
      return { settings: settings.get(), status, capabilities: service ? await service.catalog() : null };
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
        if (!server) { await settings.update(previous); await startServer(); throw new Error("Could not apply connection settings. Previous settings restored."); }
      }
      updateTray();
      return { status };
    });
    ipcMain.handle("client:rotate", async event => { fromWindow(event); service?.cancelAll(); await settings.rotate(); return settings.get().token; });
    ipcMain.handle("client:copy", async event => { fromWindow(event); clipboard.writeText(settings.get().token); });
    ipcMain.handle("client:refresh", async event => { fromWindow(event); return service?.refresh(); });
    window = new BrowserWindow({ width: 760, height: 850, minWidth: 440, minHeight: 560, title: "Story Lens Client", backgroundColor: "#f7f7fb", autoHideMenuBar: true, webPreferences: {
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
  app.on("before-quit", () => { quitting = true; tray?.destroy(); tray = undefined; service?.cancelAll(); void server?.close(); });
}
