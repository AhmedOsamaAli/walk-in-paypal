import { describe, expect, it } from "vitest";
import type { Kit } from "../api/kit";
import { completePosterCopy, posterForKit } from "./posterProject";

const pastry: Kit = {
  concept: { index: 0, name: "The Daily Grind", genre: "Patisserie" }, claims: [],
  poster: { name: "The Daily Grind", tagline: "Enjoy artisanal coffee and freshly",
    headline: "Freshly Baked Pastries", subline: "The Daily Grind: your new coffee shop. Enjoy artisanal coffee and freshly",
    claim: null, hours: null, minutes: 10, ring: [], site: [30, 31], neighborhoods: ["Test neighborhood"] },
  copy: { google_search: { channel: "Search", claims: [], source: "agent",
    headlines: ["Freshly Baked Pastries", "Your New Coffee Shop"],
    descriptions: ["Enjoy artisanal coffee and freshly", "Butter croissants and fruit tarts."] } },
  dossier: { sections: [] }, links: [], rejected: [], notes: [], mode: "agent", model: "test", built_at: "2026-10-31",
};

describe("customer-facing complete poster copy", () => {
  it("reproduces and repairs the Daily Grind pastry example without making up new claims", () => {
    const poster = posterForKit(pastry);
    expect(poster.headline).toBe("Freshly Baked Pastries");
    expect(poster.tagline).toBeNull();
    expect(poster.subline).toBe("Butter croissants and fruit tarts.");
    expect(poster.messages).not.toContain("Your New Coffee Shop");
  });
  it.each(["Freshly baked and", "Enjoy artisanal coffee and freshly", "A place for", "Try something…"])(
    "does not print an unfinished line: %s", (text) => { expect(completePosterCopy(text)).toBeNull(); },
  );
  it("keeps an existing complete sentence rather than completing a clipped second sentence", () => {
    expect(completePosterCopy("Butter croissants. Try our freshly", true)).toBe("Butter croissants.");
    expect(completePosterCopy("Butter croissants and fruit tarts", true)).toBeNull();
    expect(completePosterCopy("Pastries people come for.", true)).toBe("Pastries people come for.");
    expect(completePosterCopy("Kouign amann no bakery nearby is known for.", true)).toBe("Kouign amann no bakery nearby is known for.");
  });
});
