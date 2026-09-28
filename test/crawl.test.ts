import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExistingKeyword, LookupOption, NewAlias, NewKeyword, NewVersion, StoryLensApi } from "../src/backend/api";
import { encodeQuery } from "../src/backend/api";
import { SettingsStore } from "../src/config";
import { mergePageCharacters, type CharacterRow } from "../src/crawl/merge";
import { isCrawlableLink, normalizeWikiUrl, parseWikiHtml, type WikiPage } from "../src/crawl/page";
import { buildWikiPagePrompt, parseWikiPageResult } from "../src/crawl/prompt";
import { CrawlSession, type CrawlSnapshot, type ExecuteRequest } from "../src/crawl/session";
import { createServer } from "../src/server";
import { PromptService } from "../src/service";
import { ClientError } from "../src/types";

const categories: LookupOption[] = [{ id: "11111111-1111-4111-8111-111111111111", nameEn: "Person", nameAr: "شخص", description: "Any person" }];
const natures: LookupOption[] = [{ id: "22222222-2222-4222-8222-222222222222", nameEn: "Ally", nameAr: null, description: null }];
const NOVEL_ID = "33333333-3333-4333-8333-333333333333";

describe("wiki pages", () => {
  test("normalizes public URLs and refuses local ones", () => {
    expect(normalizeWikiUrl("https://tales.fandom.com/wiki/Aria#Early_life")).toBe("https://tales.fandom.com/wiki/Aria");
    expect(normalizeWikiUrl("/wiki/Bram", "https://tales.fandom.com/wiki/Aria")).toBe("https://tales.fandom.com/wiki/Bram");
    expect(normalizeWikiUrl("https://fcbarcelona.example/wiki/A")).toBe("https://fcbarcelona.example/wiki/A");
    for (const bad of ["ftp://tales.example/", "http://localhost:43127/capabilities", "http://127.0.0.1/", "http://192.168.1.2/", "http://[::1]/", "javascript:alert(1)", "https://user:pw@tales.example/"]) expect(normalizeWikiUrl(bad)).toBeUndefined();
  });
  test("keeps same-site article and category links only", () => {
    const origin = "https://tales.fandom.com";
    expect(isCrawlableLink("https://tales.fandom.com/wiki/Aria", origin)).toBe(true);
    expect(isCrawlableLink("https://tales.fandom.com/wiki/Category:Characters", origin)).toBe(true);
    for (const bad of ["https://tales.fandom.com/wiki/File:Aria.png", "https://tales.fandom.com/wiki/Special:Random", "https://tales.fandom.com/wiki/User_talk:Someone", "https://tales.fandom.com/wiki/Aria?action=edit", "https://other.fandom.com/wiki/Aria", "https://tales.fandom.com/wiki/Template:Infobox"]) expect(isCrawlableLink(bad, origin)).toBe(false);
  });
  test("extracts title, readable text, and deduplicated links", () => {
    const html = `<html><head><title>Aria | Tales Wiki</title><script>var x = 1;</script></head><body>
      <nav><a href="/wiki/Special:Search">Search</a></nav>
      <h1 id="firstHeading">Aria</h1>
      <div class="mw-parser-output">
        <aside class="portable-infobox"><h2>Aria</h2><div>Alias: <b>The Grey Sparrow</b></div></aside>
        <p>Aria is a <a href="/wiki/Courier">courier</a> and friend of <a href="/wiki/Bram">Bram</a>.<sup class="reference">[1]</sup></p>
        <h2>Appearance<span class="mw-editsection">edit</span></h2>
        <ul><li>Grey cloak</li><li>Short hair</li></ul>
        <table><tr><th>Arc</th><td>One</td></tr></table>
        <a href="/wiki/Bram#Family">Bram again</a><a href="/wiki/File:Aria.png">image</a>
        <table class="navbox"><tr><td><a href="/wiki/Category:Characters">Characters</a></td></tr></table>
      </div></body></html>`;
    const page = parseWikiHtml(html, "https://tales.fandom.com/wiki/Aria");
    expect(page.title).toBe("Aria");
    expect(page.text).toContain("Aria is a courier and friend of Bram.");
    expect(page.text).toContain("## Appearance");
    expect(page.text).toContain("- Grey cloak");
    expect(page.text).toContain("| Arc | One");
    expect(page.text).toContain("The Grey Sparrow");
    expect(page.text).not.toContain("[1]");
    expect(page.text).not.toContain("edit");
    expect(page.text).not.toContain("Characters");
    expect(page.text).not.toContain("var x");
    expect(page.links.map(link => link.url)).toEqual(["https://tales.fandom.com/wiki/Courier", "https://tales.fandom.com/wiki/Bram", "https://tales.fandom.com/wiki/Category:Characters"]);
  });
});

