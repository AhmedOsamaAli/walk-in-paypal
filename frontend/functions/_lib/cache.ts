/**
 * The front door's edge cache: which API answers Cloudflare may keep, for how long, and under which keys. The backend
 * decides what is shareable with its Cache-Control header; this module only honors it.
 *
 * - A fresh copy is kept for the answer's s-maxage, and answers the same URL at the edge without asking the backend.
 * - A stale copy of the same answer is kept only when the answer allows it with `stale-if-error=N` (RFC 5861), for N
 *   seconds and a week at most, and answers only while the backend is waking, down or failing, so presets, config, the
 *   examples and their kits still open then. The backend sends it on those alone: an owner's own surveys and kits get
 *   no stale copy, so their links stop working once their fresh copy expires (the privacy page promises it).
 *
 * Both keys are the request's URL alone (no cookie or header goes into them), under a path no visitor can ask for: only
 * /api/* reaches the function, so nothing under /__edge/ is ever requested directly.
 */

/** How the edge answered, in the `x-walkin-cache` header of every /api response. */
export type CacheStatus = "hit" | "miss" | "stale" | "bypass";

export const CACHE_STATUS_HEADER = "x-walkin-cache";

/** The longest a stale copy is kept, whatever the answer's stale-if-error says: a week. */
export const STALE_MAX_SECONDS = 7 * 24 * 60 * 60;

/**
 * Bumped to drop every copy the edge holds at the next deploy, should a stored answer ever need to go at once. v2: stale
 * copies are kept only for answers with stale-if-error; none kept under the earlier rule can answer. v3: /api/config
 * gained PayPal's settings with Founders, and a kit's page lost its campaigns to their own endpoint.
 */
const KEY_VERSION = "v3";

/** The survey stream: never kept, whatever its headers say. */
const STREAM = /^\/api\/run\/?$/;
/**
 * A pledge's private receipt: its holder's alone, and its URL is the key to it, so it is never looked up or kept here,
 * whatever its headers say (the backend sends no-store), and no copy of it can answer another visitor.
 */
const RECEIPT_PREFIX = "/api/receipts/";

/** The part of Cloudflare's Cache API (`caches.default`) the front door uses; tests pass a fake. */
export interface EdgeCache {
  match: (key: string) => Promise<Response | undefined>;
  put: (key: string, response: Response) => Promise<void>;
}

/** Whether the edge may answer this request from a copy: a GET of an API path other than the survey stream or a receipt. */
export function cacheableRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return request.method === "GET" && !STREAM.test(path) && !path.startsWith(RECEIPT_PREFIX);
}

/** A Cache-Control header's directives, by lower-case name, with their values unquoted ("" for a bare directive). */
function directivesOf(cacheControl: string | null): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of (cacheControl ?? "").split(",")) {
    const [name = "", value = ""] = part.split("=", 2).map((text) => text.trim());
    if (name) directives.set(name.toLowerCase(), value.replace(/^"|"$/g, ""));
  }
  return directives;
}

/** A directive's value as whole seconds; 0 when it is missing or not a whole number. */
function secondsOf(directives: Map<string, string>, name: string): number {
  const value = directives.get(name) ?? "";
  return /^\d+$/.test(value) ? Number(value) : 0;
}

/** The `s-maxage` of a public Cache-Control, in seconds; 0 when the header does not let a shared cache keep it. */
export function sharedMaxAge(cacheControl: string | null): number {
  const directives = directivesOf(cacheControl);
  if (!directives.has("public") || ["private", "no-store", "no-cache"].some((name) => directives.has(name))) return 0;
  return secondsOf(directives, "s-maxage");
}

/**
 * How long a stale copy of the answer may be kept, in seconds: its `stale-if-error`, a week at most; 0 without one, and
 * then no stale copy is kept and the answer is never served stale.
 */
export function staleIfError(cacheControl: string | null): number {
  return Math.min(secondsOf(directivesOf(cacheControl), "stale-if-error"), STALE_MAX_SECONDS);
}

/**
 * How long the edge may keep an answer, in seconds; 0 when it may not keep it: anything but a 200, an answer the
 * backend does not mark public with an s-maxage, one that sets a cookie, or one that varies on everything.
 */
export function edgeSeconds(response: Response): number {
  if (response.status !== 200) return 0;
  if (response.headers.has("set-cookie")) return 0;
  if (response.headers.get("vary")?.includes("*")) return 0;
  return sharedMaxAge(response.headers.get("cache-control"));
}

function key(kind: "fresh" | "stale", url: URL): string {
  return `${url.origin}/__edge/${KEY_VERSION}/${kind}${url.pathname}${url.search}`;
}

/** Where the fresh copy of this URL's answer is kept. */
export const freshKey = (url: URL): string => key("fresh", url);

/** Where the stale copy of this URL's answer is kept, when its answer allows one. */
export const staleKey = (url: URL): string => key("stale", url);

/** The response with some headers set; its body is handed on, never read. */
export function withHeaders(response: Response, set: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(set)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A stored copy; undefined when there is none, or the cache cannot be read: the backend answers instead. */
export async function lookUp(cache: EdgeCache | null, cacheKey: string): Promise<Response | undefined> {
  if (!cache) return undefined;
  try {
    return await cache.match(cacheKey);
  } catch {
    return undefined;
  }
}

/**
 * Keeps a shareable answer: as it came, for its s-maxage (Cloudflare's cache honors the header); and, only when its
 * `stale-if-error` allows it, as the stale copy, for that long (a week at most). An answer without one is never kept
 * stale. A copy that cannot be stored is let go: the next request asks the backend again.
 */
export async function keep(cache: EdgeCache, url: URL, response: Response): Promise<void> {
  const staleSeconds = staleIfError(response.headers.get("cache-control"));
  const stale =
    staleSeconds > 0
      ? withHeaders(response.clone(), { "cache-control": `public, max-age=${staleSeconds}, s-maxage=${staleSeconds}` })
      : null;
  await Promise.all([
    cache.put(freshKey(url), response).catch(() => undefined),
    stale ? cache.put(staleKey(url), stale).catch(() => undefined) : undefined,
  ]);
}
