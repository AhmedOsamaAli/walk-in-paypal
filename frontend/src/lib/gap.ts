import type { GapRow, OsmCheck, OsmPlace } from "../api/types";
import { gapWhy, safeLink } from "./format";

export function favoritesOutsidePercent(gap: GapRow): number | null {
  const { favorites_far: outside, favorites_total: total } = gap;
  if (gap.favorites_kind !== "local" || !Number.isInteger(total) || !Number.isInteger(outside) ||
      total <= 0 || outside < 0 || outside > total) return null;
  return Math.round(outside / total * 100);
}

/** The badge of a gap whose fans travel for it. Surveys saved before the wording changed say "Locals travel for it". */
export const TRAVEL_READING = "People here travel for it";
const LEGACY_READINGS: Readonly<Record<string, string>> = { "Locals travel for it": TRAVEL_READING };

/** The server's badge as it reads today, older surveys' wording included. */
export function readingLabel(reading: string | null | undefined): string | null {
  if (!reading) return null;
  return LEGACY_READINGS[reading] ?? reading;
}

/** The badge's tone: a real gap is highlighted, a crowded or uncertain one is muted. */
export function readingTone(reading: string | null | undefined): "strong" | "weak" | "" {
  const label = readingLabel(reading);
  if (label === "Clear gap" || label === "Under-supplied" || label === TRAVEL_READING) return "strong";
  if (label === "Crowded" || label === "Thin data" || label === "Atypical") return "weak";
  return "";
}

/**
 * The one evidence line that explains the badge; the rest are in the expanded row. The server's lines name the area as
 * it was measured: "inside the 10-minute walk", "inside the 30-minute drive", "inside the 10 km drive"; the trip to the
 * favorites says "outside the walk" for a walk and the whole area for a drive ("outside the 30-minute drive").
 */
export function leadLine(gap: GapRow): string {
  const why = gap.why ?? [];
  const find = (pattern: RegExp) => why.find((line) => pattern.test(line));
  switch (readingLabel(gap.reading)) {
    case TRAVEL_READING:
      return find(/\bare (?:already inside|outside) the /) ?? why[0] ?? gapWhy(gap);
    case "Clear gap":
    case "Under-supplied":
    case "Crowded":
      return find(/(?<!already )inside the (?:\d+-minute|\d+(?:\.\d+)? km) (?:walk|drive)\b/) ?? why[0] ?? gapWhy(gap);
    case "Thin data":
    case "Atypical":
      return why.at(-1) ?? gapWhy(gap);
    default:
      return why[0] ?? gapWhy(gap);
  }
}

/** "Inside walk", "Inside drive": the gap row's short label for the places of the kind inside the area ("the drive"). */
export function insideShort(area: string): string {
  return `Inside ${area.replace(/^the /, "")}`;
}

/** OpenStreetMap's credit, shown wherever its places are (its data is under the Open Database License). */
export const OSM_CREDIT = "© OpenStreetMap contributors";
export const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const OSM_HOST = "www.openstreetmap.org";

/** The places of the gap's kind only OpenStreetMap shows inside the walk, each with a location and its OpenStreetMap page. */
export function osmExtra(gap: GapRow): OsmPlace[] {
  return (gap.osm?.extra ?? []).filter(
    (place) =>
      typeof place.name === "string" &&
      place.name.trim() !== "" &&
      Number.isFinite(place.lat) &&
      Number.isFinite(place.lon) &&
      osmLink(place.url) !== null,
  );
}

/** A link to an OpenStreetMap page, or null for anything else. */
export function osmLink(url: unknown): string | null {
  const href = safeLink(url);
  return href && new URL(href).host === OSM_HOST ? href : null;
}

/** Places of the kind inside the walk, Qloo's and OpenStreetMap's extras: what the gap is scored on. */
export function supplyCount(gap: GapRow): number {
  return gap.nearby_count + osmExtra(gap).length;
}

/** The note for an area too large to read from OpenStreetMap, as the server words it (app/survey/pipeline.py). */
export const OSM_TOO_BIG = "Not cross-checked: OpenStreetMap is read for areas up to 30 km², and this one is larger.";

/**
 * Why a gap was not cross-checked, in the server's own words when it sends them, else from the reason; null when it was
 * checked, or for surveys saved before the cross-check existed.
 */
export function osmUnchecked(osm: OsmCheck | null | undefined): string | null {
  if (!osm || osm.checked) return null;
  const note = typeof osm.note === "string" ? osm.note.trim() : "";
  if (note) return note;
  // The server's reasons ("too_big": the area is larger than OpenStreetMap's free servers are asked about).
  const reason = osm.reason;
  if (reason === "unmapped") return "Not cross-checked: no OpenStreetMap tag reliably marks this kind of place.";
  if (reason === "unavailable") return "Not cross-checked: OpenStreetMap did not answer in time.";
  if (reason === "too_big") return OSM_TOO_BIG;
  return "Not cross-checked with OpenStreetMap.";
}

/**
 * What the cross-check found when every place it shows is one Qloo lists too, or why they were not compared; `area` is
 * the area inside a sentence ("the walk", "the drive").
 */
export function osmConfirmed(osm: OsmCheck | null | undefined, area: string): string | null {
  if (!osm?.checked || osm.extra.length) return null;
  if (osm.note) return osm.note;
  if (!osm.count) return `OpenStreetMap shows none inside ${area} either.`;
  return `OpenStreetMap shows ${osm.count} inside ${area}, all on Qloo's list too.`;
}

/** "331 m away · shop=pastry" */
export function osmDetail(place: OsmPlace): string {
  return [place.distance_m != null ? `${place.distance_m} m away` : "", place.tag ?? ""].filter(Boolean).join(" · ");
}
