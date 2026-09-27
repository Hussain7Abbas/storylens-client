import { Cable, Copy, createElement, type IconNode, ListFilter, RefreshCw, RotateCw, Save, Settings2 } from "lucide";
import type { Settings } from "../config";
import type { Capabilities } from "../types";

type EditableSettings = Pick<Settings, "port" | "claudePath" | "codexPath" | "keepInSystemTray">;
type State = { settings: Settings; status: string; capabilities: Capabilities | null };
declare global {
  interface Window { storyLensClient: {
    state(): Promise<State>;
    save(value: EditableSettings): Promise<unknown>;
    rotate(): Promise<string>;
    copyToken(): Promise<void>;
    refresh(): Promise<Capabilities>;
    onChange(callback: () => void): void;
  } }
}
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element ${id}`);
  return element as T;
};
const icons: Record<string, IconNode> = { connection: Cable, copy: Copy, rotate: RotateCw, settings: Settings2, save: Save, providers: ListFilter, refresh: RefreshCw };
for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-icon]"))) {
  const icon = icons[element.dataset.icon ?? ""];
  if (icon) element.append(createElement(icon, { "aria-hidden": "true", "stroke-width": 1.75 }));
}
const theme = byId<HTMLSelectElement>("theme");
const colorPreference = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value === "system" ? (colorPreference.matches ? "dark" : "light") : theme.value;
}
try {
  const saved = localStorage.getItem("storylens-client-theme");
  if (saved && ["system", "light", "dark"].includes(saved)) theme.value = saved;
} catch {}
applyTheme();
colorPreference.addEventListener("change", applyTheme);
theme.addEventListener("change", () => { applyTheme(); try { localStorage.setItem("storylens-client-theme", theme.value); } catch {} });
const message = byId<HTMLElement>("message");
const form = byId<HTMLFormElement>("settings");
let dirty = false;
form.addEventListener("input", () => { dirty = true; });
async function render(): Promise<void> {
  const state = await window.storyLensClient.state();
  const status = byId<HTMLElement>("status");
  status.textContent = state.status;
  status.dataset.ready = String(state.status.startsWith("Listening"));
  byId<HTMLInputElement>("token").value = state.settings.token;
  if (!dirty) {
    byId<HTMLInputElement>("port").value = String(state.settings.port);
    byId<HTMLInputElement>("claudePath").value = state.settings.claudePath;
    byId<HTMLInputElement>("codexPath").value = state.settings.codexPath;
    byId<HTMLInputElement>("keepInSystemTray").checked = state.settings.keepInSystemTray;
  }
  const providers = byId<HTMLElement>("providers");
  providers.replaceChildren();
  for (const provider of state.capabilities?.providers ?? []) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    heading.className = "provider-name";
    const name = document.createElement("span");
    name.textContent = provider.provider === "claude" ? "Claude Code" : "Codex";
    const badge = document.createElement("span");
    badge.className = "provider-state";
    badge.dataset.ready = String(provider.available);
    badge.textContent = provider.available ? "Ready" : "Unavailable";
    heading.append(name, badge);
    item.append(heading);
    if (!provider.available && provider.error) {
      const error = document.createElement("p");
      error.className = "provider-error";
      error.textContent = provider.error;
      item.append(error);
    }
    providers.append(item);
  }
  byId<HTMLElement>("modelCount").textContent = `${state.capabilities?.models.length ?? 0} models available · Choose a model in the extension’s AI settings.`;
}
async function runAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  message.dataset.error = "false";
  try { await action(); }
  catch (error) { message.dataset.error = "true"; message.textContent = error instanceof Error ? error.message : "Could not complete this action."; }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  void runAction(byId<HTMLButtonElement>("save"), async () => {
    await window.storyLensClient.save({ port: Number(byId<HTMLInputElement>("port").value), claudePath: byId<HTMLInputElement>("claudePath").value, codexPath: byId<HTMLInputElement>("codexPath").value, keepInSystemTray: byId<HTMLInputElement>("keepInSystemTray").checked });
    dirty = false;
    message.textContent = "Settings saved.";
    await render();
  });
});
byId<HTMLButtonElement>("copy").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { await window.storyLensClient.copyToken(); message.textContent = "Pairing token copied."; }); });
byId<HTMLButtonElement>("rotate").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { await window.storyLensClient.rotate(); message.textContent = "Pairing token changed. Update the extension settings."; await render(); }); });
byId<HTMLButtonElement>("refresh").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { await window.storyLensClient.refresh(); await render(); message.textContent = "Provider models refreshed."; }); });
window.storyLensClient.onChange(() => { void render().catch(() => { message.dataset.error = "true"; message.textContent = "Could not refresh client status."; }); });
void render().catch(() => { message.dataset.error = "true"; message.textContent = "Could not load client settings."; });
