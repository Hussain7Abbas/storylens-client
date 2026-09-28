import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("storyLensClient", {
  state: () => ipcRenderer.invoke("client:state"),
  save: (settings: { port: number; claudePath: string; codexPath: string; keepInSystemTray: boolean }) => ipcRenderer.invoke("client:save", settings),
  rotate: () => ipcRenderer.invoke("client:rotate"),
  copyToken: () => ipcRenderer.invoke("client:copy"),
  refresh: () => ipcRenderer.invoke("client:refresh"),
  onChange: (callback: () => void) => { ipcRenderer.on("client:changed", callback); },
  crawl: {
    state: () => ipcRenderer.invoke("crawl:state"),
    novels: () => ipcRenderer.invoke("crawl:novels"),
    start: (input: unknown) => ipcRenderer.invoke("crawl:start", input),
    stop: () => ipcRenderer.invoke("crawl:stop"),
    resume: (pages: number) => ipcRenderer.invoke("crawl:resume", pages),
    update: (key: string, patch: unknown) => ipcRenderer.invoke("crawl:update", key, patch),
    remove: (key: string) => ipcRenderer.invoke("crawl:remove", key),
    save: (key: string) => ipcRenderer.invoke("crawl:save", key),
    saveAll: () => ipcRenderer.invoke("crawl:saveAll"),
    reset: () => ipcRenderer.invoke("crawl:reset"),
    // Only the snapshot is forwarded, never the Electron event.
    onChange: (callback: (snapshot: unknown) => void) => { ipcRenderer.on("crawl:changed", (_event, snapshot: unknown) => callback(snapshot)); },
  },
});
