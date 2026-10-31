import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Campaign } from "../../api/founders";
import type { Kit } from "../../api/kit";
import type { StreetMap } from "../../api/sitemap";
import type { PosterCampaign, PosterInput } from "../../lib/poster";
import { brandForPoster, DEFAULT_POSTER_APPEARANCE } from "../../lib/posterBrand";
import { posterForCampaign, posterForKit } from "../../lib/posterProject";
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

  describe("posters for newly described businesses, not hardcoded showcase projects", () => {
    it.each([
      { id: "fresh-cedar", name: "Cedar Loop Studio", kind: "studio", summary: "Small-group ceramics and wheel-throwing classes.",
        perk: "An invitation to the studio preview", amount: "20.00", goal: 5, direction: "workshop" },
      { id: "fresh-juniper", name: "Juniper Steps Gym", kind: "gym", summary: "Strength and recovery for small training groups.",
        perk: "10% off membership for the first year", amount: "30.00", goal: 4, direction: "kinetic" },
      { id: "fresh-paper", name: "Paper Lantern Books", kind: "bookstore", summary: "Independent books and neighborhood reading groups.",
        perk: "An invitation to the first book-club evening", amount: "15.00", goal: 6, direction: "editorial" },
    ])("builds $name from its own name, description, perk and terms without a kit", (project) => {
      const record: Campaign = {
        id: project.id, status: "open", accepting: true, source: "owner", kit_token: null, kit_url: null, survey_url: null,
        name: project.name, place: { label: "East Austin, Texas", lat: 30.26, lon: -97.72, area: "" },
        concept: { genre: project.kind, summary: project.summary }, evidence: [],
        title: `Help open ${project.name}`, pitch: project.summary, perks: [project.perk],
        how_it_works: "The owner's terms.", amount: project.amount, currency: "USD", goal: project.goal,
        deadline: "2026-11-20T20:00:00Z", closed_at: null,
        progress: { supporters: 0, goal: project.goal, remaining: project.goal, percent: 0, total: "0.00", funded: false },
        is_owner: true,
      };
      const adapted = posterForCampaign(record);
      const brand = brandForPoster(adapted, DEFAULT_POSTER_APPEARANCE);
      const html = renderToStaticMarkup(<PosterArt poster={adapted} campaign={record} sandbox
        link={`https://walkin-app.pages.dev/p/${record.id}`} />);
      const printed = visibleWords(html);
      expect(brand.direction).toBe(project.direction);
      expect(printed).toContain(brand.face === "sans" ? project.name.toUpperCase() : project.name);
      expect(printed).toContain(project.perk);
      expect(printed).toContain(`$${Number(project.amount)}`);
      expect(printed).toContain(`${project.goal} neighbors join`);
      expect(printed).toContain(`walkin-app.pages.dev/p/${project.id}`);
      expect(adapted.claim).toBeNull();
      expect(html).toContain('data-scenario="founders"');
      expect(html).toContain('data-poster-problem=""');
      expect(html).toContain('data-qr-quiet-modules="5"');
      expect(printed).not.toContain("Pulse Community Gym");
    });

    it("uses a fresh launch kit's checked copy and identity without requiring a campaign", () => {
      const headline = "Bicycle repairs and tune-ups";
      const fresh: Kit = {
        concept: { index: 0, name: "Riverbend Repair", genre: "Repair shop" }, claims: [],
        copy: { poster: { channel: "Poster", claims: [], source: "rules", headline, subline: "Repairs for neighborhood riders." } },
        poster: { name: "Riverbend Repair", tagline: null, headline, subline: "Repairs for neighborhood riders.",
          claim: null, hours: null, minutes: 10, ring: [], site: [30.26, -97.72], neighborhoods: ["East Austin"] },
        links: [], dossier: { sections: [] }, rejected: [], notes: [], mode: "rules", model: null,
        built_at: "2026-10-30T12:00:00Z",
      };
      const adapted = posterForKit(fresh);
      const html = renderToStaticMarkup(<PosterArt poster={adapted} link="https://example.com/riverbend-repair" />);
      expect(adapted.headline).toBe(headline);
      expect(html).toContain('data-direction="workshop"');
      expect(html).toContain('data-scenario="launch"');
      expect(html).toContain('data-poster-problem=""');
      expect(visibleWords(html)).toContain("RIVERBEND REPAIR");
      expect(visibleWords(html)).toContain(headline);
      expect(html).not.toContain("AS A FOUNDER");
    });
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

  it("never draws a book for the reported pastry business, even with an editorial palette", () => {
    const pastry = { ...poster, name: "The Daily Grind", tagline: null, headline: "Freshly Baked Pastries",
      subline: null, identity: { kind: "Patisserie", keywords: ["coffee"] } };
    const html = renderToStaticMarkup(<PosterArt poster={pastry} link={null} />);
    expect(html).toContain('data-poster-subject="pastry"');
    expect(html).toContain('data-art="pastry"');
    const unknown = renderToStaticMarkup(<PosterArt poster={{ ...pastry, identity: { kind: "Other", keywords: [] },
      name: "Common Ground", headline: null }} link={null} />);
    expect(unknown).toContain('data-art="abstract"');
    expect(unknown).not.toContain('data-poster-subject="books"');
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
