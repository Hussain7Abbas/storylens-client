import { z } from "zod";
import { type ApiLanguage, type LookupOption, StoryLensApi } from "../backend/api";
import type { Account } from "../config";
import type { ExecuteOutput, ResponseLanguage } from "../types";
import { ClientError } from "../types";
import { type CharacterRow, hasPendingWork, mergePageCharacters, pendingAliases, pendingVersions, rowNames } from "./merge";
import { fetchWikiPage, normalizeWikiUrl, type WikiPage } from "./page";
import { buildWikiPagePrompt, parseWikiPageResult } from "./prompt";

export type PhaseStatus = "fetching" | "analyzing" | "done" | "error" | "canceled";
/** One crawl phase: a single wiki page fetched, read by the AI, and merged into the table. */
export type CrawlPhase = {
  id: number;
  url: string;
  title?: string;
  status: PhaseStatus;
  /** What this phase extracted, one line per character. */
  found: { name: string; detail: string }[];
  linksAdded: number;
  error?: string;
  durationMs?: number;
};
export type CrawlStatus = "idle" | "preparing" | "running" | "stopping" | "finished" | "stopped" | "error";
export type CrawlSnapshot = {
  status: CrawlStatus;
  message: string;
  startUrl: string;
  novel: { id: string; name: string } | null;
  maxPages: number;
  phases: CrawlPhase[];
  /** Next queued pages; `queued` counts all of them. */
  upcoming: string[];
  queued: number;
  rows: CharacterRow[];
  categories: LookupOption[];
  natures: LookupOption[];
};

export const MAX_PAGES_LIMIT = 200;
export const startSchema = z.object({
  url: z.string().min(1).max(2_000),
  novelId: z.string().uuid().optional(),
  newNovelName: z.string().trim().min(1).max(300).optional(),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(20),
  responseLanguage: z.enum(["en", "ar"]),
  maxPages: z.number().int().min(1).max(MAX_PAGES_LIMIT),
}).strict().refine(value => !!value.novelId !== !!value.newNovelName, "Choose a novel or name a new one.");
export type CrawlStartInput = z.infer<typeof startSchema>;

const versionSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2_000), startingChapter: z.number().int().min(1).max(999_999).nullable() }).strict();
export const rowPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  natureId: z.string().uuid().nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  versions: z.array(versionSchema).max(50).optional(),
}).strict();
export type RowPatch = z.infer<typeof rowPatchSchema>;

export type ExecuteRequest = { prompt: string; model: string; effort: string; responseLanguage: ResponseLanguage };
export type CrawlDependencies = {
  account: () => Account | null;
  execute: (input: ExecuteRequest, signal: AbortSignal) => Promise<ExecuteOutput>;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<WikiPage>;
  api?: (account: Account, language: ApiLanguage) => StoryLensApi;
  onChange: (snapshot: CrawlSnapshot) => void;
  /** Wait between retries while the provider is busy; shortened in tests. */
  busyDelayMs?: number;
};

const BUSY_RETRIES = 60;
const UPCOMING_SHOWN = 8;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

/** Runs one wiki crawl at a time in the main process and keeps its table between window openings. */
export class CrawlSession {
  private status: CrawlStatus = "idle";
  private message = "";
  private startUrl = "";
  private novel: { id: string; name: string; context: string } | null = null;
  private maxPages = 25;
  private phases: CrawlPhase[] = [];
  private queue: string[] = [];
  private readonly visited = new Set<string>();
  private rows: CharacterRow[] = [];
  private existing: Awaited<ReturnType<StoryLensApi["keywords"]>> = [];
  private categories: LookupOption[] = [];
  private natures: LookupOption[] = [];
  private options?: Pick<CrawlStartInput, "model" | "effort" | "responseLanguage">;
  private controller?: AbortController;
  private running?: Promise<void>;
  private keyCounter = 0;
  private unauthorized = false;

  constructor(private readonly deps: CrawlDependencies) {}