describe("page prompt", () => {
  const page: WikiPage = { url: "https://tales.fandom.com/wiki/Aria", title: "Aria", text: "Aria is a courier.", links: [] };
  const links = [{ url: "https://tales.fandom.com/wiki/Bram", text: "Bram" }, { url: "https://tales.fandom.com/wiki/Category:Characters", text: "Characters" }];
  test("numbers options and links and carries known names and context", () => {
    const prompt = buildWikiPagePrompt({ novelName: "Tales", novelContext: "Genre: fantasy", page, links, knownNames: ["Bram", " Bram "], categories, natures, language: "ar" });
    expect(prompt).toContain("1. Person / شخص — Any person");
    expect(prompt).toContain("1. Ally\n");
    expect(prompt).toContain("Known characters: Bram.");
    expect(prompt).toContain("2. Characters — /wiki/Category:Characters");
    expect(prompt).toContain("<NOVEL_CONTEXT>\nGenre: fantasy");
    expect(prompt).toContain("Write every description in Arabic");
    expect(prompt).toContain("Do not copy sentences from the wiki.");
  });
  test("parses characters, aliases, versions, parents, and picked links", () => {
    const output = `{"characters":[
      {"name":" Aria ","description":"A courier.","category":1,"nature":"1","aliases":["The Grey Sparrow","aria",""],"versions":[{"name":"Ash Aria","description":"After the fire.","startingChapter":"120"},{"name":"Ash Aria"},{"name":"Ghost","startingChapter":-3}],"parent":null,"relation":null},
      {"name":"Sparrow","description":"x","category":9,"parent":"aria","relation":"alias"},
      {"name":"Stranger","description":"x","parent":"Nobody","relation":"alias"},
      {"name":"Aria","description":"duplicate"}
    ],"links":[2,2,7,"1"]}`;
    const result = parseWikiPageResult(output, { categories, natures, links, knownNames: ["Bram"] });
    expect(result.characters).toEqual([
      { name: "Aria", description: "A courier.", categoryId: categories[0].id, natureId: natures[0].id, aliases: ["The Grey Sparrow"], versions: [{ name: "Ash Aria", description: "After the fire.", startingChapter: 120 }, { name: "Ghost", description: "", startingChapter: null }] },
      { name: "Sparrow", description: "x", categoryId: undefined, natureId: undefined, aliases: [], versions: [], parent: { name: "Aria", relation: "alias" } },
      { name: "Stranger", description: "x", categoryId: undefined, natureId: undefined, aliases: [], versions: [] },
    ]);
    expect(result.links).toEqual([links[1].url, links[0].url]);
    expect(() => parseWikiPageResult("no json", { categories, natures, links, knownNames: [] })).toThrow();
  });
});

