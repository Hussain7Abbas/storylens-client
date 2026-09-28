import { type HTMLElement, type Node, NodeType, parse, type TextNode } from "node-html-parser";
import { ClientError } from "../types";

export type WikiLink = { url: string; text: string };
export type WikiPage = { url: string; title: string; text: string; links: WikiLink[] };

/** Page text kept for one AI phase; wiki articles rarely need more, and the prompt stays far below 500 KB. */
export const PAGE_TEXT_CHARS = 60_000;
/** Distinct same-site links kept from one page. */
export const MAX_PAGE_LINKS = 400;
const MAX_HTML_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; StoryLensClient/3; +https://storylens.iscoded.com/en/)";

/** MediaWiki/Fandom namespaces that never describe characters. Category pages stay, since they list them. */
const SKIPPED_NAMESPACE = /^(special|file|image|media|talk|user|user[ _]talk|user[ _]blog|blog|template|template[ _]talk|help|mediawiki|module|message[ _]wall|thread|board|forum|map|[a-z]+[ _]talk):/i;
const SKIPPED_EXTENSION = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|mp3|mp4|webm|css|js|json|xml)$/i;
const SKIPPED_QUERY = /^(action|oldid|diff|veaction|printable|redirect|curid|uselang|limit|from|until)$/i;
const NOISE = "script, style, noscript, iframe, svg, form, button, .mw-editsection, .reference, .references, .toc, #toc, .navbox, .printfooter, .noprint, .mw-empty-elt, .wds-global-footer, .page-footer, .global-navigation";
const BLOCK = new Set(["address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "header", "hr", "main", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "ul"]);

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true;
  // IPv6 loopback, link-local and unique-local ranges.
  if (host.includes(":")) return host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{0,2}:/.test(host);
  const ipv4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A public HTTP(S) wiki URL without its fragment, or undefined. Local addresses are refused so a page cannot steer the crawler at this computer. */
export function normalizeWikiUrl(value: string, base?: string): string | undefined {
  let url: URL;
  try { url = new URL(value.trim(), base); } catch { return undefined; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || isPrivateHost(url.hostname)) return undefined;
  url.hash = "";
  return url.href;
}

/** Whether a link on the start site may be a character, list, or category page worth a phase. */
export function isCrawlableLink(value: string, origin: string): boolean {
  const url = new URL(value);
  if (url.origin !== origin || SKIPPED_EXTENSION.test(url.pathname)) return false;
  for (const key of url.searchParams.keys()) if (SKIPPED_QUERY.test(key)) return false;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return false; }
  const title = path.replace(/^\/(wiki|w|index\.php)\//i, "").replace(/^\/+/, "");
  const pageTitle = url.searchParams.get("title") ?? title;
  return !!pageTitle && !SKIPPED_NAMESPACE.test(pageTitle) && !/\/index\.php$/i.test(path);
}

function appendText(node: Node, out: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) { out.push((node as TextNode).text.replace(/\s+/g, " ")); return; }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const element = node as HTMLElement;
  const tag = element.rawTagName?.toLowerCase() ?? "";
  if (tag === "br") { out.push("\n"); return; }
  if (tag === "img") { const alt = element.getAttribute("alt")?.trim(); if (alt) out.push(` ${alt} `); return; }
  const heading = /^h[1-6]$/.test(tag);
  if (heading) out.push(`\n\n${"#".repeat(Math.min(Number(tag[1]), 4))} `);
  else if (tag === "li") out.push("\n- ");
  else if (tag === "td" || tag === "th") out.push(" | ");
  else if (BLOCK.has(tag)) out.push("\n");
  for (const child of element.childNodes) appendText(child, out);
  if (heading || BLOCK.has(tag)) out.push("\n");
}

/** Plain text with headings, list items, and table cells kept readable for the model. */
export function elementText(element: HTMLElement): string {
  const out: string[] = [];
  appendText(element, out);
  return out.join("").split("\n").map(line => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Title, readable article text, and same-site links of one wiki page. */
export function parseWikiHtml(html: string, url: string): WikiPage {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = (root.querySelector("#firstHeading, .page-header__title, h1")?.text ?? root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim() || url;
  const content = root.querySelector(".mw-parser-output") ?? root.querySelector("#mw-content-text") ?? root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("#content") ?? root.querySelector("body") ?? root;
  const origin = new URL(url).origin;
  const links = new Map<string, WikiLink>();
  // Links are read before cleanup: navigation boxes are noisy text but good character lists.
  for (const anchor of content.querySelectorAll("a[href]")) {
    if (links.size >= MAX_PAGE_LINKS) break;
    const target = normalizeWikiUrl(anchor.getAttribute("href") ?? "", url);
    if (!target || target === url || links.has(target) || !isCrawlableLink(target, origin)) continue;
    const text = (anchor.text || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (text) links.set(target, { url: target, text });
  }
  for (const noise of content.querySelectorAll(NOISE)) noise.remove();
  return { url, title: title.slice(0, 300), text: elementText(content).slice(0, PAGE_TEXT_CHARS), links: [...links.values()] };
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_HTML_BYTES) throw new ClientError("PAGE_TOO_LARGE", "The wiki page is larger than 5 MB.", 413);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_HTML_BYTES) { await reader.cancel(); throw new ClientError("PAGE_TOO_LARGE", "The wiki page is larger than 5 MB.", 413); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Downloads one public wiki page, following at most five redirects and checking each hop. */
export async function fetchWikiPage(start: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<WikiPage> {
  let url = normalizeWikiUrl(start);
  if (!url) throw new ClientError("BAD_URL", "Use a public http(s) wiki address.", 400);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    } catch (error) {
      if (signal.aborted) throw new ClientError("CANCELED", "Request canceled.", 499);
      throw new ClientError("PAGE_FETCH", `Could not download the page: ${error instanceof Error ? error.message : "network error"}.`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const next = normalizeWikiUrl(response.headers.get("location") ?? "", url);
      if (!next) throw new ClientError("PAGE_FETCH", "The page redirected to an address that cannot be crawled.", 502);
      url = next;
      continue;
    }
    if (!response.ok) throw new ClientError("PAGE_FETCH", `The wiki returned HTTP ${response.status}.`, 502);
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html/i.test(type)) throw new ClientError("PAGE_FETCH", "The address is not an HTML page.", 415);
    return parseWikiHtml(await readLimited(response), url);
  }
  throw new ClientError("PAGE_FETCH", "The page redirected too many times.", 502);
}
