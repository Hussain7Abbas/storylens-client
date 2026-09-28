import { Cable, Copy, createElement, Eraser, Globe, type IconNode, ListFilter, ListOrdered, Play, RefreshCw, RotateCw, Save, Settings2, Square, Users } from "lucide";
import type { Settings } from "../config";
import type { CharacterRow } from "../crawl/merge";
import type { CrawlSnapshot, RowPatch } from "../crawl/session";
import type { Capabilities } from "../types";

type EditableSettings = Pick<Settings, "port" | "claudePath" | "codexPath" | "keepInSystemTray">;
type State = { settings: Omit<Settings, "account">; account: { apiUrl: string } | null; status: string; capabilities: Capabilities | null };
type NovelOption = { id: string; name: string };
declare global {
  interface Window { storyLensClient: {
    state(): Promise<State>;
    save(value: EditableSettings): Promise<unknown>;
    rotate(): Promise<string>;
    copyToken(): Promise<void>;
    refresh(): Promise<Capabilities>;
    onChange(callback: () => void): void;
    crawl: {
      state(): Promise<CrawlSnapshot>;
      novels(): Promise<NovelOption[]>;
      start(input: unknown): Promise<CrawlSnapshot>;
      stop(): Promise<CrawlSnapshot>;
      resume(pages: number): Promise<CrawlSnapshot>;
      update(key: string, patch: RowPatch): Promise<CrawlSnapshot>;
      remove(key: string): Promise<CrawlSnapshot>;
      save(key: string): Promise<CrawlSnapshot>;
      saveAll(): Promise<CrawlSnapshot>;
      reset(): Promise<CrawlSnapshot>;
      onChange(callback: (snapshot: CrawlSnapshot) => void): void;
    };
  } }
}
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element ${id}`);
  return element as T;
};
const icons: Record<string, IconNode> = { connection: Cable, copy: Copy, rotate: RotateCw, settings: Settings2, save: Save, providers: ListFilter, refresh: RefreshCw, crawl: Globe, play: Play, stop: Square, phases: ListOrdered, characters: Users, clear: Eraser };
function addIcons(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-icon]"))) {
    const icon = icons[element.dataset.icon ?? ""];
    if (icon && !element.firstChild) element.append(createElement(icon, { "aria-hidden": "true", "stroke-width": 1.75 }));
  }
}
addIcons(document);
function readStored(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function store(key: string, value: string): void { try { localStorage.setItem(key, value); } catch {} }
/** IPC errors arrive wrapped as "Error invoking remote method …: Error: message". */
function errorText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : fallback;
  return text.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "") || fallback;
}

const theme = byId<HTMLSelectElement>("theme");
const colorPreference = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value === "system" ? (colorPreference.matches ? "dark" : "light") : theme.value;
}
const savedTheme = readStored("storylens-client-theme");
if (savedTheme && ["system", "light", "dark"].includes(savedTheme)) theme.value = savedTheme;
applyTheme();
colorPreference.addEventListener("change", applyTheme);
theme.addEventListener("change", () => { applyTheme(); store("storylens-client-theme", theme.value); });

// Tabs: Settings and Crawling.
const tabs = [byId<HTMLButtonElement>("tab-settings"), byId<HTMLButtonElement>("tab-crawl")];
function selectTab(tab: HTMLButtonElement, focus = false): void {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    byId(item.getAttribute("aria-controls") ?? "").hidden = !selected;
  }
  if (focus) tab.focus();
  store("storylens-client-tab", tab.id);
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    selectTab(tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length], true);
  });
}
selectTab(tabs.find(tab => tab.id === readStored("storylens-client-tab")) ?? tabs[0]);

const message = byId<HTMLElement>("message");
const form = byId<HTMLFormElement>("settings");
let dirty = false;
let lastState: State | undefined;
form.addEventListener("input", () => { dirty = true; });
async function render(): Promise<void> {
  const state = await window.storyLensClient.state();
  const previousAccount = lastState?.account?.apiUrl;
  lastState = state;
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
  renderAccount(state);
  renderModels(state);
  if (state.account?.apiUrl !== previousAccount) void loadNovels();
}
async function runAction(button: HTMLButtonElement, action: () => Promise<void>, output: HTMLElement = message): Promise<void> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  output.dataset.error = "false";
  try { await action(); }
  catch (error) { output.dataset.error = "true"; output.dataset.state = "error"; output.textContent = errorText(error, "Could not complete this action."); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); if (crawlSnapshot) renderCrawlControls(crawlSnapshot); }
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

// Crawling tab.
const crawlApi = window.storyLensClient.crawl;
const crawlForm = byId<HTMLFormElement>("crawlForm");
const crawlStatus = byId<HTMLElement>("crawlStatus");
const novelSelect = byId<HTMLSelectElement>("novel");
const modelSelect = byId<HTMLSelectElement>("crawlModel");
const effortSelect = byId<HTMLSelectElement>("crawlEffort");
const languageSelect = byId<HTMLSelectElement>("crawlLanguage");
const newNovelField = byId<HTMLElement>("newNovelField");
const NEW_NOVEL = "__new__";
let crawlSnapshot: CrawlSnapshot | undefined;

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}
function renderAccount(state: State): void {
  const account = byId<HTMLElement>("accountStatus");
  account.dataset.ready = String(!!state.account);
  account.textContent = state.account
    ? `Story Lens account shared by the extension (${new URL(state.account.apiUrl).host}).`
    : "No Story Lens account yet. Sign in to the extension, then click Connect / refresh models in its Settings → AI to share your account with this app.";
}
function renderModels(state: State): void {
  const models = state.capabilities?.models ?? [];
  const wanted = modelSelect.value || readStored("storylens-client-crawl-model") || "";
  modelSelect.replaceChildren(...models.map(model => option(model.id, `${model.label} · ${model.provider === "claude" ? "Claude Code" : "Codex"}`)));
  if (!models.length) modelSelect.append(option("", "No models — refresh providers in Settings"));
  modelSelect.value = models.some(model => model.id === wanted) ? wanted : (models[0]?.id ?? "");
  renderEfforts(state);
}
function renderEfforts(state: State | undefined = lastState): void {
  const model = state?.capabilities?.models.find(item => item.id === modelSelect.value);
  const wanted = effortSelect.value || readStored("storylens-client-crawl-effort") || "";
  effortSelect.replaceChildren(...(model?.efforts ?? []).map(effort => option(effort, effort)));
  effortSelect.value = model?.efforts.includes(wanted) ? wanted : (model?.defaultEffort ?? "");
}
modelSelect.addEventListener("change", () => { store("storylens-client-crawl-model", modelSelect.value); renderEfforts(); });
effortSelect.addEventListener("change", () => store("storylens-client-crawl-effort", effortSelect.value));
languageSelect.value = readStored("storylens-client-crawl-language") === "ar" ? "ar" : "en";
languageSelect.addEventListener("change", () => store("storylens-client-crawl-language", languageSelect.value));
novelSelect.addEventListener("change", () => { newNovelField.hidden = novelSelect.value !== NEW_NOVEL; byId<HTMLInputElement>("newNovelName").required = novelSelect.value === NEW_NOVEL; });

async function loadNovels(): Promise<void> {
  const wanted = novelSelect.value || crawlSnapshot?.novel?.id || "";
  let novels: NovelOption[] = [];
  try { novels = await crawlApi.novels(); }
  catch (error) { crawlStatus.dataset.state = "error"; crawlStatus.textContent = errorText(error, "Could not load your novels."); }
  novelSelect.replaceChildren(option("", lastState?.account ? "Select a novel…" : "Share your account first"), ...novels.map(novel => option(novel.id, novel.name)), option(NEW_NOVEL, "+ Create a new novel…"));
  novelSelect.value = wanted === NEW_NOVEL || novels.some(novel => novel.id === wanted) ? wanted : "";
  newNovelField.hidden = novelSelect.value !== NEW_NOVEL;
}

crawlForm.addEventListener("submit", event => {
  event.preventDefault();
  void runAction(byId<HTMLButtonElement>("startCrawl"), async () => {
    if (crawlSnapshot?.rows.some(row => row.state !== "saved") && !confirm("Start a new crawl? The current table and its unsaved characters are cleared.")) return;
    const newNovel = novelSelect.value === NEW_NOVEL;
    crawlStatus.dataset.state = "running";
    crawlStatus.textContent = "Starting…";
    renderCrawl(await crawlApi.start({
      url: byId<HTMLInputElement>("wikiUrl").value,
      ...(newNovel ? { newNovelName: byId<HTMLInputElement>("newNovelName").value } : { novelId: novelSelect.value || undefined }),
      model: modelSelect.value, effort: effortSelect.value, responseLanguage: languageSelect.value, maxPages: Number(byId<HTMLInputElement>("maxPages").value),
    }));
    if (newNovel) { byId<HTMLInputElement>("newNovelName").value = ""; await loadNovels(); if (crawlSnapshot?.novel) { novelSelect.value = crawlSnapshot.novel.id; newNovelField.hidden = true; } }
  }, crawlStatus);
});
byId<HTMLButtonElement>("stopCrawl").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { renderCrawl(await crawlApi.stop()); }, crawlStatus); });
byId<HTMLButtonElement>("resumeCrawl").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { renderCrawl(await crawlApi.resume(Number(byId<HTMLInputElement>("maxPages").value))); }, crawlStatus); });
byId<HTMLButtonElement>("reloadNovels").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, loadNovels, crawlStatus); });
byId<HTMLButtonElement>("saveAll").addEventListener("click", event => { void runAction(event.currentTarget as HTMLButtonElement, async () => { renderCrawl(await crawlApi.saveAll()); }, crawlStatus); });
byId<HTMLButtonElement>("resetCrawl").addEventListener("click", event => {
  if (crawlSnapshot?.rows.some(row => row.state !== "saved") && !confirm("Clear the phases and the table? Unsaved characters are lost.")) return;
  void runAction(event.currentTarget as HTMLButtonElement, async () => { renderCrawl(await crawlApi.reset()); }, crawlStatus);
});

const busy = (snapshot: CrawlSnapshot) => snapshot.status === "preparing" || snapshot.status === "running" || snapshot.status === "stopping";
function renderCrawlControls(snapshot: CrawlSnapshot): void {
  const running = busy(snapshot);
  byId<HTMLButtonElement>("startCrawl").disabled = running || !lastState?.account;
  byId<HTMLButtonElement>("stopCrawl").hidden = !running;
  byId<HTMLButtonElement>("resumeCrawl").hidden = running || !snapshot.queued || !snapshot.novel;
  byId<HTMLButtonElement>("resetCrawl").disabled = running || (!snapshot.phases.length && !snapshot.rows.length);
  byId<HTMLButtonElement>("saveAll").disabled = !snapshot.rows.length || !lastState?.account;
  for (const field of Array.from(crawlForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))) field.disabled = running;
}

const PHASE_LABEL: Record<string, string> = { fetching: "Downloading", analyzing: "Reading with AI", done: "Done", error: "Failed", canceled: "Canceled" };
function renderPhases(snapshot: CrawlSnapshot): void {
  const list = byId<HTMLOListElement>("phases");
  list.replaceChildren(...snapshot.phases.map(phase => {
    const item = document.createElement("li");
    item.className = "phase";
    const head = document.createElement("div");
    head.className = "phase-head";
    const title = document.createElement("div");
    const name = document.createElement("div");
    name.className = "phase-title";
    name.textContent = `${phase.id}. ${phase.title ?? "Loading page…"}`;
    const url = document.createElement("div");
    url.className = "phase-url";
    url.textContent = phase.url;
    title.append(name, url);
    const state = document.createElement("span");
    state.className = "phase-state";
    state.dataset.state = phase.status;
    state.textContent = `${PHASE_LABEL[phase.status] ?? phase.status}${phase.durationMs !== undefined && phase.status !== "fetching" && phase.status !== "analyzing" ? ` · ${Math.round(phase.durationMs / 1000)} s` : ""}`;
    head.append(title, state);
    item.append(head);
    if (phase.status === "done") {
      const found = document.createElement("ul");
      found.className = "phase-found";
      if (!phase.found.length) { const none = document.createElement("li"); none.textContent = "No characters on this page."; found.append(none); }
      for (const character of phase.found) {
        const line = document.createElement("li");
        line.append(document.createTextNode(character.name));
        if (character.detail) { const detail = document.createElement("span"); detail.textContent = ` — ${character.detail}`; line.append(detail); }
        found.append(line);
      }
      if (phase.linksAdded) { const links = document.createElement("li"); links.textContent = `Queued ${phase.linksAdded} linked page${phase.linksAdded === 1 ? "" : "s"}.`; found.append(links); }
      item.append(found);
    }
    if (phase.error) { const error = document.createElement("p"); error.className = "phase-error"; error.textContent = phase.error; item.append(error); }
    return item;
  }));
  const done = snapshot.phases.filter(phase => phase.status === "done").length;
  byId<HTMLElement>("phaseSummary").textContent = snapshot.phases.length ? `${snapshot.phases.length} phase${snapshot.phases.length === 1 ? "" : "s"} for ${snapshot.novel?.name ?? "this novel"} · ${done} done · page limit ${snapshot.maxPages}` : "No crawl yet.";
  byId<HTMLElement>("upcoming").textContent = snapshot.queued ? `Queued next (${snapshot.queued}): ${snapshot.upcoming.map(url => decodeURIComponent(new URL(url).pathname.split("/").pop() ?? url).replace(/_/g, " ")).join(", ")}${snapshot.queued > snapshot.upcoming.length ? ", …" : ""}` : "";
}

function lookupLabel(item: { nameEn: string | null; nameAr: string | null }): string { return item.nameEn || item.nameAr || "(unnamed)"; }
function lookupSelect(label: string, items: CrawlSnapshot["categories"], value: string | undefined, disabled: boolean, onChange: (value: string | null) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  select.append(option("", `Choose ${label.toLowerCase()}…`), ...items.map(item => option(item.id, lookupLabel(item))));
  select.value = value ?? "";
  select.disabled = disabled;
  select.addEventListener("change", () => onChange(select.value || null));
  return select;
}
function update(key: string, patch: RowPatch): void {
  crawlApi.update(key, patch).then(renderCrawl).catch(error => { crawlStatus.dataset.state = "error"; crawlStatus.textContent = errorText(error, "Could not update this character."); });
}
function cell(className: string, ...children: (Node | string)[]): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  td.append(...children);
  return td;
}
function meta(text: string, className = "row-meta"): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  return paragraph;
}

function characterRow(row: CharacterRow, snapshot: CrawlSnapshot): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.key = row.key;
  const locked = row.state === "saving";
  const name = document.createElement("input");
  name.value = row.name;
  name.setAttribute("aria-label", "Name");
  name.disabled = locked || !!row.keywordId;
  name.addEventListener("change", () => { if (name.value.trim()) update(row.key, { name: name.value }); });
  const nameCell = cell("col-name");
  if (row.state === "saved") { const badge = document.createElement("span"); badge.className = "badge"; badge.dataset.kind = "saved"; badge.textContent = "Saved"; nameCell.append(badge); }
  else if (row.keywordId) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "In novel"; nameCell.append(badge); }
  nameCell.append(name);
  if (row.sources.length) nameCell.append(meta(`From: ${row.sources.join(", ")}`));

  const description = document.createElement("textarea");
  description.value = row.description;
  description.setAttribute("aria-label", "Description");
  description.disabled = locked;
  description.addEventListener("change", () => update(row.key, { description: description.value }));
  const descriptionCell = cell("col-desc", description, ...row.notes.map(note => meta(note)));

  const aliases = document.createElement("input");
  aliases.value = row.aliases.join(", ");
  aliases.setAttribute("aria-label", "Aliases, comma-separated");
  aliases.placeholder = "None";
  aliases.disabled = locked;
  aliases.addEventListener("change", () => update(row.key, { aliases: aliases.value.split(",").map(alias => alias.trim()).filter(Boolean) }));
  const newAliases = row.aliases.filter(alias => !row.savedNames.includes(alias.trim().toLowerCase())).length;
  const aliasCell = cell("col-aliases", aliases);
  if (row.keywordId && newAliases) aliasCell.append(meta(`${newAliases} new to save`));

  const versionCell = cell("col-versions");
  if (!row.versions.length) versionCell.append(meta("None"));
  const latestSaved = Math.max(0, ...row.savedChapters);
  row.versions.forEach((version, index) => {
    const box = document.createElement("div");
    box.className = "version";
    const label = document.createElement("input");
    label.value = version.name;
    label.setAttribute("aria-label", "Version label");
    label.disabled = locked;
    const chapter = document.createElement("input");
    chapter.type = "number";
    chapter.min = "1";
    chapter.placeholder = "Ch.";
    chapter.title = "Starting chapter";
    chapter.setAttribute("aria-label", `Starting chapter of ${version.name}`);
    chapter.value = version.startingChapter === null ? "" : String(version.startingChapter);
    chapter.disabled = locked;
    const commit = () => {
      const number = Number(chapter.value);
      const versions = row.versions.map((item, position) => position === index ? { ...item, name: label.value.trim() || item.name, startingChapter: chapter.value && Number.isInteger(number) && number >= 1 ? number : null } : item);
      update(row.key, { versions });
    };
    label.addEventListener("change", commit);
    chapter.addEventListener("change", commit);
    box.append(label, chapter);
    if (version.description) { const text = document.createElement("p"); text.textContent = version.description; box.append(text); }
    if (version.startingChapter !== null && version.startingChapter <= latestSaved && row.keywordId) box.append(meta("Saved or before a saved version."));
    versionCell.append(box);
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = row.state === "saving" ? "Saving…" : row.keywordId ? "Save changes" : "Save";
  save.title = row.keywordId ? "Add this character's new aliases and dated versions" : "Add this character to the novel with its aliases and dated versions";
  save.disabled = locked || row.state === "saved" || !lastState?.account;
  save.addEventListener("click", () => { void runAction(save, async () => { renderCrawl(await crawlApi.save(row.key)); }, crawlStatus); });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Remove";
  remove.title = "Remove this row from the table (nothing is deleted from the novel)";
  remove.disabled = locked;
  remove.addEventListener("click", () => { void runAction(remove, async () => { renderCrawl(await crawlApi.remove(row.key)); }, crawlStatus); });
  actions.append(save, remove);
  const actionCell = cell("col-actions", actions);
  if (row.error) actionCell.append(meta(row.error, "row-error"));

  // An existing keyword keeps its stored category and nature; saving only adds aliases and versions.
  const lookupDisabled = locked || !!row.keywordId;
  tr.append(nameCell, descriptionCell,
    cell("col-lookup", lookupSelect("Category", snapshot.categories, row.categoryId, lookupDisabled, value => update(row.key, { categoryId: value }))),
    cell("col-lookup", lookupSelect("Nature", snapshot.natures, row.natureId, lookupDisabled, value => update(row.key, { natureId: value }))),
    aliasCell, versionCell, actionCell);
  return tr;
}

/** Re-renders changed rows only, and never the row being edited, so typing is not interrupted. */
function renderCharacters(snapshot: CrawlSnapshot): void {
  const body = byId<HTMLTableElement>("characters").tBodies[0];
  const current = new Map<string, HTMLTableRowElement>();
  for (let index = 0; index < body.rows.length; index++) current.set(body.rows[index].dataset.key ?? "", body.rows[index]);
  const lookups = `${snapshot.categories.length}:${snapshot.natures.length}:${!!lastState?.account}`;
  let previous: HTMLTableRowElement | null = null;
  for (const row of snapshot.rows) {
    const signature = `${lookups}|${JSON.stringify(row)}`;
    let tr = current.get(row.key);
    current.delete(row.key);
    if (!tr || (tr.dataset.signature !== signature && !tr.contains(document.activeElement))) {
      const next = characterRow(row, snapshot);
      next.dataset.signature = signature;
      if (tr) tr.replaceWith(next);
      tr = next;
    }
    if (previous ? previous.nextSibling !== tr : body.firstChild !== tr) previous ? previous.after(tr) : body.prepend(tr);
    previous = tr;
  }
  for (const stale of current.values()) stale.remove();
  const saved = snapshot.rows.filter(row => row.state === "saved").length;
  const missing = snapshot.rows.filter(row => !row.keywordId && (!row.categoryId || !row.natureId)).length;
  byId<HTMLElement>("characterSummary").textContent = snapshot.rows.length
    ? `${snapshot.rows.length} characters · ${saved} saved${missing ? ` · ${missing} need a category and a nature before saving` : ""}. Aliases are comma-separated; a version is saved once it has a starting chapter.`
    : "Characters appear here as each phase finishes. Edit any cell, then save a row to add it to the novel. Aliases are comma-separated; a version is saved once it has a starting chapter.";
}

function renderCrawl(snapshot: CrawlSnapshot): void {
  crawlSnapshot = snapshot;
  const running = busy(snapshot);
  crawlStatus.dataset.state = snapshot.status === "error" ? "error" : running ? "running" : "idle";
  const active = snapshot.phases.at(-1);
  crawlStatus.textContent = snapshot.message || (snapshot.status === "running" && active ? `Phase ${active.id}: ${PHASE_LABEL[active.status] ?? active.status} ${active.title ?? active.url}` : "");
  if (snapshot.startUrl && !byId<HTMLInputElement>("wikiUrl").value) byId<HTMLInputElement>("wikiUrl").value = snapshot.startUrl;
  if (snapshot.novel && !novelSelect.value && Array.from(novelSelect.options).some(item => item.value === snapshot.novel?.id)) novelSelect.value = snapshot.novel.id;
  renderCrawlControls(snapshot);
  renderPhases(snapshot);
  renderCharacters(snapshot);
}
crawlApi.onChange(snapshot => renderCrawl(snapshot));

window.storyLensClient.onChange(() => { void render().catch(() => { message.dataset.error = "true"; message.textContent = "Could not refresh client status."; }); });
void render().then(() => crawlApi.state()).then(renderCrawl).catch(() => { message.dataset.error = "true"; message.textContent = "Could not load client settings."; });
