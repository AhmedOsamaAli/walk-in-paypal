/* The full-screen map's rules (map/SurveyMap.tsx, map/controller.ts): how close it frames a new site, what its card,
   the brief, the survey's header and the search boxes call the site, its link to Google Maps, its control's words, and
   the history entry that lets Back leave it. */
import { reachM } from "../map/geometry";
import { asArea, type Area } from "./area";
import { coords } from "./format";

/** Street level: close enough to pick out one storefront. */
export const SITE_ZOOM = 16;
/** Still street level, one step out: where a walk too wide for the screen at 16 shows whole. */
export const STREET_ZOOM = 15;

/**
 * The zoom a new site is framed at on the full-screen map, given the zoom at which its whole walk fits the screen:
 * street level (16), or a step out when the walk would not fit there, as on a phone, where a 10-minute walk at 16 is
 * wider than the screen; never further out than 15.
 */
export function streetZoom(walkFits: number): number {
  return Math.min(SITE_ZOOM, Math.max(STREET_ZOOM, walkFits));
}

/**
 * How far the area may reach, in meters: the radius of the circle drawn when it cannot be traced (a walk of `minutes` ×
 * 80 m, a drive of `minutes` × 400 m, a road distance of `km` × 700 m). A bare number of minutes is a walk.
 */
export const walkReach = (area: Area | number): number => reachM(asArea(area));

/**
 * The label a site placed by hand on the map holds until its address comes (state/site.ts usePinAddress). Never shown:
 * meanwhile, and when no address comes, the site goes by its coordinates.
 */
export const DROPPED_PIN = "Dropped pin";

/** A label in the coordinates' own words ("N 30.0626 · E 31.2197"): a pin surveyed before its address came. */
const COORDS_LABEL = /^[NS] \d+(?:\.\d+)? · [EW] \d+(?:\.\d+)?$/;

/** Whether a site's label names no place: a pin placed by hand, without its address yet or for good. */
export function unnamed(label: string | null | undefined): boolean {
  const name = label?.trim() ?? "";
  return !name || name === DROPPED_PIN || COORDS_LABEL.test(name);
}

/** What the site is called wherever it shows: its address, or its coordinates for a pin placed by hand. */
export function spotTitle(label: string | null | undefined, lat: number, lon: number): { text: string; isCoords: boolean } {
  const name = label?.trim() ?? "";
  return unnamed(name) ? { text: coords(lat, lon), isCoords: true } : { text: name, isCoords: false };
}

/** The site's name as shown, and as a survey sends it: never "Dropped pin". */
export const siteName = (site: { label: string; lat: number; lon: number }): string =>
  spotTitle(site.label, site.lat, site.lon).text;

/** The site on Google Maps, for a look at the street itself: a search for its coordinates, in a new tab. */
export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/**
 * What a search box says once a site is set, however it was set (SearchBox.tsx): the site's name, or nothing for a pin
 * placed by hand until its address comes, since its coordinates are no address to search for.
 */
export function searchText(label: string | null | undefined): string {
  const name = label?.trim() ?? "";
  return unnamed(name) ? "" : name;
}

/** The corner control's name and tooltip, either way. */
export function expandLabel(expanded: boolean): string {
  return expanded ? "Exit full screen" : "Full-screen map";
}

/** The history entry the full-screen map adds, so the browser's Back shrinks it instead of leaving the page. */
export const FULL_MAP_ENTRY = { walkinFullMap: true } as const;

export function isFullMapEntry(state: unknown): boolean {
  return typeof state === "object" && state !== null && "walkinFullMap" in state && state.walkinFullMap === true;
}

type MapBox = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/** Leave attribution readable and lift the small switcher only above panels that share its corner. */
export function mapModeBottom(view: MapBox, control: MapBox, panels: MapBox[]): number {
  const height = control.bottom - control.top;
  let clearance = 52;
  for (const panel of [...panels].sort((a, b) => b.top - a.top)) {
    if (panel.right <= control.left - 8 || panel.left >= control.right + 8 || panel.top >= view.bottom) continue;
    if (panel.bottom > view.bottom - clearance - height - 8) clearance = Math.max(clearance, view.bottom - panel.top + 10);
  }
  return Math.max(12, Math.min(clearance, view.bottom - view.top - height - 12));
}
