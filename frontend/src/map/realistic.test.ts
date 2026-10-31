import { describe, expect, it } from "vitest";
import type { GapRow } from "../api/types";
import { circleWalk } from "./geometry";
import { realisticFeatures, streetViewUrl } from "./realistic";

describe("the optional realistic map reuses survey evidence", () => {
  it("uses longitude/latitude geometry and closes the actual reach without altering it", () => {
    const walk = circleWalk(30, 31, 10);
    const previous = JSON.stringify(walk);
    const features = realisticFeatures({ lat: 30, lon: 31 }, walk, null);
    const reach = features.features.find((feature) => feature.geometry.type === "Polygon");
    const site = features.features.find((feature) => feature.properties?.kind === "site");
    expect(site?.geometry).toEqual({ type: "Point", coordinates: [31, 30] });
    if (reach?.geometry.type !== "Polygon") throw new Error("Missing actual reach.");
    expect(reach.geometry.coordinates[0]?.[0]).toEqual([...walk.ring[0] ?? []].reverse());
    expect(reach.geometry.coordinates[0]?.[0]).toEqual(reach.geometry.coordinates[0]?.at(-1));
    expect(JSON.stringify(walk)).toBe(previous);
  });
  it("never makes a polygon when no reach is available", () => {
    expect(realisticFeatures({ lat: 30, lon: 31 }, null, null).features).toHaveLength(1);
  });
  it("keeps the existing pin identity and marks instead of inventing new places", () => {
    const gap: GapRow = { genre_id: "gym", genre: "Gym", demand_rank: 2, ref_rank: 8, nearby_count: 1,
      nearby_capped: false, favorites_kind: "local", favorites_total: 0, favorites_far: 0, median_favorite_km: null,
      lift: 1, relative_supply: .3, leakage: null, evidence: "ok", gap_score: 60,
      competitors: [{ id: "p1", name: "Actual gym", lat: 30.1, lon: 31.2 }] };
    const pin = realisticFeatures({ lat: 30, lon: 31 }, null, gap).features.find((feature) => feature.properties?.kind === "place");
    expect(pin?.properties).toMatchObject({ name: "Actual gym", mark: "1", key: "gym#c0" });
    expect(pin?.geometry).toEqual({ type: "Point", coordinates: [31.2, 30.1] });
  });
  it("opens real Street View externally without an API key", () => {
    const url = new URL(streetViewUrl({ lat: 30.26, lon: -97.72 }));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("map_action")).toBe("pano");
    expect(url.searchParams.get("viewpoint")).toBe("30.260000,-97.720000");
    expect(url.searchParams.has("key")).toBe(false);
  });
});
