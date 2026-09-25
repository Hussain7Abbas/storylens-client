import type { Capabilities } from "../types";

type State = { settings: { token: string; port: number; claudePath: string; codexPath: string }; status: string; capabilities: Capabilities | null };
declare global {
  interface Window { storyLensClient: {
    state(): Promise<State>;
    save(value: { port: number; claudePath: string; codexPath: string }): Promise<unknown>;
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
const message = byId<HTMLElement>("message");
async function render(): Promise<void> {
  const state = await window.storyLensClient.state();
  byId<HTMLElement>("status").textContent = state.status;
  byId<HTMLInputElement>("token").value = state.settings.token;
  byId<HTMLInputElement>("port").value = String(state.settings.port);
  byId<HTMLInputElement>("claudePath").value = state.settings.claudePath;
  byId<HTMLInputElement>("codexPath").value = state.settings.codexPath;
  const providers = byId<HTMLElement>("providers");
  providers.replaceChildren();
  for (const provider of state.capabilities?.providers ?? []) {
    const item = document.createElement("li");
    item.textContent = `${provider.provider}: ${provider.available ? "ready" : provider.error ?? "unavailable"}`;
    providers.append(item);
  }
  byId<HTMLElement>("modelCount").textContent = `${state.capabilities?.models.length ?? 0} models available`;
}
byId<HTMLFormElement>("settings").addEventListener("submit", event => {
  event.preventDefault();
  void window.storyLensClient.save({ port: Number(byId<HTMLInputElement>("port").value), claudePath: byId<HTMLInputElement>("claudePath").value, codexPath: byId<HTMLInputElement>("codexPath").value })
    .then(() => { message.textContent = "Settings saved."; return render(); })
    .catch(error => { message.textContent = error instanceof Error ? error.message : "Could not save settings."; });
});
byId<HTMLButtonElement>("copy").addEventListener("click", () => { void window.storyLensClient.copyToken().then(() => { message.textContent = "Pairing token copied."; }); });
byId<HTMLButtonElement>("rotate").addEventListener("click", () => { void window.storyLensClient.rotate().then(() => { message.textContent = "Pairing token changed. Update the extension settings."; return render(); }); });
byId<HTMLButtonElement>("refresh").addEventListener("click", () => { void window.storyLensClient.refresh().then(render); });
window.storyLensClient.onChange(() => { void render(); });
void render();
