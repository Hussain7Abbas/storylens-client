import type { Account } from "../config";
import { ClientError } from "../types";
import { CLIENT_VERSION } from "../version";

export type LookupOption = { id: string; nameEn: string | null; nameAr: string | null; description: string | null };
export type NovelSummary = { id: string; name: string; context: string | null };
export type ExistingKeyword = {
  id: string;
  name: string;
  aliases: { name: string }[];
  versions: { startingChapter: number }[];
};
export type NewKeyword = { novelId: string; name: string; description?: string; categoryId: string; natureId: string };
export type NewAlias = { keywordId: string; name: string; description?: string };
export type NewVersion = { keywordId: string; description?: string; currentChapter: number };

/** Novel and keyword names are stored per language; the API only lists those named in `Accept-Language`. */
export type ApiLanguage = "en" | "ar";
type TranslatedName = { nameAr: string | null; nameEn: string | null };
type ApiNovel = TranslatedName & { id: string; context: string | null };
/** Aliases are named per language (`nameAr`/`nameEn`), like keywords. */
type ApiAlias = TranslatedName;
type ApiKeyword = TranslatedName & { id: string; aliases: ApiAlias[]; versions: { startingChapter: number }[] };

/** Every distinct name of an alias, so a translated alias counts as already stored. */
export function aliasNamesOf(alias: ApiAlias): string[] {
  return [...new Set([alias.nameAr, alias.nameEn].filter((name): name is string => !!name?.trim()))];
}

/** An API failure; `apiCode` is the API's machine-readable reason (`KEYWORD_NAME_TAKEN`, …). */
export class ApiError extends ClientError {
  constructor(message: string, status: number, public readonly apiCode?: string) {
    super("API_ERROR", message, status);
  }
}

function isApiCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.apiCode === code;
}

type Query = Record<string, string | number | Record<string, string | number | undefined> | undefined>;
type Page<T> = { data: T[]; total: number };

const PAGE_SIZE = 200;
/** Stops runaway pagination on a misbehaving server. */
const MAX_ITEMS = 20_000;
const TIMEOUT_MS = 30_000;
/** Reader API prefix; the shared `apiUrl` is the API origin. */
export const USER_API_PREFIX = "/api/user";
/** Lets the API refuse client releases it no longer supports (426 Upgrade Required). */
export const CLIENT_VERSION_HEADER = "X-Client-Version";

/** Encodes nested objects as `key[field]=value`, the form the extension's Axios client sends and the API parses. */
export function encodeQuery(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === "object") {
      for (const [field, nested] of Object.entries(value)) if (nested !== undefined) params.append(`${key}[${field}]`, String(nested));
    } else params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Story Lens API client for the session the extension shared. Runs in the main process only. */
export class StoryLensApi {
  constructor(private readonly account: Account, private readonly fetchImpl: typeof fetch = fetch, private readonly language: ApiLanguage = "en") {}

  private get nameField(): "nameAr" | "nameEn" { return this.language === "ar" ? "nameAr" : "nameEn"; }
  private nameOf(item: TranslatedName): string { return item[this.nameField] ?? item.nameAr ?? item.nameEn ?? ""; }
  private toKeyword(keyword: ApiKeyword): ExistingKeyword {
    return { id: keyword.id, name: this.nameOf(keyword), aliases: keyword.aliases.flatMap(alias => aliasNamesOf(alias).map(name => ({ name }))), versions: keyword.versions.map(version => ({ startingChapter: version.startingChapter })) };
  }

