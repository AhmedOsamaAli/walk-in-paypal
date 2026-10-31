import { describe, expect, it } from "vitest";
import { posterBrand, posterContrast, posterLogoMime, readPosterAppearance, POSTER_DIRECTIONS } from "./posterBrand";

describe("art direction from the business, not a global app template", () => {
  it("gives different projects different visual languages, not merely different names", () => {
    const garden = posterBrand("Harvest & Leaf", "Tea house", ["herbal tea", "plants"]);
    const gym = posterBrand("Pulse Community Gym", "Gym", ["strength training"]);
    const fish = posterBrand("The Anchor & Fin", "Seafood bar", ["fresh fish"]);
    expect([garden.direction, gym.direction, fish.direction]).toEqual(["botanical", "kinetic", "coastal"]);
    expect(new Set([garden.paper, gym.paper, fish.paper]).size).toBe(3);
    expect([garden.face, gym.face, fish.face]).toEqual(["serif", "sans", "serif"]);
  });

  it("is deterministic and still varies artwork between businesses in the same family", () => {
    expect(posterBrand("First Tea", "Tea", [])).toEqual(posterBrand("First Tea", "Tea", []));
    expect(posterBrand("First Tea", "Tea", []).seed).not.toBe(posterBrand("Second Tea", "Tea", []).seed);
  });

  it.each([
    ["The Daily Grind", "Pâtisserie", ["coffee", "books"], "pastry"],
    ["Paper & Steam", "Coffee shop", ["reading", "garden"], "coffee"],
    ["The Reading Room", "Hair salon", ["coffee"], "beauty"],
    ["Fish & Chips", "Bookstore", ["fish recipes"], "books"],
    ["Common Ground", "Other", [], "neutral"],
    ["Little Lantern", "Clothing boutique", [], "retail"],
    ["Morning Table", "Restaurant", [], "food"],
  ])("keeps %s artwork about its actual category, not an incidental name or keyword", (name, kind, keywords, subject) => {
    expect(posterBrand(name, kind, keywords).subject).toBe(subject);
    expect(posterBrand(name, kind, keywords, "coastal").subject).toBe(subject);
  });

  it("keeps normal text and accent-panel text at readable contrast", () => {
    for (const direction of POSTER_DIRECTIONS) {
      const brand = posterBrand("A business", "", [], direction);
      expect(posterContrast(brand.paper, brand.ink)).toBeGreaterThanOrEqual(4.5);
      expect(posterContrast(brand.accent, brand.accentInk)).toBeGreaterThanOrEqual(4.5);
      for (const accent of ["#ffffff", "#000000", "#ffcb00"]) {
        const customized = posterBrand("A business", "", [], direction, accent);
        expect(posterContrast(customized.accent, customized.accentInk)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("restores only well-formed per-project design settings", () => {
    expect(readPosterAppearance(null)).toEqual({ choice: "auto", locator: false });
    expect(readPosterAppearance('{"choice":"coastal","locator":true,"accent":"#123456"}')).toEqual({
      choice: "coastal", locator: true, accent: "#123456",
    });
    for (const value of ['{}', '{"choice":"unknown","locator":false}', '{"choice":"auto","locator":"yes"}',
      '{"choice":"auto","locator":false,"accent":"url(evil)"}', '{"choice":"auto","locator":false,"logo":"https://external/logo"}']) {
      expect(() => readPosterAppearance(value)).toThrow();
    }
  });

  it("recognizes raster signatures instead of trusting an extension or MIME label", () => {
    expect(posterLogoMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(posterLogoMime(new Uint8Array([255, 216, 255, 1]))).toBe("image/jpeg");
    expect(posterLogoMime(new TextEncoder().encode("<svg onload='bad'>"))).toBeNull();
    expect(posterLogoMime(new Uint8Array())).toBeNull();
  });
});
