import type { FeatureCollection } from "geojson";
import type { GapRow, HeatCell, Walk } from "../api/types";
import { cellSpan } from "./geometry";
import { gapPins } from "./pins";
import type { MapPoint } from "./controller";

export function streetViewUrl(point: MapPoint): string {
  const query = new URLSearchParams({ api: "1", map_action: "pano", viewpoint: `${point.lat.toFixed(6)},${point.lon.toFixed(6)}` });
  return `https://www.google.com/maps/@?${query}`;
}

/** Reuse the exact evidence and coordinates already shown by the 2D map, without another Qloo query. */
export function realisticFeatures(site: MapPoint, walk: Walk | null, gap: GapRow | null, cells: HeatCell[] = []): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  if (walk && walk.ring.length >= 3) {
    const ring = walk.ring.map(([lat, lon]) => [lon, lat]);
    const first = ring[0], last = ring.at(-1);
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([...first]);
    features.push({ type: "Feature", properties: { kind: "reach" }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  for (const cell of cells) {
    if (!Number.isFinite(cell.affinity) || cell.affinity < .45) continue;
    const [lat, lon] = cellSpan(cell.geohash);
    features.push({ type: "Feature", properties: { kind: "taste", strength: .04 + .32 * ((cell.affinity - .45) / .55) ** 1.8 },
      geometry: { type: "Polygon", coordinates: [[[cell.lon - lon / 2, cell.lat - lat / 2], [cell.lon + lon / 2, cell.lat - lat / 2],
        [cell.lon + lon / 2, cell.lat + lat / 2], [cell.lon - lon / 2, cell.lat + lat / 2], [cell.lon - lon / 2, cell.lat - lat / 2]]] } });
  }
  features.push({ type: "Feature", properties: { kind: "site" }, geometry: { type: "Point", coordinates: [site.lon, site.lat] } });
  for (const pin of gap ? gapPins(gap).pins : []) {
    features.push({ type: "Feature", properties: { kind: "place", key: pin.key, name: pin.name, mark: pin.mark, role: pin.role },
      geometry: { type: "Point", coordinates: [pin.lon, pin.lat] } });
  }
  return { type: "FeatureCollection", features };
}
