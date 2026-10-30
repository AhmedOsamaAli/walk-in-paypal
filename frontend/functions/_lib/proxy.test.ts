import { describe, expect, it, vi } from "vitest";
import { freshKey, STALE_MAX_SECONDS, staleKey, type EdgeCache } from "./cache";
import { frontDoor, STALE_AFTER_MS, upstreamRequest, type FrontDoorDeps } from "./proxy";

const FRONT = "https://walkin-app.pages.dev";
const BACKEND = "https://walk-in-backend.example";
const ENV = { BACKEND_ORIGIN: BACKEND, PROXY_SECRET: "s3cret" };
const SHARED = "public, max-age=300, s-maxage=3600";
/** What the backend sends with what belongs to no visitor (the examples, presets, config): a stale copy is allowed. */
const SHARED_STALE = `${SHARED}, stale-if-error=604800`;

/**
 * Cloudflare's cache as the front door sees it: each copy kept for its s-maxage, else its max-age, on a clock the test
 * moves; a copy that says not to keep it is refused, as Cloudflare refuses it.
 */
class FakeCache implements EdgeCache {
  now = 0;
  failing = false;
  readonly entries = new Map<string, { body: string; status: number; headers: [string, string][]; until: number }>();

  match(key: string): Promise<Response | undefined> {
    if (this.failing) return Promise.reject(new Error("cache unavailable"));
    const entry = this.entries.get(key);
    if (!entry || entry.until <= this.now) return Promise.resolve(undefined);
    return Promise.resolve(new Response(entry.body, { status: entry.status, headers: entry.headers }));
  }

  async put(key: string, response: Response): Promise<void> {
    if (this.failing) throw new Error("cache unavailable");
    const control = response.headers.get("cache-control") ?? "";
    const seconds = Number(/s-maxage=(\d+)/.exec(control)?.[1] ?? /max-age=(\d+)/.exec(control)?.[1] ?? 0);
    if (/no-store|private/.test(control) || response.headers.has("set-cookie") || seconds <= 0) throw new Error("413");
    this.entries.set(key, {
      body: await response.text(),
      status: response.status,
      headers: [...response.headers],
      until: this.now + seconds * 1000,
    });
  }

