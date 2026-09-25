import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("storyLensClient", {
  state: () => ipcRenderer.invoke("client:state"),
  save: (settings: { port: number; claudePath: string; codexPath: string }) => ipcRenderer.invoke("client:save", settings),
  rotate: () => ipcRenderer.invoke("client:rotate"),
  copyToken: () => ipcRenderer.invoke("client:copy"),
  refresh: () => ipcRenderer.invoke("client:refresh"),
  onChange: (callback: () => void) => { ipcRenderer.on("client:changed", callback); },
});
