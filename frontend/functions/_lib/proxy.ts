/**
 * Walk-in's front door, as a function of the request and what it needs (the backend's address and secret, the edge
 * cache, fetch and a timer), so it is tested without Cloudflare.
 *
 * Every /api request goes on to the backend on Render with the proxy's headers, as it always has. A GET the backend
 * marks shareable is kept at the edge (cache.ts) and answered from there until it expires. While the backend is waking,
 * down, slow or failing, a GET with a stale copy gets that copy; anything else gets 503 {"waking": true}, and the app
 * shows its own note while it retries. Every answer says how the edge handled it in `x-walkin-cache`.
 */
import {
  CACHE_STATUS_HEADER,
  cacheableRequest,
  edgeSeconds,
  freshKey,
  keep,
  lookUp,
  staleKey,
  withHeaders,
  type CacheStatus,
  type EdgeCache,
} from "./cache";

export interface Env {
  /** The backend's origin, such as https://walk-in-aoa2.onrender.com. */
  BACKEND_ORIGIN: string;
  /** Shared with the backend, which trusts X-Client-IP (the visitor's address, for rate limits) only with it. */
  PROXY_SECRET: string;
}

/** What the front door uses; the function passes Cloudflare's, tests pass stand-ins. */
export interface FrontDoorDeps {
  env: Env;
  /** Cloudflare's cache (`caches.default`); null where there is none, and then nothing is kept. */
  cache: EdgeCache | null;
  /** Keeps the function running after the visitor has the answer, for the cache writes. */
  waitUntil: (work: Promise<unknown>) => void;
  fetch: (request: Request, init?: RequestInit) => Promise<Response>;
  /** Resolves after `ms`, unless the signal aborts first. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * A GET with a stale copy to fall back on waits this long for the backend before the copy answers: far longer than the
 * backend takes when it is up, far shorter than it takes to wake.
 */
export const STALE_AFTER_MS = 5000;

/** Set here only: a visitor's own values for these are dropped. */
const PROXY_HEADERS = ["x-client-ip", "x-proxy-secret", "x-forwarded-host"];

/** `sleep` for the function: a timer that the signal clears. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
  });
}

/** The visitor's request, addressed to the backend, with the proxy's headers and the visitor's address. */
export function upstreamRequest(request: Request, env: Env): Request {
  const front = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of PROXY_HEADERS) headers.delete(name);
  headers.set("x-client-ip", request.headers.get("cf-connecting-ip") ?? "");
  headers.set("x-proxy-secret", env.PROXY_SECRET);
  headers.set("x-forwarded-host", front.host);
  // A body goes on as it arrives: the fetch standard asks a streamed request body for "half" duplex.
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(new URL(front.pathname + front.search, env.BACKEND_ORIGIN), init);
}

/** While a free instance spins up, Render answers with a page of its own or a gateway error, never the API's JSON. */
export function backendAsleep(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.startsWith("text/html") || (response.status >= 502 && response.status <= 504 && !type.includes("json"));
}

export function wakingResponse(): Response {
  return Response.json(
    { detail: "The survey engine is waking up; after a quiet spell that takes up to a minute.", waking: true },
    { status: 503, headers: { "retry-after": "3", "cache-control": "no-store" } },
  );
}

/** The backend's answer as the visitor gets it: the waking note when the backend is not up, redirects kept on the front
 * door's origin. */
function forVisitor(answer: Response | null, front: URL, backend: URL): Response {
  if (answer === null || backendAsleep(answer)) return wakingResponse();
  const location = answer.headers.get("location");
  if (!location?.startsWith(backend.origin)) return answer;
  return withHeaders(answer, { location: front.origin + location.slice(backend.origin.length) });
}

const tagged = (response: Response, status: CacheStatus): Response => withHeaders(response, { [CACHE_STATUS_HEADER]: status });

/** A stale copy answers for the backend: marked as such, and not kept by the browser, which asks again next time. */
const staleAnswer = (copy: Response): Response =>
  withHeaders(copy, { [CACHE_STATUS_HEADER]: "stale", "cache-control": "no-store" });

/** The backend's answer; null when there was none (it could not be reached, or the wait for it was called off). */
async function ask(request: Request, deps: FrontDoorDeps, signal: AbortSignal): Promise<Response | null> {
  try {
    return await deps.fetch(upstreamRequest(request, deps.env), { redirect: "manual", signal });
  } catch {
    return null;
  }
}

const SLOW = Symbol("slow");

/**
 * Answers an /api request. `x-walkin-cache` says how: "hit" from the edge's fresh copy, "stale" from its stale copy
 * while the backend could not answer, "miss" from the backend with an answer now kept at the edge, and "bypass" for
 * everything the edge does not keep (other methods, the survey stream, receipts, private answers, errors, the waking
 * note).
 */
export async function frontDoor(request: Request, deps: FrontDoorDeps): Promise<Response> {
  const front = new URL(request.url);
  const backend = new URL(deps.env.BACKEND_ORIGIN);
  const cache = cacheableRequest(request) ? deps.cache : null;
  if (!cache) {
    const answer = await ask(request, deps, new AbortController().signal);
    return tagged(forVisitor(answer, front, backend), "bypass");
  }

  const hit = await lookUp(cache, freshKey(front));
  if (hit) return tagged(hit, "hit");

  let stale: Promise<Response | undefined> | undefined;
  const staleCopy = () => (stale ??= lookUp(cache, staleKey(front)));
  const call = new AbortController();
  const asked = ask(request, deps, call.signal);
  const timer = new AbortController();
  const timeUp = deps.sleep(STALE_AFTER_MS, timer.signal).then((): typeof SLOW => SLOW);
  const first = await Promise.race([asked, timeUp]);
  timer.abort();
  if (first === SLOW) {
    const copy = await staleCopy();
    if (copy) {
      call.abort();
      return staleAnswer(copy);
    }
  }
  // Without a copy to fall back on, the backend is waited for as long as it takes, as it always was.
  const answer = first === SLOW ? await asked : first;
  if (answer === null || backendAsleep(answer) || answer.status >= 500) {
    const copy = await staleCopy();
    if (copy) return staleAnswer(copy);
  }

  const response = forVisitor(answer, front, backend);
  if (edgeSeconds(response) === 0) return tagged(response, "bypass");
  deps.waitUntil(keep(cache, front, response.clone()));
  return tagged(response, "miss");
}
