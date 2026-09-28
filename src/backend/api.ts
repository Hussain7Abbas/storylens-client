import type { Account } from "../config";
import { ClientError } from "../types";

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

type Query = Record<string, string | number | Record<string, string | number | undefined> | undefined>;
type Page<T> = { data: T[]; total: number };

const PAGE_SIZE = 200;
/** Stops runaway pagination on a misbehaving server. */
const MAX_ITEMS = 20_000;
const TIMEOUT_MS = 30_000;

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
  constructor(private readonly account: Account, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(method: "GET" | "POST", path: string, options: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = `${this.account.apiUrl.replace(/\/+$/, "")}${path}${encodeQuery(options.query ?? {})}`;
    const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.account.token}`, Accept: "application/json", "Accept-Language": "en", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
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
      if (response.status === 401) throw new ClientError("API_UNAUTHORIZED", "Your Story Lens session expired. Sign in to the extension again and click Connect / refresh models in Settings → AI.", 401);
      throw new ClientError("API_ERROR", message, response.status >= 500 ? 502 : response.status);
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
    const novels = await this.all<NovelSummary>("/novels/", { sorting: { column: "name", direction: "asc" } }, signal);
    return novels.map(({ id, name, context }) => ({ id, name, context: context ?? null }));
  }
  async createNovel(name: string, signal?: AbortSignal): Promise<NovelSummary> {
    const novel = await this.request<NovelSummary>("POST", "/novels/", { body: { name }, signal });
    return { id: novel.id, name: novel.name, context: novel.context ?? null };
  }
  async categories(signal?: AbortSignal): Promise<LookupOption[]> {
    return this.all<LookupOption>("/keyword-categories/", { sorting: { column: "createdAt", direction: "asc" } }, signal);
  }
  async natures(signal?: AbortSignal): Promise<LookupOption[]> {
    return this.all<LookupOption>("/keyword-natures/", { sorting: { column: "createdAt", direction: "asc" } }, signal);
  }
  async keywords(novelId: string, signal?: AbortSignal): Promise<ExistingKeyword[]> {
    const keywords = await this.all<ExistingKeyword>("/keywords/", { sorting: { column: "name", direction: "asc" }, query: { novelId } }, signal);
    return keywords.map(({ id, name, aliases, versions }) => ({ id, name, aliases: aliases.map(alias => ({ name: alias.name })), versions: versions.map(version => ({ startingChapter: version.startingChapter })) }));
  }
  async createKeyword(input: NewKeyword): Promise<ExistingKeyword> {
    const keyword = await this.request<ExistingKeyword>("POST", "/keywords/", { body: { ...input, matchingType: "FULL" } });
    return { id: keyword.id, name: keyword.name, aliases: keyword.aliases.map(alias => ({ name: alias.name })), versions: keyword.versions.map(version => ({ startingChapter: version.startingChapter })) };
  }
  async createAlias(input: NewAlias): Promise<void> {
    await this.request("POST", "/keyword-aliases/", { body: { ...input, matchingType: "FULL", overrideStyle: false } });
  }
  async createVersion(input: NewVersion): Promise<void> {
    await this.request("POST", "/keyword-versions/", { body: input });
  }
}
