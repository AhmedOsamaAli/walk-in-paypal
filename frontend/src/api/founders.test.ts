import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { campaignsPath, canRetry, conflictUrl, founders, paypalOf, problemsOf, type Campaign } from "./founders";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PROGRESS = { supporters: 13, goal: 40, remaining: 27, percent: 32, total: "325.00", funded: false };

/** The campaign the contract describes, as its owner reads it. */
const CAMPAIGN: Campaign = {
  id: "c4f1e2",
  status: "open",
  accepting: true,
  kit_token: "tok_1",
  kit_url: "/k/tok_1",
  survey_url: "/s/b21ec69b0e92?sheet=0",
  name: "Golden Hour",
  place: { label: "Zamalek, Cairo", lat: 30.0626, lon: 31.2197, area: "10-minute walk" },
  concept: { genre: "Bakery", summary: "Morning bread and coffee for the island." },
  evidence: ["No bakery inside the walk.", "Locals cross the river for croissants."],
  title: "Help open Golden Hour on the island",
  pitch: "Bread before eight, a block from the river.",
  perks: ["Your name on the founders' wall", "An invitation to the opening"],
  how_it_works: "PayPal holds each pledge until the deadline.",
  amount: "25.00",
  currency: "USD",
  goal: 40,
  deadline: "2026-11-16T18:00:00Z",
  closed_at: null,
  progress: PROGRESS,
  is_owner: true,
  owner: { counts: { authorized: 13 }, report: null, payout: { status: "none", amount: null, email: "o***@example.com" } },
};

/** Answers in turn, recording what was asked. */
function stubFetch(...answers: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(answers.shift() ?? json({ detail: "No answer left." }, 500));
    }),
  );
  return calls;
}

/** The JSON a recorded request sent. */
function sent(call: { init: RequestInit | undefined } | undefined): unknown {
  const body = call?.init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the campaign API", () => {
  it("drafts and publishes an owner's business without inventing a kit", async () => {
    const business = {
      name: "Morning Table", kind: "cafe" as const, description: "Breakfast and coffee for our neighbors.",
      why_here: "Somewhere to meet.", address: "East Austin, Texas", lat: 30.26, lon: -97.71,
      amount: "25.00", goal: 3, deadline: "2026-11-16T18:00:00Z", perk: null,
    };
    const draft = { title: "Morning Table", pitch: "Breakfast and coffee.", perks: ["A founders' preview"], how_it_works: "Held, not charged.", problems: [] };
    const calls = stubFetch(json(draft), json({ id: "c1", url: "/p/c1" }));
    await expect(founders.draftBusiness(business)).resolves.toEqual(draft);
    await expect(founders.publishBusiness({ ...business, payout_email: "owner@example.com",
      title: draft.title, pitch: draft.pitch, perks: draft.perks })).resolves.toEqual({ id: "c1", url: "/p/c1" });
    expect(calls.map((call) => call.url)).toEqual(["/api/business-campaigns/draft", "/api/business-campaigns"]);
    expect(sent(calls[0])).not.toHaveProperty("kit_token");
    expect(sent(calls[1])).toMatchObject({ name: "Morning Table", kind: "cafe", payout_email: "owner@example.com" });
  });
  it("reads a private receipt without caching or sending its URL as a referrer", async () => {
    const token = "x".repeat(32);
    const body = { status: "authorized", state: "Held", explanation: "PayPal holds your pledge." };
    const calls = stubFetch(json(body), json({ ...body, status: "withdrawn" }));
    await expect(founders.receipt(token)).resolves.toEqual(body);
    await expect(founders.withdrawReceipt(token)).resolves.toMatchObject({ status: "withdrawn" });
    expect(calls[0]?.url).toBe(`/api/receipts/${token}`);
    expect(calls[0]?.init).toMatchObject({ cache: "no-store", referrerPolicy: "no-referrer" });
    expect(calls[1]?.url).toBe(`/api/receipts/${token}/withdraw`);
    expect(calls[1]?.init).toMatchObject({ method: "POST", referrerPolicy: "no-referrer" });
  });
  it("reads a campaign by its id", async () => {
    const calls = stubFetch(json(CAMPAIGN));
    await expect(founders.campaign("c4f1e2")).resolves.toEqual(CAMPAIGN);
    expect(calls[0]?.url).toBe("/api/campaigns/c4f1e2");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("lists the newest, or the nearest around a point", () => {
    expect(campaignsPath(null)).toBe("/api/campaigns");
    expect(campaignsPath({ lat: 30.06261, lon: 31.21974, km: 25 })).toBe("/api/campaigns?lat=30.0626&lon=31.2197&km=25");
    expect(campaignsPath({ lat: 30, lon: 31 })).toBe("/api/campaigns?lat=30.0000&lon=31.0000");
  });

  it("drafts with the terms alone, and publishes them with the edited words", async () => {
    const terms = { kit_token: "tok_1", amount: "25.00", goal: 40, deadline: "2026-11-16T18:00:00.000Z", perk: null };
    const draft = { title: "T", pitch: "P", perks: ["a"], how_it_works: "H", problems: [] };
    const calls = stubFetch(json(draft), json({ id: "c4f1e2", url: "/p/c4f1e2" }, 201));
    await expect(founders.draft(terms)).resolves.toEqual(draft);
    await expect(
      founders.publish({ ...terms, payout_email: "owner@example.com", title: "T", pitch: "P", perks: ["a"] }),
    ).resolves.toEqual({ id: "c4f1e2", url: "/p/c4f1e2" });
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["/api/campaigns/draft", "POST"],
      ["/api/campaigns", "POST"],
    ]);
    expect(sent(calls[0])).toEqual(terms);
    expect(sent(calls[1])).toMatchObject({ payout_email: "owner@example.com", perks: ["a"] });
  });

  it("starts a pledge for the buttons, holds it once approved, and withdraws it", async () => {
    const calls = stubFetch(
      json({ order_id: "5O190127TN364715T", approve_url: null }),
      json({ status: "authorized", progress: PROGRESS }),
      json({ status: "withdrawn", progress: { ...PROGRESS, supporters: 12, remaining: 28 } }),
    );
    await expect(founders.pledge("c4f1e2")).resolves.toEqual({ order_id: "5O190127TN364715T", approve_url: null });
    await expect(founders.authorize("c4f1e2", "5O190127TN364715T")).resolves.toEqual({ status: "authorized", progress: PROGRESS });
    await expect(founders.withdraw("c4f1e2", "5O190127TN364715T")).resolves.toMatchObject({ status: "withdrawn" });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/campaigns/c4f1e2/pledges",
      "/api/campaigns/c4f1e2/pledges/5O190127TN364715T/authorize",
      "/api/campaigns/c4f1e2/pledges/5O190127TN364715T/withdraw",
    ]);
    expect(sent(calls[0])).toEqual({ flow: "buttons" });
  });

  it("closes and cancels for the owner, answering with the campaign", async () => {
    const calls = stubFetch(json({ ...CAMPAIGN, status: "funded" }), json({ ...CAMPAIGN, status: "cancelled" }));
    await expect(founders.close("c4f1e2")).resolves.toMatchObject({ status: "funded" });
    await expect(founders.cancel("c4f1e2")).resolves.toMatchObject({ status: "cancelled" });
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["/api/campaigns/c4f1e2/close", "POST"],
      ["/api/campaigns/c4f1e2/cancel", "POST"],
    ]);
  });

  it("keeps an error's body, for what it adds to its detail", async () => {
    stubFetch(json({ detail: "PayPal declined that card.", retry: true }, 402));
    const error = await founders.authorize("c4f1e2", "5O190127TN364715T").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(canRetry(error)).toBe(true);
    expect((error as ApiError).message).toBe("PayPal declined that card.");
  });
});

