import { describe, expect, it } from "vitest";
import {
  cacheableRequest,
  edgeSeconds,
  freshKey,
  keep,
  lookUp,
  sharedMaxAge,
  STALE_MAX_SECONDS,
  staleIfError,
  staleKey,
  withHeaders,
  type EdgeCache,
} from "./cache";

const FRONT = "https://walkin-app.pages.dev";

function answer(cacheControl: string | null, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({ "content-type": "application/json", ...init.headers });
  if (cacheControl !== null) headers.set("cache-control", cacheControl);
  return new Response('{"ok":true}', { status: init.status ?? 200, headers });
}

describe("sharedMaxAge", () => {
  it.each([
    ["public, max-age=300, s-maxage=3600", 3600],
    ["public, max-age=60, s-maxage=600", 600],
    ["Public, S-MaxAge=86400", 86400],
    ['public, s-maxage="120"', 120],
    ["public,max-age=3600,s-maxage=86400", 86400],
  ])("reads %s as %i seconds", (header, seconds) => {
    expect(sharedMaxAge(header)).toBe(seconds);
  });

  it.each([
    [null],
    [""],
    ["no-store"],
    ["public, max-age=300"],
    ["max-age=300, s-maxage=3600"],
    ["private, s-maxage=600"],
    ["public, no-store, s-maxage=600"],
    ["public, no-cache, s-maxage=600"],
    ["public, s-maxage=0"],
    ["public, s-maxage=soon"],
    ["public, s-maxage=-5"],
  ])("lets no shared cache keep %s", (header) => {
    expect(sharedMaxAge(header)).toBe(0);
  });
});

describe("edgeSeconds", () => {
  it("keeps a public 200 for its s-maxage", () => {
    expect(edgeSeconds(answer("public, max-age=300, s-maxage=3600"))).toBe(3600);
  });

  it.each([
    ["another status", answer("public, s-maxage=600", { status: 404 })],
    ["a redirect", answer("public, s-maxage=600", { status: 307, headers: { location: "/elsewhere" } })],
    ["a cookie", answer("public, s-maxage=600", { headers: { "set-cookie": "walkin_session=abc; HttpOnly" } })],
    ["Vary: *", answer("public, s-maxage=600", { headers: { vary: "*" } })],
    ["no Cache-Control", answer(null)],
    ["no-store", answer("no-store")],
  ])("never keeps an answer with %s", (_, response) => {
    expect(edgeSeconds(response)).toBe(0);
  });
});

describe("cacheableRequest", () => {
  it.each([
    ["GET", "/api/presets", true],
    ["GET", "/api/runs/099134cbfaec", true],
    ["GET", "/api/kits/Av7v5rcNyjXToUQ9JyFkEyHFEHJ_jijsedhKYeMtO4E", true],
    ["GET", "/api/run?lat=1&lon=2", false],
    ["GET", "/api/run/", false],
    ["GET", "/api/receipts/Kq3vX9_pL2mN8rT4wY6zA1bC5dE7fG0h", false],
    ["POST", "/api/receipts/Kq3vX9_pL2mN8rT4wY6zA1bC5dE7fG0h/withdraw", false],
    ["HEAD", "/api/presets", false],
    ["POST", "/api/design", false],
    ["DELETE", "/api/me", false],
  ])("%s %s: %s", (method, path, expected) => {
    expect(cacheableRequest(new Request(`${FRONT}${path}`, { method }))).toBe(expected);
  });
});

describe("keys", () => {
  const url = new URL(`${FRONT}/api/runs/abc?x=1`);

  it("are the URL alone, the fresh and the stale copy apart", () => {
    expect(freshKey(url)).toBe(`${FRONT}/__edge/v3/fresh/api/runs/abc?x=1`);
    expect(staleKey(url)).toBe(`${FRONT}/__edge/v3/stale/api/runs/abc?x=1`);
  });

  it("can never be the URL of a request the function answers", () => {
    for (const key of [freshKey(url), staleKey(url)]) expect(new URL(key).pathname.startsWith("/api/")).toBe(false);
    const visitor = new URL(`${FRONT}/api/runs/abc?x=1&__stale=1`);
    expect(freshKey(visitor)).not.toBe(staleKey(url));
  });
});