  /** Moves the clock on by `seconds`. */
  later(seconds: number): void {
    this.now += seconds * 1000;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const html = (status = 200) => new Response("<html>Service waking up</html>", { status, headers: { "content-type": "text/html" } });

type Answer = Response | Error | (() => Promise<Response>);

/** The front door wired to a fake backend that gives these answers in turn, a fake cache, and a timer the test holds. */
function setup(...answers: Answer[]) {
  const cache = new FakeCache();
  const asked: { request: Request; init?: RequestInit }[] = [];
  const pending: Promise<unknown>[] = [];
  let timeUp = false;
  const deps: FrontDoorDeps = {
    env: ENV,
    cache,
    waitUntil: (work) => {
      pending.push(work);
    },
    fetch: vi.fn((request: Request, init?: RequestInit) => {
      asked.push({ request, init });
      const next = answers.shift() ?? new Error("the backend was asked more often than the test expected");
      if (next instanceof Error) return Promise.reject(next);
      return typeof next === "function" ? next() : Promise.resolve(next.clone());
    }),
    // The wait for a slow backend ends at once when the test says the time is up, and never otherwise.
    sleep: vi.fn((ms: number) => {
      expect(ms).toBe(STALE_AFTER_MS);
      return timeUp ? Promise.resolve() : new Promise<void>(() => undefined);
    }),
  };
  /** Sends a request through the front door, then lets its cache writes finish. */
  async function send(path: string, init?: RequestInit): Promise<Response> {
    const response = await frontDoor(new Request(`${FRONT}${path}`, init), deps);
    await Promise.all(pending.splice(0));
    return response;
  }
  return {
    cache,
    asked,
    deps,
    send,
    slow: () => {
      timeUp = true;
    },
  };
}

const status = (response: Response) => response.headers.get("x-walkin-cache");

describe("the front door", () => {
  it("passes requests on to the backend with the proxy's headers, and the visitor's own", async () => {
    const { send, asked } = setup(json([]));
    await send("/api/presets?x=1", {
      headers: {
        cookie: "walkin_session=abc",
        "cf-connecting-ip": "203.0.113.7",
        "x-client-ip": "1.2.3.4",
        "x-proxy-secret": "forged",
        "x-forwarded-host": "evil.example",
      },
    });
    const [{ request, init }] = asked as [{ request: Request; init?: RequestInit }];
    expect(request.url).toBe(`${BACKEND}/api/presets?x=1`);
    expect(request.headers.get("x-client-ip")).toBe("203.0.113.7");
    expect(request.headers.get("x-proxy-secret")).toBe("s3cret");
    expect(request.headers.get("x-forwarded-host")).toBe("walkin-app.pages.dev");
    expect(request.headers.get("cookie")).toBe("walkin_session=abc");
    expect(init?.redirect).toBe("manual");
  });

  it("passes a request's body on", async () => {
    const { send, asked } = setup(json({ token: "t" }, 202));
    const response = await send("/api/kits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "r1", index: 0 }),
    });
    expect(response.status).toBe(202);
    const request = asked[0]?.request;
    expect(request?.method).toBe("POST");
    expect(await request?.text()).toBe('{"run_id":"r1","index":0}');
    expect(upstreamRequest(new Request(`${FRONT}/api/me`), ENV).body).toBeNull();
  });

  it("keeps a public answer at the edge and answers the same URL from there", async () => {
    const { send, deps } = setup(json(["Williamsburg"], 200, { "cache-control": SHARED }));
    const first = await send("/api/presets");
    expect(status(first)).toBe("miss");
    expect(await first.json()).toEqual(["Williamsburg"]);

    // Another visitor, with other cookies and headers: the URL alone is the key.
    const second = await send("/api/presets", { headers: { cookie: "walkin_session=other", accept: "*/*" } });
    expect(status(second)).toBe("hit");
    expect(second.headers.get("cache-control")).toBe(SHARED);
    expect(await second.json()).toEqual(["Williamsburg"]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a copy for its s-maxage, then asks the backend again", async () => {
    const answer = () => json({ id: "r" }, 200, { "cache-control": "public, max-age=60, s-maxage=600" });
    const { send, cache, deps } = setup(answer(), answer());
    await send("/api/runs/r");
    cache.later(599);
    expect(status(await send("/api/runs/r"))).toBe("hit");
    cache.later(2);
    expect(status(await send("/api/runs/r"))).toBe("miss");
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("keys copies by the whole URL, query and all", async () => {
    const answer = (n: number) => json({ n }, 200, { "cache-control": SHARED });
    const { send } = setup(answer(1), answer(2));
    expect(await (await send("/api/runs/r?a=1")).json()).toEqual({ n: 1 });
    const other = await send("/api/runs/r?a=2");
    expect(status(other)).toBe("miss");
    expect(await other.json()).toEqual({ n: 2 });
  });

  it.each([
    ["no Cache-Control", {}],
    ["no-store", { "cache-control": "no-store" }],
    ["private", { "cache-control": "private, max-age=60" }],
    ["public without s-maxage", { "cache-control": "public, max-age=60" }],
    ["s-maxage=0", { "cache-control": "public, s-maxage=0" }],
  ])("never keeps an answer with %s", async (_, headers: Record<string, string>) => {
    const { send, cache, deps } = setup(json({ ok: 1 }, 200, headers), json({ ok: 2 }, 200, headers));
    expect(status(await send("/api/me"))).toBe("bypass");
    expect(status(await send("/api/me"))).toBe("bypass");
    expect(cache.entries.size).toBe(0);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("never keeps an answer that sets a cookie, and passes its cookies on untouched", async () => {
    const headers = new Headers({ "content-type": "application/json", "cache-control": SHARED });
    headers.append("set-cookie", "walkin_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
    headers.append("set-cookie", "g_state=; Max-Age=0; Path=/");
    const { send, cache } = setup(new Response('{"user":null}', { headers }));
    const response = await send("/api/me");
    expect(status(response)).toBe("bypass");
    expect(response.headers.getSetCookie()).toEqual([
      "walkin_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      "g_state=; Max-Age=0; Path=/",
    ]);
    expect(cache.entries.size).toBe(0);
  });

  it("never keeps an error, a redirect or a not-found", async () => {
    const { send, cache } = setup(
      json({ detail: "gone" }, 404, { "cache-control": SHARED }),
      new Response(null, { status: 307, headers: { location: `${BACKEND}/api/kits`, "cache-control": SHARED } }),
    );
    expect(status(await send("/api/runs/missing"))).toBe("bypass");
    expect(status(await send("/api/kits/"))).toBe("bypass");
    expect(cache.entries.size).toBe(0);
  });

  it("never keeps the survey stream, and streams it on as it comes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: phase\ndata: {}\n\n"));
        controller.close();
      },
    });
    const { send, cache } = setup(
      new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "public, s-maxage=60" } }),
    );
    const response = await send("/api/run?lat=41.9&lon=-87.7");
    expect(status(response)).toBe("bypass");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: phase\ndata: {}\n\n");
    expect(cache.entries.size).toBe(0);
  });

  it("points the backend's redirects at the front door", async () => {
    const { send } = setup(new Response(null, { status: 302, headers: { location: `${BACKEND}/api/me?x=1` } }));
    const response = await send("/api/auth/logout");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${FRONT}/api/me?x=1`);
    expect(status(response)).toBe("bypass");
  });

  it("leaves a redirect elsewhere as it is", async () => {
    const { send } = setup(new Response(null, { status: 302, headers: { location: "https://accounts.google.com/x" } }));
    expect((await send("/api/auth/start")).headers.get("location")).toBe("https://accounts.google.com/x");
  });
});

describe("while the backend is waking, down or failing", () => {
  /** The front door after it has kept an example's run: its fresh copy then expires, its stale copy stays. */
  async function kept(...after: Answer[]) {
    const door = setup(json({ id: "ex", status: "complete" }, 200, { "cache-control": SHARED_STALE }), ...after);
    expect(status(await door.send("/api/runs/ex"))).toBe("miss");
    door.cache.later(3601);
    return door;
  }

  it.each([
    ["Render's waking page", () => html()],
    ["a gateway error", () => new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } })],
    ["no answer at all", () => new TypeError("fetch failed")],
    ["a server error", () => json({ detail: "database unavailable" }, 500)],
    ["the backend's own 503", () => json({ detail: "busy" }, 503)],
  ])("a GET with a stale copy gets that copy on %s", async (_, make) => {
    const { send } = await kept(make());
    const response = await send("/api/runs/ex");
    expect(response.status).toBe(200);
    expect(status(response)).toBe("stale");
    // The browser asks again next time rather than keeping the old copy.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: "ex", status: "complete" });
  });

  it("a GET with a stale copy gets it once the backend has kept it waiting, and the call is called off", async () => {
    let signal: AbortSignal | null | undefined;
    const door = await kept();
    door.slow();
    vi.mocked(door.deps.fetch).mockImplementationOnce((_request, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const response = await door.send("/api/runs/ex");
    expect(status(response)).toBe("stale");
    expect(signal?.aborted).toBe(true);
  });

  it("a slow backend is waited for when there is no copy to fall back on", async () => {
    let answer: (response: Response) => void = () => undefined;
    const door = setup(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    door.slow();
    const sent = door.send("/api/kits/k1");
    await vi.waitFor(() => {
      expect(door.deps.sleep).toHaveBeenCalled();
    });
    answer(json({ token: "k1", status: "building" }));
    const response = await sent;
    expect(response.status).toBe(200);
    expect(status(response)).toBe("bypass");
  });

  it("keeps the stale copy for a week", async () => {
    const door = await kept(html(), html());
    door.cache.later(STALE_MAX_SECONDS - 3601 - 10);
    expect(status(await door.send("/api/runs/ex"))).toBe("stale");
    door.cache.later(20);
    const response = await door.send("/api/runs/ex");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ waking: true });
  });

  it("never serves an owner's own survey stale: once its fresh copy is gone, a sleeping backend gets the waking note", async () => {
    const door = setup(json({ id: "mine", status: "complete" }, 200, { "cache-control": "public, max-age=60, s-maxage=600" }), html());
    expect(status(await door.send("/api/runs/mine"))).toBe("miss");
    door.cache.later(601);
    const response = await door.send("/api/runs/mine");
    expect(response.status).toBe(503);
    expect(status(response)).toBe("bypass");
    expect(await response.json()).toMatchObject({ waking: true });
  });

  it("with nothing kept, a sleeping backend gets the waking note", async () => {
    const { send } = setup(html());
    const response = await send("/api/presets");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(status(response)).toBe("bypass");
    expect(await response.json()).toEqual({
      detail: "The survey engine is waking up; after a quiet spell that takes up to a minute.",
      waking: true,
    });
  });

  it("with nothing kept, a server error is passed on as it came", async () => {
    const { send } = setup(json({ detail: "boom" }, 500));
    const response = await send("/api/runs/x");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: "boom" });
    expect(status(response)).toBe("bypass");
  });

  it("never answers another method with a stale copy", async () => {
    const door = await kept(html());
    const response = await door.send("/api/runs/ex", { method: "POST" });
    expect(response.status).toBe(503);
    expect(status(response)).toBe("bypass");
    expect(door.deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("never answers the survey stream with anything but the backend", async () => {
    const door = setup(html());
    // Even were a copy of the stream's URL somehow kept, it would not be used.
    await door.cache.put(staleKey(new URL(`${FRONT}/api/run?lat=1`)), json({}, 200, { "cache-control": "public, s-maxage=60" }));
    await door.cache.put(freshKey(new URL(`${FRONT}/api/run?lat=1`)), json({}, 200, { "cache-control": "public, s-maxage=60" }));
    const response = await door.send("/api/run?lat=1");
    expect(response.status).toBe(503);
    expect(status(response)).toBe("bypass");
  });

  it("never keeps a receipt nor answers one from a copy, even one a backend marked public by mistake", async () => {
    const path = "/api/receipts/Kq3vX9_pL2mN8rT4wY6zA1bC5dE7fG0h";
    const door = setup(json({ status: "authorized" }, 200, { "cache-control": SHARED_STALE }), html());
    const first = await door.send(path);
    expect(status(first)).toBe("bypass");
    expect(door.cache.entries.size).toBe(0);
    // Even were a copy of its URL somehow kept, it would not be used: a sleeping backend gets the waking note.
    await door.cache.put(staleKey(new URL(`${FRONT}${path}`)), json({ status: "authorized" }, 200, { "cache-control": SHARED }));
    await door.cache.put(freshKey(new URL(`${FRONT}${path}`)), json({ status: "authorized" }, 200, { "cache-control": SHARED }));
    const asleep = await door.send(path);
    expect(asleep.status).toBe(503);
    expect(status(asleep)).toBe("bypass");
    expect(door.deps.sleep).not.toHaveBeenCalled();
  });
});

describe("without a working cache", () => {
  it("a cache that fails is no worse than none", async () => {
    const door = setup(json({ ok: 1 }, 200, { "cache-control": SHARED }), json({ ok: 2 }, 200, { "cache-control": SHARED }));
    door.cache.failing = true;
    expect(await (await door.send("/api/presets")).json()).toEqual({ ok: 1 });
    expect(await (await door.send("/api/presets")).json()).toEqual({ ok: 2 });
  });

  it("without Cloudflare's cache, everything is passed on as before", async () => {
    const door = setup(json({ ok: 1 }, 200, { "cache-control": SHARED }), html());
    door.deps.cache = null;
    const first = await door.send("/api/presets");
    expect(status(first)).toBe("bypass");
    expect((await door.send("/api/presets")).status).toBe(503);
    expect(door.deps.sleep).not.toHaveBeenCalled();
  });

  it("writes to the cache after the visitor has the answer", async () => {
    const door = setup(json({ ok: 1 }, 200, { "cache-control": SHARED }));
    const writes: Promise<unknown>[] = [];
    door.deps.waitUntil = (work) => {
      writes.push(work);
    };
    vi.spyOn(door.cache, "put").mockImplementation(() => new Promise<void>(() => undefined));
    const response = await frontDoor(new Request(`${FRONT}/api/presets`), door.deps);
    expect(status(response)).toBe("miss");
    expect(await response.json()).toEqual({ ok: 1 });
    expect(writes).toHaveLength(1);
  });
});
