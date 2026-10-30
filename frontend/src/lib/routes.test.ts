import { describe, expect, it } from "vitest";
import {
  campaignUrl,
  dossierUrl,
  EXAMPLES_URL,
  FOUNDERS_URL,
  isPage,
  kitUrl,
  pageUrl,
  parseRoute,
  PLACES_URL,
  PRIVACY_URL,
  receiptUrl,
  samePage,
  surveyUrl,
  type CampaignRoute,
} from "./routes";

describe("routes", () => {
  it("starts a campaign without sending the owner through the survey", () => {
    const route = { page: "start-campaign" } as const;
    expect(parseRoute("/founders/start", "")).toEqual(route);
    expect(parseRoute("/founders/start/", "")).toEqual(route);
    expect(pageUrl(route)).toBe("/founders/start");
    expect(isPage(route)).toBe(true);
  });
  it("opens private receipts without putting their data in a public campaign URL", () => {
    const token = "A-b_".repeat(8);
    const route = { page: "receipt", token } as const;
    expect(parseRoute(receiptUrl(token), "")).toEqual(route);
    expect(pageUrl(route)).toBe(`/r/${token}`);
    expect(isPage(route)).toBe(true);
    for (const invalid of ["/r/", "/r/short", `/r/${token}x`, `/r/${token}/extra`]) {
      expect(parseRoute(invalid, "")).toEqual({ page: "brief" });
    }
  });
  it("reads a survey's id and its open design sheet", () => {
    expect(parseRoute("/s/3f9a0c1b2d4e", "")).toEqual({ page: "survey", id: "3f9a0c1b2d4e", sheet: null });
    expect(parseRoute("/s/3f9a0c1b2d4e/", "")).toEqual({ page: "survey", id: "3f9a0c1b2d4e", sheet: null });
    expect(parseRoute("/s/3f9a0c1b2d4e", "?sheet=1")).toEqual({ page: "survey", id: "3f9a0c1b2d4e", sheet: 1 });
    expect(parseRoute("/s/run_2-b", "?utm=x&sheet=0")).toEqual({ page: "survey", id: "run_2-b", sheet: 0 });
  });

  it("ignores a sheet that is not a concept's index", () => {
    for (const search of ["?sheet=", "?sheet=-1", "?sheet=1.5", "?sheet=one", "?sheet=999", "?sheets=1"]) {
      expect(parseRoute("/s/abc", search)).toEqual({ page: "survey", id: "abc", sheet: null });
    }
  });

  it("reads My places and the privacy note", () => {
    expect(parseRoute("/me", "")).toEqual({ page: "places" });
    expect(parseRoute("/me/", "?utm_source=x")).toEqual({ page: "places" });
    expect(parseRoute("/privacy", "")).toEqual({ page: "privacy" });
    expect(parseRoute("/privacy/", "?from=footer")).toEqual({ page: "privacy" });
    expect(isPage({ page: "places" })).toBe(true);
    expect(isPage({ page: "privacy" })).toBe(true);
    expect(isPage({ page: "brief" })).toBe(false);
    expect(isPage({ page: "survey", id: "r1", sheet: null })).toBe(false);
  });

  it("reads the examples page, whatever the query", () => {
    expect(parseRoute("/examples", "")).toEqual({ page: "examples" });
    expect(parseRoute("/examples/", "?utm_source=film")).toEqual({ page: "examples" });
    expect(isPage({ page: "examples" })).toBe(true);
    for (const path of ["/example", "/examples/x", "/examples/b21ec69b0e92", "/s/examples/x", "/examplesx"]) {
      expect(parseRoute(path, "")).toEqual({ page: "brief" });
    }
  });

  it("reads a launch kit and its report by the kit's token, whatever the query", () => {
    const token = "Zq3_x-9KpL0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV";
    expect(parseRoute(`/k/${token}`, "")).toEqual({ page: "kit", token });
    expect(parseRoute(`/k/${token}/`, "?utm_source=poster&utm_medium=qr")).toEqual({ page: "kit", token });
    expect(parseRoute(`/k/${token}/dossier`, "")).toEqual({ page: "dossier", token });
    expect(parseRoute(`/k/${token}/dossier/`, "?sheet=1")).toEqual({ page: "dossier", token });
    expect(parseRoute(`/k/${"a".repeat(64)}`, "")).toEqual({ page: "kit", token: "a".repeat(64) });
    expect(isPage({ page: "kit", token })).toBe(true);
    expect(isPage({ page: "dossier", token })).toBe(true);
  });

  it("shows the brief for every other address", () => {
    for (const path of [
      "/",
      "",
      "/s",
      "/s/",
      "/s/abc/extra",
      "/s/a%20b",
      "/s/a.b",
      "/me/x",
      "/mine",
      "/privacy/x",
      "/privacy-policy",
      "/k",
      "/k/",
      "/k/a.b",
      "/k/a%20b",
      "/k/tok_1/extra",
      "/k/tok_1/dossier/extra",
      "/k/tok_1/report",
      "/k//dossier",
      "/kits/tok_1",
      "/p",
      "/p/",
      "/p/a.b",
      "/p/c4f1e2/extra",
      "/pledge/c4f1e2",
      "/founder",
      "/founders/x",
      "/elsewhere",
    ]) {
      expect(parseRoute(path, "?sheet=1")).toEqual({ page: "brief" });
    }
    expect(parseRoute(`/s/${"a".repeat(65)}`, "")).toEqual({ page: "brief" });
    expect(parseRoute(`/k/${"a".repeat(65)}`, "")).toEqual({ page: "brief" });
    expect(parseRoute(`/k/${"a".repeat(65)}/dossier`, "")).toEqual({ page: "brief" });
    expect(parseRoute(`/p/${"a".repeat(65)}`, "")).toEqual({ page: "brief" });
  });

  it("builds a survey's address, with the open sheet, and reads it back", () => {
    expect(surveyUrl("3f9a0c1b2d4e")).toBe("/s/3f9a0c1b2d4e");
    expect(surveyUrl("3f9a0c1b2d4e", 2)).toBe("/s/3f9a0c1b2d4e?sheet=2");
    expect(surveyUrl("3f9a0c1b2d4e", null)).toBe("/s/3f9a0c1b2d4e");
    for (const sheet of [null, 0, 2]) {
      const url = new URL(surveyUrl("3f9a0c1b2d4e", sheet), "https://walk-in.example");
      expect(parseRoute(url.pathname, url.search)).toEqual({ page: "survey", id: "3f9a0c1b2d4e", sheet });
    }
  });

  it("builds My places', the privacy note's and the examples' addresses and reads them back", () => {
    expect(pageUrl({ page: "places" })).toBe(PLACES_URL);
    expect(pageUrl({ page: "privacy" })).toBe(PRIVACY_URL);
    expect(pageUrl({ page: "examples" })).toBe(EXAMPLES_URL);
    expect(EXAMPLES_URL).toBe("/examples");
    for (const route of [{ page: "places" }, { page: "privacy" }, { page: "examples" }] as const) {
      expect(parseRoute(pageUrl(route), "")).toEqual(route);
    }
    expect(samePage({ page: "places" }, { page: "places" })).toBe(true);
    expect(samePage({ page: "privacy" }, { page: "privacy" })).toBe(true);
    expect(samePage({ page: "examples" }, { page: "examples" })).toBe(true);
    expect(samePage({ page: "places" }, { page: "privacy" })).toBe(false);
    expect(samePage({ page: "examples" }, { page: "places" })).toBe(false);
  });

  it("builds a kit's and its report's addresses and reads them back", () => {
    expect(kitUrl("tok_1")).toBe("/k/tok_1");
    expect(dossierUrl("tok_1")).toBe("/k/tok_1/dossier");
    expect(pageUrl({ page: "kit", token: "tok_1" })).toBe("/k/tok_1");
    expect(pageUrl({ page: "dossier", token: "tok_1" })).toBe("/k/tok_1/dossier");
    for (const route of [
      { page: "kit", token: "tok_1" },
      { page: "dossier", token: "A-b_9" },
    ] as const) {
      const url = new URL(pageUrl(route), "https://walk-in.example");
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
  });

  it("tells one kit's pages from another's, so Back and Forward between them change the page", () => {
    expect(samePage({ page: "kit", token: "a" }, { page: "kit", token: "a" })).toBe(true);
    expect(samePage({ page: "kit", token: "a" }, { page: "kit", token: "b" })).toBe(false);
    expect(samePage({ page: "kit", token: "a" }, { page: "dossier", token: "a" })).toBe(false);
    expect(samePage({ page: "dossier", token: "a" }, { page: "dossier", token: "a" })).toBe(true);
    expect(samePage({ page: "kit", token: "a" }, { page: "places" })).toBe(false);
  });

  it("reads the Founders page, whatever the query", () => {
    expect(parseRoute("/founders", "")).toEqual({ page: "founders" });
    expect(parseRoute("/founders/", "?utm_source=poster")).toEqual({ page: "founders" });
    expect(isPage({ page: "founders" })).toBe(true);
    expect(pageUrl({ page: "founders" })).toBe(FOUNDERS_URL);
    expect(FOUNDERS_URL).toBe("/founders");
    expect(parseRoute(pageUrl({ page: "founders" }), "")).toEqual({ page: "founders" });
    expect(samePage({ page: "founders" }, { page: "examples" })).toBe(false);
  });

  it("reads a campaign by its id, and what PayPal sent the supporter back with", () => {
    const plain: CampaignRoute = { page: "campaign", id: "c4f1e2", pledge: null, cancelled: false };
    expect(parseRoute("/p/c4f1e2", "")).toEqual(plain);
    expect(parseRoute("/p/c4f1e2/", "?utm_source=poster&utm_medium=qr")).toEqual(plain);
    expect(parseRoute(`/p/${"a".repeat(64)}`, "")).toEqual({ ...plain, id: "a".repeat(64) });
    // PayPal adds its own token and PayerID to the return address.
    expect(parseRoute("/p/c4f1e2", "?pledge=5O190127TN364715T&token=5O190127TN364715T&PayerID=QYR5Z8XDVJNXQ")).toEqual({
      ...plain,
      pledge: "5O190127TN364715T",
    });
    expect(parseRoute("/p/c4f1e2", "?cancelled=1&token=5O190127TN364715T")).toEqual({ ...plain, cancelled: true });
    // The server's own pledge id, which its return address carries.
    expect(parseRoute("/p/c4f1e2", "?pledge=pl_Zq3-x9KpL0&token=5O190127TN364715T&PayerID=QYR5Z8XDVJNXQ")).toEqual({
      ...plain,
      pledge: "pl_Zq3-x9KpL0",
    });
    expect(isPage(plain)).toBe(true);
  });

  it("ignores a pledge that is not an order id, and a cancel that is not 1", () => {
    for (const search of ["?pledge=", "?pledge=a%20b", "?pledge=a/b", `?pledge=${"A".repeat(65)}`, "?cancelled=yes", "?cancelled=0"]) {
      expect(parseRoute("/p/c4f1e2", search)).toEqual({ page: "campaign", id: "c4f1e2", pledge: null, cancelled: false });
    }
  });

  it("builds a campaign's address without PayPal's query, so returning from PayPal stays on the same page", () => {
    expect(campaignUrl("c4f1e2")).toBe("/p/c4f1e2");
    const back: CampaignRoute = { page: "campaign", id: "c4f1e2", pledge: "5O190127TN364715T", cancelled: false };
    expect(pageUrl(back)).toBe("/p/c4f1e2");
    expect(samePage(back, { page: "campaign", id: "c4f1e2", pledge: null, cancelled: false })).toBe(true);
    expect(samePage(back, { page: "campaign", id: "other", pledge: null, cancelled: false })).toBe(false);
    const url = new URL(campaignUrl("A-b_9"), "https://walk-in.example");
    expect(parseRoute(url.pathname, url.search)).toEqual({ page: "campaign", id: "A-b_9", pledge: null, cancelled: false });
  });
});