  private async request<T>(method: "GET" | "POST", path: string, options: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = `${this.account.apiUrl.replace(/\/+$/, "")}${USER_API_PREFIX}${path}${encodeQuery(options.query ?? {})}`;
    const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.account.token}`, Accept: "application/json", "Accept-Language": this.language, [CLIENT_VERSION_HEADER]: `desktop/${CLIENT_VERSION}`, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.any(signals),
        redirect: "error",
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ClientError("CANCELED", "Request canceled.", 499);
      throw new ClientError("API_UNREACHABLE", `Story Lens API is unreachable: ${error instanceof Error ? error.message : "network error"}.`, 503);
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : `Story Lens API returned HTTP ${response.status}.`;
      if (response.status === 426) throw new ClientError("CLIENT_OUTDATED", `${message} Download the latest Story Lens Client.`, 426);
      if (response.status === 401) throw new ClientError("API_UNAUTHORIZED", "Your Story Lens session expired. Sign in to the extension again and click Connect / refresh models in Settings → AI.", 401);
      const apiCode = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
      throw new ApiError(message, response.status >= 500 ? 502 : response.status, apiCode);
    }
    return data as T;
  }

  private async all<T>(path: string, query: Query, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; items.length < MAX_ITEMS; page++) {
      const result = await this.request<Page<T>>("GET", path, { query: { ...query, pagination: { page, pageSize: PAGE_SIZE } }, signal });
      items.push(...result.data);
      if (!result.data.length || items.length >= result.total) break;
    }
    return items;
  }

  async novels(signal?: AbortSignal): Promise<NovelSummary[]> {
    const novels = await this.all<ApiNovel>("/novels/", { sorting: { column: "name", direction: "asc" } }, signal);
    return novels.map(novel => ({ id: novel.id, name: this.nameOf(novel), context: novel.context ?? null }));
  }
  async createNovel(name: string, signal?: AbortSignal): Promise<NovelSummary> {
    const novel = await this.request<ApiNovel>("POST", "/novels/", { body: { [this.nameField]: name }, signal });
    return { id: novel.id, name: this.nameOf(novel), context: novel.context ?? null };
  }
  async categories(signal?: AbortSignal): Promise<LookupOption[]> {
    return this.all<LookupOption>("/keyword-categories/", { sorting: { column: "createdAt", direction: "asc" } }, signal);
  }
  async natures(signal?: AbortSignal): Promise<LookupOption[]> {
    return this.all<LookupOption>("/keyword-natures/", { sorting: { column: "createdAt", direction: "asc" } }, signal);
  }
  async keywords(novelId: string, signal?: AbortSignal): Promise<ExistingKeyword[]> {
    const keywords = await this.all<ApiKeyword>("/keywords/", { sorting: { column: "name", direction: "asc" }, query: { novelId } }, signal);
    return keywords.map(keyword => this.toKeyword(keyword));
  }
  /**
   * Creates a keyword with client IDs for it and its base version, so a resend after a
   * lost response returns the same keyword. When another keyword already has the name
   * (`KEYWORD_NAME_TAKEN`), returns that one instead.
   */
  async createKeyword({ name, ...input }: NewKeyword): Promise<ExistingKeyword> {
    const body = { ...input, id: crypto.randomUUID(), versionId: crypto.randomUUID(), [this.nameField]: name, matchingType: "FULL" };
    try {
      return this.toKeyword(await this.request<ApiKeyword>("POST", "/keywords/", { body }));
    } catch (error) {
      if (!isApiCode(error, "KEYWORD_NAME_TAKEN")) throw error;
      const existing = (await this.keywords(input.novelId)).find(keyword => keyword.name.toLowerCase() === name.toLowerCase());
      if (!existing) throw error;
      return existing;
    }
  }
  /** Adds an alias named in the crawl's language; one that already exists (`ALIAS_NAME_TAKEN`) counts as saved. */
  async createAlias({ name, ...input }: NewAlias): Promise<void> {
    const body = { ...input, id: crypto.randomUUID(), [this.nameField]: name, matchingType: "FULL", overrideStyle: false };
    try {
      await this.request("POST", "/keyword-aliases/", { body });
    } catch (error) {
      if (!isApiCode(error, "ALIAS_NAME_TAKEN")) throw error;
    }
  }
  async createVersion(input: NewVersion): Promise<void> {
    await this.request("POST", "/keyword-versions/", { body: { ...input, id: crypto.randomUUID() } });
  }
}
