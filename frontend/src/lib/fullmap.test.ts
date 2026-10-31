import { describe, expect, it } from "vitest";
import {
  DROPPED_PIN,
  expandLabel,
  FULL_MAP_ENTRY,
  googleMapsUrl,
  isFullMapEntry,
  mapModeBottom,
  searchText,
  SITE_ZOOM,
  siteName,
  spotTitle,
  STREET_ZOOM,
  streetZoom,
  unnamed,
  walkReach,
} from "./fullmap";

describe("the compact bottom-right mode switcher", () => {
  const view = { left: 0, right: 390, top: 0, bottom: 844 };
  const control = { left: 278, right: 378, top: 700, bottom: 738 };
  it("keeps its normal clearance above attribution when no panel shares its corner", () => {
    expect(mapModeBottom(view, control, [])).toBe(52);
    expect(mapModeBottom(view, control, [{ left: 8, right: 240, top: 650, bottom: 820 }])).toBe(52);
  });
  it("moves above an overlapping mobile card and stacked legend, independently of DOM order", () => {
    const panels = [{ left: 8, right: 382, top: 520, bottom: 804 }, { left: 8, right: 330, top: 700, bottom: 840 }];
    expect(mapModeBottom(view, control, panels)).toBe(334);
    expect(mapModeBottom(view, control, [...panels].reverse())).toBe(334);
  });
  it("ignores the legend below the docked map and keeps the pill inside a short viewport", () => {
    expect(mapModeBottom({ ...view, bottom: 220 }, control, [{ left: 0, right: 390, top: 220, bottom: 450 }])).toBe(52);
    expect(mapModeBottom({ ...view, bottom: 100 }, control, [{ left: 0, right: 390, top: 0, bottom: 100 }])).toBe(50);
  });
});

describe("streetZoom", () => {
  it("frames a new site at street level when its whole walk fits there", () => {
    expect(streetZoom(17)).toBe(SITE_ZOOM);
    expect(streetZoom(SITE_ZOOM)).toBe(SITE_ZOOM);
  });

  it("steps out to 15 when the walk is wider than the screen at 16, and never further", () => {
    expect(streetZoom(15)).toBe(STREET_ZOOM);
    expect(streetZoom(14)).toBe(STREET_ZOOM);
    expect(streetZoom(11)).toBe(STREET_ZOOM);
  });
});

describe("walkReach", () => {
  it("reaches as far as the circle drawn for an area that cannot be traced", () => {
    expect(walkReach(10)).toBe(800);
    expect(walkReach(5)).toBe(400);
    expect(walkReach({ travel: "walk", minutes: 15 })).toBe(1200);
    expect(walkReach({ travel: "drive", minutes: 10 })).toBe(4000);
    expect(walkReach({ travel: "distance", km: 10 })).toBe(7000);
  });
});

describe("spotTitle", () => {
  it("calls the site by its address", () => {
    expect(spotTitle("Zamalek, Cairo", 30.0626, 31.2197)).toEqual({ text: "Zamalek, Cairo", isCoords: false });
  });

  it("gives a pin placed by hand its coordinates", () => {
    expect(spotTitle(DROPPED_PIN, 30.0626, 31.2197)).toEqual({ text: "N 30.0626 · E 31.2197", isCoords: true });
    expect(spotTitle(null, 40.735, -73.975)).toEqual({ text: "N 40.7350 · W 73.9750", isCoords: true });
    expect(spotTitle("  ", 40.735, -73.975).isCoords).toBe(true);
    // A pin surveyed before its address came was sent with its coordinates: they are no name either.
    expect(spotTitle("N 30.0626 · E 31.2197", 30.0626, 31.2197)).toEqual({ text: "N 30.0626 · E 31.2197", isCoords: true });
  });
});

describe("the site's name", () => {
  it("is never 'Dropped pin': a pin goes by its coordinates until its address comes", () => {
    expect(siteName({ label: DROPPED_PIN, lat: 40.7128, lon: -73.9611 })).toBe("N 40.7128 · W 73.9611");
    expect(siteName({ label: "131 South 2nd Street, Williamsburg, Brooklyn", lat: 40.7128, lon: -73.9611 })).toBe(
      "131 South 2nd Street, Williamsburg, Brooklyn",
    );
    expect(siteName({ label: " Zamalek, Cairo ", lat: 30.0626, lon: 31.2197 })).toBe("Zamalek, Cairo");
  });

  it("tells a label that names no place from an address", () => {
    expect(unnamed(DROPPED_PIN)).toBe(true);
    expect(unnamed("N 30.0626 · E 31.2197")).toBe(true);
    expect(unnamed("S 33.8688 · E 151.2093")).toBe(true);
    expect(unnamed("")).toBe(true);
    expect(unnamed(null)).toBe(true);
    expect(unnamed("Zamalek, Cairo")).toBe(false);
    expect(unnamed("N 7th Street, Williamsburg")).toBe(false);
  });
});

describe("googleMapsUrl", () => {
  it("searches Google Maps for the site's coordinates", () => {
    expect(googleMapsUrl(30.0626, 31.2197)).toBe("https://www.google.com/maps/search/?api=1&query=30.062600,31.219700");
    expect(googleMapsUrl(40.7350123, -73.9750987)).toBe("https://www.google.com/maps/search/?api=1&query=40.735012,-73.975099");
  });
});

describe("searchText", () => {
  it("names the site set, so a search box never names another one", () => {
    expect(searchText("Zamalek, Cairo")).toBe("Zamalek, Cairo");
    expect(searchText(" 26th of July Street, Zamalek ")).toBe("26th of July Street, Zamalek");
  });

  it("says nothing for a pin placed by hand, or no site", () => {
    expect(searchText(DROPPED_PIN)).toBe("");
    expect(searchText("N 30.0626 · E 31.2197")).toBe("");
    expect(searchText(null)).toBe("");
    expect(searchText(undefined)).toBe("");
    expect(searchText("  ")).toBe("");
  });
});

describe("the corner control", () => {
  it("names what it does either way", () => {
    expect(expandLabel(false)).toBe("Full-screen map");
    expect(expandLabel(true)).toBe("Exit full screen");
  });

  it("recognizes the history entry the full-screen map adds", () => {
    expect(isFullMapEntry(FULL_MAP_ENTRY)).toBe(true);
    expect(isFullMapEntry({ ...FULL_MAP_ENTRY })).toBe(true);
    expect(isFullMapEntry(null)).toBe(false);
    expect(isFullMapEntry({ walkinFullMap: "yes" })).toBe(false);
  });
});