  snapshot(): CrawlSnapshot {
    return {
      status: this.status, message: this.message, startUrl: this.startUrl,
      novel: this.novel ? { id: this.novel.id, name: this.novel.name } : null, maxPages: this.maxPages,
      phases: this.phases.map(phase => ({ ...phase, found: [...phase.found] })),
      upcoming: this.queue.slice(0, UPCOMING_SHOWN), queued: this.queue.length,
      rows: this.rows.map(row => ({ ...row, aliases: [...row.aliases], versions: row.versions.map(version => ({ ...version })), sources: [...row.sources], notes: [...row.notes] })),
      categories: this.categories, natures: this.natures,
    };
  }
  isBusy(): boolean { return this.status === "preparing" || this.status === "running" || this.status === "stopping"; }
  private emit(): void { this.deps.onChange(this.snapshot()); }
  /** Names are read and saved in the crawl's response language. */
  private api(): StoryLensApi {
    const account = this.deps.account();
    if (!account) throw new ClientError("NO_ACCOUNT", "Share your Story Lens account first: sign in to the extension, then click Connect / refresh models in Settings → AI.", 409);
    const language = this.options?.responseLanguage ?? "en";
    return (this.deps.api ?? ((value, lang) => new StoryLensApi(value, fetch, lang)))(account, language);
  }

