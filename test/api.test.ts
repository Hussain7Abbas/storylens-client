import { describe, expect, test } from "bun:test";
import { StoryLensApi } from "../src/backend/api";
import { ClientError } from "../src/types";
import { CLIENT_VERSION } from "../src/version";

describe("StoryLensApi", () => {
  test("calls the reader API under /api/user on the shared origin", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });
    }) as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example/", token: "t" }, fakeFetch);

    await api.novels();

    expect(urls).toHaveLength(1);
    expect(urls[0]?.startsWith("https://api.storylens.example/api/user/novels/?")).toBe(true);
  });

  test("reads and writes names in its language's field", async () => {
    const requests: { language: string | null; body: unknown }[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ language: headers.get("accept-language"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const keyword = { id: "k1", nameAr: "لين", nameEn: null, aliases: [], versions: [] };
      return new Response(JSON.stringify(init?.method === "POST" ? keyword : { data: [keyword], total: 1 }), { status: 200 });
    }) as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example", token: "t" }, fakeFetch, "ar");

    expect((await api.keywords("n1"))[0]?.name).toBe("لين");
    await api.createKeyword({ novelId: "n1", name: "لين", categoryId: "c", natureId: "n" });

    expect(requests.map(request => request.language)).toEqual(["ar", "ar"]);
    expect(requests[1]?.body).toMatchObject({ nameAr: "لين", novelId: "n1" });
    expect(requests[1]?.body).not.toHaveProperty("name");
  });

  test("counts an alias's translations as stored names", async () => {
    const keyword = {
      id: "k1",
      nameAr: null,
      nameEn: "Mira",
      aliases: [
        { nameAr: "ميرا الصغيرة", nameEn: "Little Mira" },
        { nameAr: null, nameEn: "Mimi" },
      ],
      versions: [],
    };
    const fakeFetch = (async () => new Response(JSON.stringify({ data: [keyword], total: 1 }), { status: 200 })) as unknown as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example", token: "t" }, fakeFetch);

    expect((await api.keywords("n1"))[0]?.aliases).toEqual([{ name: "ميرا الصغيرة" }, { name: "Little Mira" }, { name: "Mimi" }]);
  });

  test("sends client IDs and names aliases in its language", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "k1", nameAr: "لين", nameEn: null, aliases: [], versions: [] }), { status: 200 });
    }) as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example", token: "t" }, fakeFetch, "ar");
    const uuid = /^[0-9a-f-]{36}$/;

    await api.createKeyword({ novelId: "n1", name: "لين", categoryId: "c", natureId: "n" });
    await api.createAlias({ keywordId: "k1", name: "لينا" });
    await api.createVersion({ keywordId: "k1", currentChapter: 4 });

    expect(bodies[0]).toMatchObject({ id: expect.stringMatching(uuid), versionId: expect.stringMatching(uuid) });
    expect(bodies[1]).toMatchObject({ id: expect.stringMatching(uuid), keywordId: "k1", nameAr: "لينا" });
    expect(bodies[1]).not.toHaveProperty("name");
    expect(bodies[2]).toMatchObject({ id: expect.stringMatching(uuid), currentChapter: 4 });
  });

  test("treats a taken name as already saved", async () => {
    const existing = { id: "k-existing", nameAr: null, nameEn: "Aria", aliases: [], versions: [{ startingChapter: 0 }] };
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(JSON.stringify({ data: [existing], total: 1 }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { keywordId?: string };
      const code = body.keywordId ? "ALIAS_NAME_TAKEN" : "KEYWORD_NAME_TAKEN";
      return new Response(JSON.stringify({ message: "taken", code }), { status: 409 });
    }) as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example", token: "t" }, fakeFetch);

    expect((await api.createKeyword({ novelId: "n1", name: "aria", categoryId: "c", natureId: "n" })).id).toBe("k-existing");
    expect(await api.createAlias({ keywordId: "k-existing", name: "Sparrow" })).toBeUndefined();
  });

  test("reports its version and surfaces the API's upgrade requirement", async () => {
    const versions: (string | null)[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      versions.push(new Headers(init?.headers).get("x-client-version"));
      return new Response(JSON.stringify({ message: "This version of Story Lens is outdated. Update to 9.0.0 or newer.", minVersion: "9.0.0" }), { status: 426 });
    }) as typeof fetch;
    const api = new StoryLensApi({ apiUrl: "https://api.storylens.example", token: "t" }, fakeFetch);

    const error = await api.novels().catch((caught: unknown) => caught);

    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versions).toEqual([`desktop/${CLIENT_VERSION}`]);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "CLIENT_OUTDATED", status: 426 });
    expect((error as ClientError).message).toContain("9.0.0");
  });
});
