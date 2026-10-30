/* One customer-first layout for launch and Founders posters. Art yields space to the offer, perks and payment terms. */
import type { Campaign } from "../api/founders";
import type { KitPoster } from "../api/kit";
import type { PosterMap } from "../api/sitemap";

export type PosterInput = Pick<KitPoster, "name" | "tagline" | "headline" | "subline" | "hours" | "claim"> &
  Partial<Pick<KitPoster, "site" | "neighborhoods">> & {
    map?: PosterMap | null;
    location_label?: string;
    identity?: { kind: string; keywords: readonly string[] };
    messages?: readonly string[];
  };
export type PosterCampaign = Pick<Campaign, "id" | "amount" | "goal" | "deadline" | "perks" | "accepting">;

export const POSTER_W = 600;
export const POSTER_H = 848;
export const POSTER_M = 38;
const INNER = POSTER_W - 2 * POSTER_M;
export type Face = "serif" | "sans" | "mono";
export const POSTER_FONTS: Record<Face, string> = {
  serif: '"Newsreader Variable", Newsreader, Georgia, serif',
  sans: '"Geist Variable", Geist, system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
};
export type Measure = (text: string, face: Face, size: number, italic?: boolean) => number;

export interface Block {
  lines: string[];
  size: number;
  y: number[];
  widths: number[];
}
export interface Box { x: number; y: number; width: number; height: number }
export interface PosterText {
  name: string;
  tagline: string | null;
  headline: string | null;
  subline: string | null;
  hours: string | null;
  /** Source proof is shown in the editor, not printed as customer advertising. */
  proof: string | null;
  back?: string | null;
  /** Every actual perk is kept; none is silently shortened to fit. */
  perks?: readonly string[];
  location?: string | null;
  sandbox?: boolean;
}
export interface PosterLayout {
  name: Block;
  tagline: Block | null;
  headline: Block | null;
  headlineLabelY: number | null;
  subline: Block | null;
  art: Box;
  perks: Block[];
  perksLabelY: number | null;
  map: Box | null;
  location: Block | null;
  bandTop: number;
  back: Block | null;
  hours: Block | null;
  qr: { x: number; y: number; size: number } | null;
  fits: boolean;
  problem: string | null;
}

export function fitLines(text: string, width: number, measure: (line: string) => number, most: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = line ? `${line} ${word}` : word;
    if (line && measure(trial) > width) { lines.push(line); line = word; }
    else line = trial;
  }
  if (line) lines.push(line);
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  let last = kept[most - 1] ?? "";
  while (last && measure(`${last}…`) > width) last = last.split(" ").slice(0, -1).join(" ");
  kept[most - 1] = `${last}…`;
  return kept;
}

export const roughMeasure: Measure = (text, face, size, italic = false) =>
  text.length * size * (face === "mono" ? .6 : face === "sans" ? .52 : italic ? .43 : .47);

function block(text: string | null, size: number, top: number, width: number, face: Face, measure: Measure, leading = 1.26): Block | null {
  if (!text?.trim()) return null;
  const lines = fitLines(text, width, (line) => measure(line, face, size), Infinity);
  return { lines, size, y: lines.map((_, i) => top + size * .82 + i * size * leading),
    widths: lines.map((line) => measure(line, face, size)) };
}
const bottom = (value: Block | null, empty: number) => value ? (value.y.at(-1) ?? empty) + value.size * .3 : empty;

