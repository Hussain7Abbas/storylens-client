import { describe, expect, test } from "bun:test";
import { StoryLensApi } from "../src/backend/api";

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
});