describe("character table", () => {
  const existing: ExistingKeyword[] = [{ id: "kw-bram", name: "Bram", aliases: [{ name: "Old Bear" }], versions: [{ startingChapter: 0 }] }];
  function context(rows: CharacterRow[] = []) { let key = 0; return { rows, existing, nextKey: () => `k${++key}` }; }
  test("merges mentions, parent links, and existing keywords", () => {
    const ctx = context();
    mergePageCharacters(ctx, [{ name: "Aria", description: "Short.", aliases: [], versions: [] }], "Characters");
    mergePageCharacters(ctx, [
      { name: "Aria", description: "From her own page.", categoryId: "c", natureId: "n", aliases: ["Sparrow"], versions: [] },
      { name: "Ash Aria", description: "Reborn.", aliases: [], versions: [], parent: { name: "Aria", relation: "version" } },
      { name: "Grey Bear", description: "Bram's title.", aliases: [], versions: [], parent: { name: "Old Bear", relation: "alias" } },
    ], "Aria | Tales Wiki | Fandom");
    expect(ctx.rows).toHaveLength(2);
    const [aria, bram] = ctx.rows;
    expect(aria).toMatchObject({ name: "Aria", description: "From her own page.", categoryId: "c", aliases: ["Sparrow"], versions: [{ name: "Ash Aria", description: "Reborn.", startingChapter: null }], sources: ["Characters", "Aria | Tales Wiki | Fandom"] });
    expect(bram).toMatchObject({ name: "Bram", keywordId: "kw-bram", aliases: ["Old Bear", "Grey Bear"], savedNames: ["bram", "old bear"], savedChapters: [0] });
  });
  test("absorbs a separate row once a page reveals it is an alias", () => {
    const ctx = context();
    mergePageCharacters(ctx, [{ name: "Sparrow", description: "A thief.", aliases: [], versions: [{ name: "Masked", description: "", startingChapter: 5 }] }], "Thieves");
    mergePageCharacters(ctx, [{ name: "Aria", description: "", aliases: ["Sparrow"], versions: [] }], "Aria");
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0]).toMatchObject({ name: "Aria", description: "A thief.", aliases: ["Sparrow"], versions: [{ name: "Masked", startingChapter: 5 }] });
  });
});

class FakeApi {
  created: { keywords: NewKeyword[]; aliases: NewAlias[]; versions: NewVersion[]; novels: string[] } = { keywords: [], aliases: [], versions: [], novels: [] };
  async novels() { return [{ id: NOVEL_ID, name: "Tales &amp; Songs", context: null }]; }
  async createNovel(name: string) { this.created.novels.push(name); return { id: NOVEL_ID, name, context: null }; }
  async categories() { return categories; }
  async natures() { return natures; }
  async keywords() { return [{ id: "kw-bram", name: "Bram", aliases: [], versions: [{ startingChapter: 0 }] }]; }
  async createKeyword(input: NewKeyword) { this.created.keywords.push(input); return { id: `kw-${input.name}`, name: input.name, aliases: [], versions: [{ startingChapter: 0 }] }; }
  async createAlias(input: NewAlias) { this.created.aliases.push(input); }
  async createVersion(input: NewVersion) { this.created.versions.push(input); }
}

const pages: Record<string, WikiPage> = {
  "https://tales.example/wiki/Characters": { url: "https://tales.example/wiki/Characters", title: "Characters", text: "Aria and Bram.", links: [{ url: "https://tales.example/wiki/Aria", text: "Aria" }, { url: "https://tales.example/wiki/Map", text: "Map" }] },
  "https://tales.example/wiki/Aria": { url: "https://tales.example/wiki/Aria", title: "Aria", text: "Aria, called Sparrow.", links: [{ url: "https://tales.example/wiki/Characters", text: "Back" }] },
};
const answers: Record<string, string> = {
  Characters: `{"characters":[{"name":"Aria","description":"A courier.","category":1,"nature":1,"aliases":[],"versions":[]},{"name":"Bram","description":"A smith.","category":1,"nature":1,"aliases":[],"versions":[]}],"links":[1]}`,
  Aria: `{"characters":[{"name":"Aria","description":"A courier who delivers letters.","category":1,"nature":1,"aliases":["Sparrow"],"versions":[{"name":"Ash Aria","description":"After the fire.","startingChapter":40},{"name":"Queen Aria","description":"Crowned.","startingChapter":null}]}],"links":[1]}`,
};

