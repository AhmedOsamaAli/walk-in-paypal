import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kit, KitView } from "../api/kit";
import { DossierPage } from "./DossierPage";

const state = vi.hoisted(() => ({ view: null as KitView | null, campaignsError: null as string | null }));
vi.mock("../state/kit", () => ({
  useKit: () => ({ load: { state: "shown", view: state.view }, restart: vi.fn(), campaignsError: state.campaignsError }),
  useKitNews: () => "",
}));
vi.mock("../state/session", () => ({
  useSession: () => ({
    phase: "ready", user: null,
    config: { paypal: { enabled: true, client_id: "test", environment: "sandbox", currency: "USD" } },
  }),
}));

const kit: Kit = {
  concept: { index: 0, name: "Pulse Community Gym", genre: "Gym" },
  claims: [], copy: { poster: { channel: "Poster", claims: [], source: "rules", headline: "Train together", subline: "Group training and recovery." } },
  poster: {
    name: "Pulse Community Gym", tagline: "Strength and recovery.", headline: "Train together",
    subline: "Group training and recovery.", claim: null, hours: null,
    minutes: 10, ring: [], site: [30.26, -97.72], neighborhoods: ["East Austin"],
  },
  links: [{ key: "poster", channel: "Poster", utm_source: "poster", utm_medium: "qr", utm_campaign: "pulse", query: "utm_source=poster&utm_medium=qr&utm_campaign=pulse" }],
  dossier: { sections: ["method"], method: { basis: "Measured evidence", items: [], freshness: "Surveyed today", limits: ["Taste is not foot traffic."] } },
  rejected: [], notes: [], mode: "rules", model: null, built_at: "2026-10-30T12:00:00Z",
};

beforeEach(() => {
  const saved = new Map<string, string>([["walk-in-site:report-test", "https://example.com/pulse"]]);
  vi.stubGlobal("window", {
    location: { origin: "https://walkin-app.pages.dev" },
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
  });
  state.view = {
    token: "report-test", status: "ready", survey_id: "survey", index: 0, name: kit.concept.name,
    created_at: kit.built_at, survey_url: "/s/survey?sheet=0", kit, error: null, campaigns: [],
  };
  state.campaignsError = null;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the report includes the customized poster, not just a link to it", () => {
  it("embeds the shared project-specific artwork and preserves the analysis", () => {
    const html = renderToStaticMarkup(<DossierPage token="report-test" />);
    expect(html).toContain('id="dz-poster"');
    expect(html).toContain('class="poster-art"');
    expect(html).toContain('data-direction="kinetic"');
    expect(html).toContain('data-scenario="launch"');
    expect(html).toContain('data-qr-quiet-modules="5"');
    expect(html).toContain("example.com/pulse");
    expect(html).toContain("Taste is not foot traffic.");
    expect(html).not.toContain("Make it yours");
  });

  it("does not print a generic launch poster before the campaign lookup finishes", () => {
    if (state.view) delete state.view.campaigns;
    const html = renderToStaticMarkup(<DossierPage token="report-test" />);
    expect(html).toContain("Checking this kit");
    expect(html).not.toContain('class="poster-art"');
    expect(html).toMatch(/disabled=""[^>]*>Save as PDF/);
  });

  it("uses the owner's saved direction and accent in the embedded artwork", () => {
    window.localStorage.setItem("walk-in-poster:kit:report-test", '{"choice":"botanical","locator":false,"accent":"#214c37"}');
    const html = renderToStaticMarkup(<DossierPage token="report-test" />);
    expect(html).toContain('data-direction="botanical"');
    expect(html).toContain('fill="#214c37"');
  });

  it("does not crash the report if this browser's saved artwork is malformed", () => {
    window.localStorage.setItem("walk-in-poster:kit:report-test", "not json");
    const html = renderToStaticMarkup(<DossierPage token="report-test" />);
    expect(html).toContain('data-direction="kinetic"');
    expect(html).toContain("This browser could not restore the saved poster design.");
    expect(html).toContain("Taste is not foot traffic.");
  });

  it("blocks report printing when campaign details cannot be checked", () => {
    state.campaignsError = "Campaign details could not be checked. Reload before printing.";
    const html = renderToStaticMarkup(<DossierPage token="report-test" />);
    expect(html).toContain(state.campaignsError);
    expect(html).not.toContain('class="poster-art"');
    expect(html).toMatch(/disabled=""[^>]*>Save as PDF/);
  });
});
