import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareImageReferences } from "../src/providers/image";
const folders: string[] = [];
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
afterAll(async () => { for (const dir of folders) await rm(dir, { recursive: true, force: true }); });
async function folder() { const path = await mkdtemp(join(tmpdir(), "storylens-ref-test-")); folders.push(path); return path; }
test("image references load as local attachments, are deduplicated, and preserve URL mapping", async () => {
  let calls = 0;
  const request = (async () => { calls++; return new Response(png); }) as typeof fetch;
  const paths = await prepareImageReferences(["https://images.example.invalid/a.png", "https://images.example.invalid/a.png"], await folder(), new AbortController().signal, request);
  expect(calls).toBe(1);
  expect(paths[0]?.url).toBe("https://images.example.invalid/a.png");
  expect(await readFile(paths[0]?.path ?? "")).toEqual(png);
});
test("references reject private URLs, private redirects and non-image responses", async () => {
  const dir = await folder(), signal = new AbortController().signal;
  const request = (async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } })) as typeof fetch;
  await expect(prepareImageReferences(["http://localhost/private"], dir, signal, request)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(prepareImageReferences(["https://images.example.invalid/a"], dir, signal, request)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(prepareImageReferences(["https://images.example.invalid/a"], dir, signal, (async () => new Response("not an image")) as typeof fetch)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
