import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StreetMap } from "../../api/sitemap";
import type { PosterCampaign, PosterInput } from "../../lib/poster";
import { PosterArt, posterLinkProblem } from "./PosterArt";

const poster: PosterInput = {
  name: "Pulse Community Gym", tagline: "Strength, cardio and recovery.",
  headline: "A place to move together", subline: "Group training and recovery.",
  claim: { kind: "new", line: "A measured claim", proof: "Internal demand and supply analysis." },
  hours: null, neighborhoods: ["East Austin"], identity: { kind: "Gym", keywords: ["Do Not Print This Artist Name"] },
};
const campaign: PosterCampaign = {
  id: "c1", amount: "25.00", goal: 40, deadline: "2026-11-20T20:00:00Z", accepting: true,
  perks: ["10% off your membership for the first year", "Your name on the founders' wall", "An invitation to the opening"],
};
const visibleWords = (html: string) => [...html.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map((match) => match[1]).join(" ");

describe("the same poster renderer in different scenarios", () => {
  it("makes the actual Founders benefit the headline and prints all the remaining perks", () => {
    const html = renderToStaticMarkup(<PosterArt poster={poster} campaign={campaign} sandbox link="https://walkin-app.pages.dev/p/c1" />);
    const printed = visibleWords(html);
    expect(html).toContain('data-scenario="founders"');
    expect(printed).toContain("10% off your membership");
    expect(printed).toContain("founders&#x27; wall");
    expect(printed).toContain("An invitation to the opening");
    expect(html.indexOf("AS A FOUNDER, YOU GET")).toBeLessThan(html.indexOf("THE PLEDGE"));
    expect(printed).toContain("Demo payments — no real money.");
    expect(printed).toContain("PayPal holds $25.");
    expect(printed).toContain("otherwise the hold is released.");
    expect(html).not.toContain("Internal demand and supply analysis.");
    expect(html).not.toContain("Do Not Print This Artist Name");
    expect(html).not.toContain("EVERYONE INSIDE THE BLUE LINE");
  });

  it("does not invent perks for a regular launch poster", () => {
    const html = renderToStaticMarkup(<PosterArt poster={poster} link="https://example.com/gym" />);
    expect(html).toContain('data-scenario="launch"');
    expect(html).toContain('data-direction="kinetic"');
    expect(html).not.toContain("AS A FOUNDER");
    expect(html).not.toContain("10% off");
    expect(html).toContain('data-poster-qr-frame="true"');
    expect(html).toContain('data-qr-quiet-modules="5"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('fill="#111111"');
  });

  it("can lead with a different actual perk without hiding the others", () => {
    const html = renderToStaticMarkup(<PosterArt poster={poster} campaign={campaign} sandbox
      appearance={{ choice: "auto", locator: false, leadPerk: campaign.perks[2] }} link="https://walkin-app.pages.dev/p/c1" />);
    const printed = visibleWords(html);
    expect(printed.indexOf("An invitation to the opening")).toBeLessThan(printed.indexOf("10% off"));
    expect(printed).toContain("founders&#x27; wall");
  });

  it("never solicits new pledges for a closed campaign", () => {
    const html = renderToStaticMarkup(<PosterArt poster={poster} campaign={{ ...campaign, accepting: false }} sandbox link="https://walkin-app.pages.dev/p/c1" />);
    expect(html).toContain("SCAN FOR STATUS");
    expect(html).toContain("no longer taking pledges");
    expect(visibleWords(html)).toContain("Original terms:");
    expect(visibleWords(html)).toContain("PayPal holds $25.");
    expect(html).not.toContain("SCAN TO JOIN");
    expect(html).not.toContain("BECOME A FOUNDING SUPPORTER");
  });

  it("only calls the locator an open business when the owner has marked a regular launch open", () => {
    const streets: StreetMap = {
      box: [[30.26, -97.74], [30.28, -97.72]], streets: {}, water: [], parks: [],
      points: 0, tolerance_m: 1, dropped: [], credit: "Map attribution",
    };
    const mapped: PosterInput = {
      ...poster, site: [30.27, -97.73], map: { streets, trips: [], caption: null },
    };
    const appearance = { choice: "auto", locator: true, stage: "open" } as const;
    const planned = renderToStaticMarkup(<PosterArt poster={mapped} link="https://example.com/gym" appearance={{ ...appearance, stage: "planned" }} />);
    const open = renderToStaticMarkup(<PosterArt poster={mapped} link="https://example.com/gym" appearance={appearance} />);
    const founders = renderToStaticMarkup(<PosterArt poster={mapped} link="https://walkin-app.pages.dev/p/c1" campaign={campaign} appearance={appearance} />);
    expect(planned).toContain("PLANNED LOCATION");
    expect(planned).not.toContain("FIND US HERE");
    expect(open).toContain("FIND US HERE");
    expect(open).not.toContain("PLANNED LOCATION");
    expect(founders).toContain("PLANNED LOCATION");
    expect(founders).not.toContain("FIND US HERE");
  });

  it("rejects private receipts, credentials and individual approval links as public QR destinations", () => {
    for (const link of [`https://walkin-app.pages.dev/r/${"x".repeat(32)}`, "https://user:password@example.com/",
      "https://www.sandbox.paypal.com/checkoutnow?token=buyer", "javascript:alert(1)"]) {
      expect(posterLinkProblem(link)).not.toBeNull();
    }
    expect(posterLinkProblem("https://example.com/business")).toBeNull();
    expect(posterLinkProblem("https://walkin-app.pages.dev/p/c1")).toBeNull();
  });
});