  /** Starts a new crawl, replacing the previous table. Resolves once the crawl is running. */
  async start(input: unknown): Promise<CrawlSnapshot> {
    if (this.isBusy()) throw new ClientError("CRAWL_BUSY", "A crawl is already running.", 409);
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) throw new ClientError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid crawl settings.", 400);
    const startUrl = normalizeWikiUrl(parsed.data.url);
    if (!startUrl) throw new ClientError("BAD_URL", "Use a public http(s) wiki address.", 400);
    this.options = { model: parsed.data.model, effort: parsed.data.effort, responseLanguage: parsed.data.responseLanguage };
    const api = this.api();
    this.status = "preparing"; this.message = "Loading the novel, categories and natures…";
    this.startUrl = startUrl; this.maxPages = parsed.data.maxPages;
    this.phases = []; this.queue = [startUrl]; this.visited.clear(); this.rows = []; this.novel = null;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.emit();
    try {
      const novel = parsed.data.novelId ? (await api.novels(signal)).find(item => item.id === parsed.data.novelId) : await api.createNovel(parsed.data.newNovelName as string, signal);
      if (!novel) throw new ClientError("NOVEL_NOT_FOUND", "The selected novel no longer exists.", 404);
      this.novel = { id: novel.id, name: novel.name, context: novel.context ?? "" };
      [this.categories, this.natures, this.existing] = await Promise.all([api.categories(signal), api.natures(signal), api.keywords(novel.id, signal)]);
      if (!this.categories.length || !this.natures.length) throw new ClientError("NO_LOOKUPS", "The API returned no categories or natures.", 502);
    } catch (error) {
      this.status = signal.aborted ? "stopped" : "error";
      this.message = signal.aborted ? "Crawl stopped." : errorMessage(error);
      this.emit();
      if (signal.aborted) return this.snapshot();
      throw error;
    }
    this.run();
    return this.snapshot();
  }

  /** Crawls more of the remaining queue after a stop or after reaching the page limit. */
  resume(extraPages: unknown): CrawlSnapshot {
    const pages = z.number().int().min(1).max(MAX_PAGES_LIMIT).safeParse(extraPages);
    if (!pages.success) throw new ClientError("INVALID_REQUEST", `Add between 1 and ${MAX_PAGES_LIMIT} pages.`, 400);
    if (this.isBusy()) throw new ClientError("CRAWL_BUSY", "A crawl is already running.", 409);
    if (!this.novel || !this.options || !this.queue.length) throw new ClientError("NOTHING_QUEUED", "No pages are left to crawl. Start a new crawl.", 409);
    this.maxPages = this.visited.size + pages.data;
    this.controller = new AbortController();
    this.run();
    return this.snapshot();
  }

  stop(): void {
    if (!this.isBusy()) return;
    this.status = "stopping"; this.message = "Stopping after canceling the current phase…";
    this.controller?.abort();
    this.emit();
  }

  /** Waits for the running crawl loop; used by tests and shutdown. */
  async settled(): Promise<void> { await this.running; }

  private run(): void {
    this.status = "running"; this.message = "";
    this.emit();
    this.running = this.loop().catch(error => { this.status = "error"; this.message = errorMessage(error); this.emit(); });
  }

  private knownNames(): string[] {
    return [...this.existing.flatMap(keyword => [keyword.name, ...keyword.aliases.map(alias => alias.name)]), ...this.rows.flatMap(rowNames)];
  }

  private async execute(prompt: string, signal: AbortSignal): Promise<string> {
    const options = this.options as NonNullable<typeof this.options>;
    for (let attempt = 0; ; attempt++) {
      try { return (await this.deps.execute({ prompt, ...options }, signal)).output; }
      catch (error) {
        if (!(error instanceof ClientError && error.code === "BUSY") || attempt >= BUSY_RETRIES || signal.aborted) throw error;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, this.deps.busyDelayMs ?? 5_000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
    }
  }

  private async loop(): Promise<void> {
    const signal = (this.controller as AbortController).signal;
    const fetchPage = this.deps.fetchPage ?? ((url: string, pageSignal: AbortSignal) => fetchWikiPage(url, pageSignal));
    const novel = this.novel as NonNullable<typeof this.novel>;
    while (this.queue.length && this.visited.size < this.maxPages && !signal.aborted) {
      const url = this.queue.shift() as string;
      this.visited.add(url);
      const phase: CrawlPhase = { id: this.phases.length + 1, url, status: "fetching", found: [], linksAdded: 0 };
      this.phases.push(phase);
      this.emit();
      const started = Date.now();
      try {
        const page = await fetchPage(url, signal);
        phase.title = page.title;
        if (page.url !== url) {
          if (this.visited.has(page.url)) { phase.status = "done"; phase.error = "Redirected to a page that was already crawled."; continue; }
          this.visited.add(page.url);
        }
        phase.status = "analyzing";
        this.emit();
        const origin = new URL(this.startUrl).origin;
        const links = page.links.filter(link => new URL(link.url).origin === origin && !this.visited.has(link.url) && !this.queue.includes(link.url));
        const knownNames = this.knownNames();
        const lookups = { categories: this.categories, natures: this.natures, links, knownNames };
        const prompt = buildWikiPagePrompt({ novelName: novel.name, novelContext: novel.context, page, links, knownNames, categories: this.categories, natures: this.natures, language: this.options?.responseLanguage ?? "en" });
        let result: ReturnType<typeof parseWikiPageResult>;
        try { result = parseWikiPageResult(await this.execute(prompt, signal), lookups); }
        catch (error) {
          if (error instanceof ClientError || signal.aborted) throw error;
          // One retry for an unreadable answer.
          result = parseWikiPageResult(await this.execute(prompt, signal), lookups);
        }
        let key = 0;
        mergePageCharacters({ rows: this.rows, existing: this.existing, nextKey: () => `${phase.id}-${++key}-${++this.keyCounter}` }, result.characters, page.title);
        for (const link of result.links) if (!this.visited.has(link) && !this.queue.includes(link)) { this.queue.push(link); phase.linksAdded++; }
        phase.found = result.characters.map(character => ({ name: character.name, detail: [
          character.parent ? `${character.parent.relation === "alias" ? "alias" : "version"} of ${character.parent.name}` : "",
          character.aliases.length ? `aliases: ${character.aliases.join(", ")}` : "",
          character.versions.length ? `versions: ${character.versions.map(version => version.name).join(", ")}` : "",
        ].filter(Boolean).join(" · ") }));
        phase.status = "done";
      } catch (error) {
        phase.status = signal.aborted ? "canceled" : "error";
        phase.error = signal.aborted ? "Canceled." : errorMessage(error);
      } finally {
        phase.durationMs = Date.now() - started;
        this.emit();
      }
    }
    if (signal.aborted) { this.status = "stopped"; this.message = this.queue.length ? `Crawl stopped. ${this.queue.length} pages are still queued; continue to crawl them.` : "Crawl stopped."; }
    else if (this.queue.length) { this.status = "finished"; this.message = `Reached the page limit. ${this.queue.length} more pages are queued; continue to crawl them.`; }
    else { this.status = "finished"; this.message = "Crawl finished: no more character pages were found."; }
    this.emit();
  }

  private row(key: string): CharacterRow {
    const row = this.rows.find(item => item.key === key);
    if (!row) throw new ClientError("ROW_NOT_FOUND", "That character is no longer in the table.", 404);
    return row;
  }

  updateRow(key: string, patch: unknown): CrawlSnapshot {
    const parsed = rowPatchSchema.safeParse(patch);
    if (!parsed.success) throw new ClientError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid character.", 400);
    const row = this.row(key);
    if (row.state === "saving") throw new ClientError("ROW_BUSY", "This character is being saved.", 409);
    const value = parsed.data;
    if (value.name !== undefined && !row.keywordId) row.name = value.name;
    if (value.description !== undefined) row.description = value.description;
    if (value.categoryId !== undefined) row.categoryId = value.categoryId ?? undefined;
    if (value.natureId !== undefined) row.natureId = value.natureId ?? undefined;
    if (value.aliases !== undefined) row.aliases = [...new Map(value.aliases.filter(alias => alias.toLowerCase() !== row.name.toLowerCase()).map(alias => [alias.toLowerCase(), alias])).values()];
    if (value.versions !== undefined) row.versions = value.versions;
    if (row.state !== "idle" && hasPendingWork(row)) { row.state = "idle"; row.error = undefined; }
    this.emit();
    return this.snapshot();
  }

  removeRow(key: string): CrawlSnapshot {
    const row = this.row(key);
    if (row.state === "saving") throw new ClientError("ROW_BUSY", "This character is being saved.", 409);
    this.rows.splice(this.rows.indexOf(row), 1);
    this.emit();
    return this.snapshot();
  }

  /** Creates the keyword when needed, then its new aliases and its versions that have a starting chapter. */
  async saveRow(key: string): Promise<CrawlSnapshot> {
    const row = this.row(key);
    if (row.state === "saving") return this.snapshot();
    if (!this.novel) throw new ClientError("NO_NOVEL", "Start a crawl first.", 409);
    if (!row.keywordId && (!row.categoryId || !row.natureId)) {
      row.state = "error"; row.error = "Choose a category and a nature first.";
      this.emit();
      return this.snapshot();
    }
    const api = this.api();
    row.state = "saving"; row.error = undefined;
    this.emit();
    try {
      if (!row.keywordId) {
        const duplicate = this.existing.find(keyword => keyword.name.toLowerCase() === row.name.toLowerCase());
        if (duplicate) throw new ClientError("DUPLICATE", `“${row.name}” already exists in this novel. Rename it or remove this row.`, 409);
        const keyword = await api.createKeyword({ novelId: this.novel.id, name: row.name, description: row.description || undefined, categoryId: row.categoryId as string, natureId: row.natureId as string });
        row.keywordId = keyword.id;
        row.savedNames = [row.name.toLowerCase()];
        row.savedChapters = keyword.versions.map(version => version.startingChapter);
        this.existing.push(keyword);
      }
      for (const alias of pendingAliases(row)) {
        await api.createAlias({ keywordId: row.keywordId, name: alias });
        row.savedNames.push(alias.toLowerCase());
      }
      const versions = pendingVersions(row).filter(version => version.startingChapter !== null).sort((a, b) => (a.startingChapter as number) - (b.startingChapter as number));
      for (const version of versions) {
        const chapter = version.startingChapter as number;
        if (chapter <= Math.max(0, ...row.savedChapters)) continue;
        await api.createVersion({ keywordId: row.keywordId, currentChapter: chapter, description: [version.name, version.description].filter(Boolean).join(" — ") || undefined });
        row.savedChapters.push(chapter);
      }
      const unsaved = pendingVersions(row).filter(version => version.startingChapter === null);
      row.notes = row.notes.filter(note => !note.startsWith("Set a starting chapter"));
      if (unsaved.length) row.notes.push(`Set a starting chapter to save ${unsaved.map(version => `“${version.name}”`).join(", ")}.`);
      row.state = unsaved.length ? "idle" : "saved";
    } catch (error) {
      row.state = "error";
      row.error = errorMessage(error);
      if (error instanceof ClientError && error.code === "API_UNAUTHORIZED") this.unauthorized = true;
    }
    this.emit();
    return this.snapshot();
  }

  /** Saves every row that has a category and a nature and still has something to save, one at a time. */
  async saveAll(): Promise<CrawlSnapshot> {
    this.unauthorized = false;
    for (const row of [...this.rows]) {
      if (!this.rows.includes(row) || row.state === "saving" || !hasPendingWork(row)) continue;
      if (!row.keywordId && (!row.categoryId || !row.natureId)) continue;
      await this.saveRow(row.key);
      // An expired session fails every row the same way.
      if (this.unauthorized) break;
    }
    return this.snapshot();
  }

  /** Clears the finished crawl and its table. */
  reset(): CrawlSnapshot {
    if (this.isBusy()) throw new ClientError("CRAWL_BUSY", "Stop the crawl first.", 409);
    this.status = "idle"; this.message = ""; this.phases = []; this.queue = []; this.visited.clear(); this.rows = []; this.novel = null; this.startUrl = "";
    this.emit();
    return this.snapshot();
  }

  cancel(): void { this.controller?.abort(); }
}
