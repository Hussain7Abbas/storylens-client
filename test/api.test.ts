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