/** A cache that keeps what it is given with the headers it is given, as Cloudflare's does. */
function recordingCache() {
  const puts = new Map<string, Response>();
  const cache: EdgeCache = {
    match: (key) => Promise.resolve(puts.get(key)?.clone()),
    put: (key, response) => {
      puts.set(key, response);
      return Promise.resolve();
    },
  };
  return { cache, puts };
}

describe("staleIfError", () => {
  it.each([
    ["public, s-maxage=86400, stale-if-error=604800", 604_800],
    ["public, s-maxage=3600, stale-if-error=60", 60],
    ["public, s-maxage=3600, Stale-If-Error=120", 120],
    ["public, s-maxage=3600, stale-if-error=31536000", STALE_MAX_SECONDS],
  ])("allows a stale copy for the answer's stale-if-error, a week at most: %s", (header, seconds) => {
    expect(staleIfError(header)).toBe(seconds);
  });

  it.each([["public, max-age=60, s-maxage=600"], ["public, s-maxage=600, stale-if-error=soon"], [null]])(
    "allows none without a whole stale-if-error: %s",
    (header) => {
      expect(staleIfError(header)).toBe(0);
    },
  );
});

describe("keep", () => {
  it("stores the answer as it came, and a stale copy for as long as its stale-if-error allows", async () => {
    const { cache, puts } = recordingCache();
    const url = new URL(`${FRONT}/api/presets`);
    await keep(cache, url, answer("public, max-age=300, s-maxage=3600, stale-if-error=604800"));
    const fresh = puts.get(freshKey(url));
    const stale = puts.get(staleKey(url));
    expect(fresh?.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=3600, stale-if-error=604800");
    expect(stale?.headers.get("cache-control")).toBe("public, max-age=604800, s-maxage=604800");
    expect(STALE_MAX_SECONDS).toBe(604_800);
    expect(await fresh?.text()).toBe('{"ok":true}');
    expect(await stale?.text()).toBe('{"ok":true}');
  });

  it("keeps no stale copy of an answer without stale-if-error, such as an owner's own survey", async () => {
    const { cache, puts } = recordingCache();
    const url = new URL(`${FRONT}/api/runs/mine`);
    await keep(cache, url, answer("public, max-age=60, s-maxage=600"));
    expect(puts.has(freshKey(url))).toBe(true);
    expect(puts.has(staleKey(url))).toBe(false);
  });

  it("lets a copy go when the cache refuses it", async () => {
    const cache: EdgeCache = { match: () => Promise.resolve(undefined), put: () => Promise.reject(new Error("413")) };
    await expect(keep(cache, new URL(`${FRONT}/api/presets`), answer("public, s-maxage=60"))).resolves.toBeUndefined();
  });
});

describe("lookUp", () => {
  it("finds nothing without a cache, or when the cache fails", async () => {
    expect(await lookUp(null, "k")).toBeUndefined();
    const broken: EdgeCache = { match: () => Promise.reject(new Error("down")), put: () => Promise.resolve() };
    expect(await lookUp(broken, "k")).toBeUndefined();
  });
});

describe("withHeaders", () => {
  it("sets headers on a copy and keeps the status, the other headers and the body", async () => {
    const original = answer("public, s-maxage=60", { status: 200, headers: { etag: '"1"' } });
    const copy = withHeaders(original, { "x-walkin-cache": "hit" });
    expect(copy.status).toBe(200);
    expect(copy.headers.get("x-walkin-cache")).toBe("hit");
    expect(copy.headers.get("etag")).toBe('"1"');
    expect(await copy.text()).toBe('{"ok":true}');
  });
});