describe("crawl session", () => {
  function session(options: { busyOnce?: boolean; account?: boolean } = {}) {
    const api = new FakeApi();
    const snapshots: CrawlSnapshot[] = [];
    const prompts: ExecuteRequest[] = [];
    let busy = options.busyOnce ?? false;
    const crawl = new CrawlSession({
      account: () => (options.account === false ? null : { apiUrl: "https://api.example", token: "secret" }),
      api: () => api as unknown as StoryLensApi,
      fetchPage: async url => { const page = pages[url]; if (!page) throw new Error("HTTP 404"); return page; },
      execute: async request => {
        if (busy) { busy = false; throw new ClientError("BUSY", "busy", 429); }
        prompts.push(request);
        const title = request.prompt.match(/<PAGE title="([^"]+)"/)?.[1] ?? "";
        return { requestId: "r", output: answers[title] ?? '{"characters":[],"links":[]}', model: request.model, provider: "claude", effort: request.effort, responseLanguage: request.responseLanguage, durationMs: 1 };
      },
      onChange: snapshot => snapshots.push(snapshot),
      busyDelayMs: 1,
    });
    return { api, crawl, snapshots, prompts };
  }
  const input = { url: "https://tales.example/wiki/Characters", novelId: NOVEL_ID, model: "claude:x", effort: "high", responseLanguage: "en" as const, maxPages: 5 };

  test("runs one phase per page, follows picked links, and merges the table", async () => {
    const { crawl, snapshots, prompts } = session({ busyOnce: true });
    await crawl.start(input);
    await crawl.settled();
    const last = crawl.snapshot();
    expect(last.status).toBe("finished");
    expect(last.novel).toEqual({ id: NOVEL_ID, name: "Tales & Songs" });
    expect(last.phases.map(phase => [phase.title, phase.status, phase.found.map(item => item.name)])).toEqual([["Characters", "done", ["Aria", "Bram"]], ["Aria", "done", ["Aria"]]]);
    expect(last.phases[1].found[0].detail).toBe("aliases: Sparrow · versions: Ash Aria, Queen Aria");
    expect(last.rows.map(row => [row.name, row.description, row.keywordId ?? null, row.aliases])).toEqual([["Aria", "A courier who delivers letters.", null, ["Sparrow"]], ["Bram", "A smith.", "kw-bram", []]]);
    expect(prompts[1].prompt).toContain("Known characters: Bram, Aria.");
    expect(snapshots.some(snapshot => snapshot.phases[0]?.status === "analyzing")).toBe(true);
  });

  test("saves a new keyword with its aliases and dated versions", async () => {
    const { api, crawl } = session();
    await crawl.start(input);
    await crawl.settled();
    const aria = crawl.snapshot().rows[0];
    await crawl.saveAll();
    expect(api.created.keywords).toEqual([{ novelId: NOVEL_ID, name: "Aria", description: "A courier who delivers letters.", categoryId: categories[0].id, natureId: natures[0].id }]);
    expect(api.created.aliases).toEqual([{ keywordId: "kw-Aria", name: "Sparrow" }]);
    expect(api.created.versions).toEqual([{ keywordId: "kw-Aria", currentChapter: 40, description: "Ash Aria — After the fire." }]);
    let row = crawl.snapshot().rows.find(item => item.key === aria.key);
    expect(row?.state).toBe("idle");
    expect(row?.notes.at(-1)).toContain("“Queen Aria”");
    crawl.updateRow(aria.key, { versions: [...(row?.versions ?? [])].map(version => ({ ...version, startingChapter: version.startingChapter ?? 90 })) });
    await crawl.saveRow(aria.key);
    row = crawl.snapshot().rows.find(item => item.key === aria.key);
    expect(row?.state).toBe("saved");
    expect(api.created.versions.at(-1)).toEqual({ keywordId: "kw-Aria", currentChapter: 90, description: "Queen Aria — Crowned." });
    expect(api.created.keywords).toHaveLength(1);
  });

  test("creates a new novel, respects the page limit, and resumes", async () => {
    const { api, crawl } = session();
    await crawl.start({ ...input, novelId: undefined, newNovelName: "New Tales", maxPages: 1 });
    await crawl.settled();
    expect(api.created.novels).toEqual(["New Tales"]);
    expect(crawl.snapshot()).toMatchObject({ status: "finished", queued: 1 });
    crawl.resume(1);
    await crawl.settled();
    expect(crawl.snapshot().phases).toHaveLength(2);
    expect(() => crawl.resume(1)).toThrow();
  });

  test("requires a shared account and validates input", async () => {
    await expect(session({ account: false }).crawl.start(input)).rejects.toMatchObject({ code: "NO_ACCOUNT" });
    await expect(session().crawl.start({ ...input, url: "http://127.0.0.1:43127/" })).rejects.toMatchObject({ code: "BAD_URL" });
    await expect(session().crawl.start({ ...input, newNovelName: "Both" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("stop cancels the running phase", async () => {
    let release: () => void = () => {};
    const api = new FakeApi();
    const crawl = new CrawlSession({
      account: () => ({ apiUrl: "https://api.example", token: "secret" }), api: () => api as unknown as StoryLensApi,
      fetchPage: (_url, signal) => new Promise((_resolve, reject) => { release = () => reject(new Error("aborted")); signal.addEventListener("abort", () => release()); }),
      execute: async () => { throw new Error("not reached"); }, onChange: () => {},
    });
    await crawl.start(input);
    crawl.stop();
    await crawl.settled();
    expect(crawl.snapshot()).toMatchObject({ status: "stopped" });
    expect(crawl.snapshot().phases[0].status).toBe("canceled");
  });
});

test("API queries use bracket notation", () => {
  expect(encodeQuery({ pagination: { page: 1, pageSize: 200 }, query: { novelId: "a b", skip: undefined }, plain: 3 })).toBe("?pagination%5Bpage%5D=1&pagination%5BpageSize%5D=200&query%5BnovelId%5D=a+b&plain=3");
});

describe("AccountSession", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  test("stores, validates, and clears the shared account", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storylens-account-")); dirs.push(dir);
    const settings = new SettingsStore(join(dir, "settings.json")); await settings.load();
    const service = new PromptService(settings, async () => "ok", async () => ({ models: [], providers: [] }));
    const server = createServer(settings, service);
    const headers = { host: `127.0.0.1:${settings.get().port}`, authorization: `Bearer ${settings.get().token}`, origin: "chrome-extension://abcdef" };
    let changes = 0;
    settings.onChange(() => { changes++; });
    const account = { apiUrl: "https://api.storylens.example", token: "session-token" };
    expect((await server.inject({ method: "POST", url: "/AccountSession", headers: { host: headers.host }, payload: { account } })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/AccountSession", headers, payload: { account: { ...account, apiUrl: "http://api.example" } } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/AccountSession", headers, payload: { account } })).json()).toEqual({ connected: true });
    await server.inject({ method: "POST", url: "/AccountSession", headers, payload: { account } });
    expect(settings.get().account).toEqual(account);
    expect(changes).toBe(1);
    expect((await server.inject({ method: "POST", url: "/AccountSession", headers, payload: { account: { apiUrl: "http://localhost:3000", token: "t" } } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/AccountSession", headers, payload: { account: null } })).json()).toEqual({ connected: false });
    expect(settings.get().account).toBeNull();
    await server.close();
  });
});