describe("what an error's body adds", () => {
  const failure = (status: number, body: unknown) => new ApiError("Refused.", status, true, body);

  it("lets the buttons restart only after a 402 that says so", () => {
    expect(canRetry(failure(402, { detail: "Declined.", retry: true }))).toBe(true);
    expect(canRetry(failure(402, { detail: "Declined." }))).toBe(false);
    expect(canRetry(failure(409, { detail: "Closed.", retry: true }))).toBe(false);
    expect(canRetry(new Error("402"))).toBe(false);
  });

  it("points a 409 to the campaign already open, when it names one", () => {
    expect(conflictUrl(failure(409, { detail: "Open already.", url: "/p/c4f1e2" }))).toBe("/p/c4f1e2");
    expect(conflictUrl(failure(409, { detail: "Open already.", url: "https://elsewhere.example/p/x" }))).toBeNull();
    expect(conflictUrl(failure(409, { detail: "Closed." }))).toBeNull();
    expect(conflictUrl(failure(422, { url: "/p/c4f1e2" }))).toBeNull();
  });

  it("reads a 422's problems wherever the server put them", () => {
    expect(problemsOf(failure(422, { detail: "Not allowed.", problems: ["The goal must be 3 to 500 supporters."] }))).toEqual([
      "The goal must be 3 to 500 supporters.",
    ]);
    expect(problemsOf(failure(422, { detail: { problems: ["The pitch names Joe's Bakery."] } }))).toEqual([
      "The pitch names Joe's Bakery.",
    ]);
    expect(problemsOf(failure(422, { detail: [{ loc: ["body", "goal"], msg: "Input should be a valid integer" }] }))).toEqual([
      "Input should be a valid integer",
    ]);
    expect(problemsOf(failure(422, { detail: "Not allowed." }))).toEqual(["Refused."]);
    expect(problemsOf(new ApiError("Request failed (422).", 422, false, null))).toEqual([]);
    expect(problemsOf(new Error("x"))).toEqual([]);
  });
});

describe("PayPal's settings", () => {
  it("are usable only with a client id, in the sandbox unless live", () => {
    expect(paypalOf({ paypal: { enabled: true, client_id: "AbC", environment: "sandbox", currency: "USD" } })).toEqual({
      enabled: true,
      client_id: "AbC",
      environment: "sandbox",
      currency: "USD",
    });
    expect(paypalOf({ paypal: { enabled: true, client_id: null, environment: "live", currency: "USD" } })).toMatchObject({
      enabled: false,
      environment: "live",
    });
    expect(paypalOf({ paypal: { enabled: false, client_id: "AbC", environment: "sandbox", currency: "USD" } })?.enabled).toBe(false);
    expect(paypalOf({})).toBeNull();
    expect(paypalOf(null)).toBeNull();
  });
});