function named(name: string, face: Face, measure: Measure): Block {
  let size = Math.min(92, INNER / Math.max(1, measure(name, face, 100)) * 100);
  if (size >= 61) {
    return { lines: [name], size, y: [76 + size * .82], widths: [measure(name, face, size)] };
  }
  const spaced = name.includes(" ");
  const words = spaced ? name.split(/\s+/).filter(Boolean) : Array.from(name);
  let pair = [name];
  let widest = Infinity;
  for (let i = 1; i < words.length; i++) {
    const candidate = [words.slice(0, i).join(spaced ? " " : ""), words.slice(i).join(spaced ? " " : "")];
    const span = Math.max(...candidate.map((line) => measure(line, face, 100)));
    if (span < widest) { widest = span; pair = candidate; }
  }
  size = Math.min(80, INNER / Math.max(1, widest) * 100);
  return { lines: pair, size, y: pair.map((_, i) => 76 + size * (.82 + i * .98)),
    widths: pair.map((line) => measure(line, face, size)) };
}

export function layoutPoster(text: PosterText, measure: Measure, options: { qr?: boolean; locator?: boolean; face?: Face } = {}): PosterLayout {
  const face = options.face ?? "serif";
  const name = named(text.name, face, measure);
  let y = bottom(name, 76) + 10;
  const tagline = block(text.tagline, 17.5, y, INNER, "serif", measure);
  y = bottom(tagline, y) + (tagline ? 12 : 0);
  const headlineLabelY = text.back && text.headline ? y + 11 : null;
  if (headlineLabelY !== null) y += 24;
  const headline = block(text.headline, 29, y, INNER, face, measure, 1.12);
  y = bottom(headline, y) + (headline ? 14 : 0);
  const subline = block(text.subline, 16, y, INNER, "sans", measure);
  y = bottom(subline, y) + (subline ? 12 : 0);
  const bandTop = POSTER_H - 200;
  const perkValues = (text.perks ?? []).filter((line) => line.trim());
  const perkHeight = perkValues.reduce((sum, line) => sum + (block(line, 16.5, 0, INNER - 24, "sans", measure)?.y.length ?? 0) * 20.8 + 9, 0);
  const locationHeight = text.location ? bottom(block(text.location, 11.5, 0, INNER, "sans", measure), 0) + 8 : 0;
  const mapHeight = options.locator ? 94 : 0;
  const room = bandTop - 42 - y - perkHeight - (perkValues.length ? 28 : 0) - locationHeight - mapHeight;
  const artHeight = room < 48 ? 0 : Math.min(text.back ? 142 : 226, room);
  const art = { x: POSTER_M, y, width: INNER, height: artHeight };
  y += artHeight + (artHeight ? 15 : 0);
  const perksLabelY = perkValues.length ? y + 11 : null;
  if (perksLabelY !== null) y += 26;
  const perks = perkValues.map((line) => {
    const perk = block(line, 16.5, y, INNER - 24, "sans", measure);
    if (!perk) throw new Error("An empty perk reached the poster layout.");
    y = bottom(perk, y) + 10;
    return perk;
  });
  const map = options.locator ? { x: POSTER_M, y, width: INNER, height: 94 } : null;
  if (map) y += map.height + 8;
  const location = block(text.location ?? null, 11.5, y, INNER, "sans", measure);
  y = bottom(location, y);
  const qr = options.qr === false ? null : { x: POSTER_W - POSTER_M - 132, y: bandTop + 29, size: 132 };
  const footerWidth = qr ? INNER - qr.size - 24 : INNER;
  const back = block(text.back ?? null, 12.5, bandTop + 44, footerWidth, "sans", measure);
  const hours = !back ? block(text.hours, 12, bandTop + 47, footerWidth, "sans", measure) : null;
  const blocks = [name, tagline, headline, subline, ...perks, location];
  const contentFits = y < bandTop - 4 && blocks.every((item) => (item?.widths ?? []).every((width) => width <= INNER + .5));
  const footerFits = bottom(back ?? hours, bandTop) <= POSTER_H - 66;
  const fits = contentFits && footerFits && name.size >= 26;
  return {
    name, tagline, headline, headlineLabelY, subline, art, perks, perksLabelY, map, location, bandTop, back, hours, qr, fits,
    problem: fits ? null : "This copy does not fit legibly. Turn off the locator or shorten the poster copy; no perks or terms have been omitted.",
  };
}
