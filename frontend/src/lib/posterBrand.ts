/* A project's art direction, not the app's global theme. Keywords guide original artwork, never advertising claims. */
import type { PosterInput } from "./poster";
export const POSTER_DIRECTIONS = ["botanical", "coastal", "kinetic", "editorial", "night", "workshop"] as const;
export type PosterDirection = (typeof POSTER_DIRECTIONS)[number];
export type PosterChoice = "auto" | PosterDirection;

export interface PosterBrand {
  direction: PosterDirection;
  paper: string;
  ink: string;
  accent: string;
  accentInk: string;
  seed: number;
  initials: string;
  face: "serif" | "sans";
  centered: boolean;
}

const PALETTES: Record<PosterDirection, { paper: string; ink: string; accent: string }> = {
  botanical: { paper: "#f1eadb", ink: "#173d31", accent: "#d9b666" },
  coastal: { paper: "#e5f0ec", ink: "#143e52", accent: "#df694b" },
  kinetic: { paper: "#f0f3e7", ink: "#17203b", accent: "#c5e65a" },
  editorial: { paper: "#fff2df", ink: "#452c21", accent: "#af492f" },
  night: { paper: "#191c31", ink: "#fff4d8", accent: "#efb3d5" },
  workshop: { paper: "#f4eee3", ink: "#272331", accent: "#d36335" },
};

export function isPosterChoice(value: unknown): value is PosterChoice {
  return value === "auto" || POSTER_DIRECTIONS.some((direction) => direction === value);
}

export function isPosterColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function luminance(color: string): number {
  if (!isPosterColor(color)) throw new Error("Poster colors must be six-digit hex colors.");
  const channels = [1, 3, 5].map((at) => {
    const value = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

export function posterContrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function posterInk(background: string): string {
  return posterContrast(background, "#111111") >= posterContrast(background, "#ffffff") ? "#111111" : "#ffffff";
}

function directionOf(words: string): PosterDirection {
  if (/seafood|oyster|fish|coastal|tostada|anchor|fin\b/i.test(words)) return "coastal";
  if (/gym|fitness|strength|cardio|training|sport|dance|recovery/i.test(words)) return "kinetic";
  if (/tea\b|leaf|botanical|plant|garden|wellness|salad|herb/i.test(words)) return "botanical";
  if (/music|listening|vinyl|taproom|cocktail|night|stage|watch.part|brewery/i.test(words)) return "night";
  if (/studio|maker|repair|craft|workshop|ceramic/i.test(words)) return "workshop";
  return "editorial";
}

export function posterBrand(name: string, kind: string, keywords: readonly string[], choice: PosterChoice = "auto", accent?: string): PosterBrand {
  if (!name.trim()) throw new Error("A poster needs the business's name.");
  const direction = choice === "auto" ? directionOf([kind, ...keywords, name].join(" ")) : choice;
  const palette = PALETTES[direction];
  if (accent !== undefined && !isPosterColor(accent)) throw new Error("The poster accent is not a valid color.");
  let seed = 2166136261;
  for (const point of name.normalize("NFC")) seed = Math.imul(seed ^ (point.codePointAt(0) ?? 0), 16777619) >>> 0;
  const words = name.trim().split(/\s+/).filter((word) => !/^(the|and|&)$/i.test(word));
  const initials = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "").join("").toUpperCase();
  const color = accent ?? palette.accent;
  return {
    ...palette, direction, accent: color, accentInk: posterInk(color), seed, initials,
    face: ["kinetic", "night", "workshop"].includes(direction) ? "sans" : "serif",
    centered: direction === "botanical" || direction === "coastal",
  };
}

export interface PosterAppearance {
  choice: PosterChoice;
  accent?: string;
  logo?: string;
  logoBackground?: string;
  leadPerk?: string;
  message?: string;
  stage?: "planned" | "open";
  locator: boolean;
}

export const DEFAULT_POSTER_APPEARANCE: PosterAppearance = { choice: "auto", locator: false };

export function brandForPoster(poster: PosterInput, appearance: PosterAppearance): PosterBrand {
  const keywords = [poster.tagline ?? "", poster.headline ?? "", poster.subline ?? "", ...(poster.identity?.keywords ?? [])];
  return posterBrand(poster.name, poster.identity?.kind ?? "", keywords, appearance.choice, appearance.accent);
}

export function posterLogoMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function readPosterAppearance(text: string | null): PosterAppearance {
  if (text === null) return { ...DEFAULT_POSTER_APPEARANCE };
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("choice" in value) || !isPosterChoice(value.choice) ||
      !("locator" in value) || typeof value.locator !== "boolean") {
    throw new Error("The saved poster design could not be read.");
  }
  const accent = "accent" in value ? value.accent : undefined;
  const logo = "logo" in value ? value.logo : undefined;
  const logoBackground = "logoBackground" in value ? value.logoBackground : undefined;
  const leadPerk = "leadPerk" in value ? value.leadPerk : undefined;
  const message = "message" in value ? value.message : undefined;
  const stage = "stage" in value ? value.stage : undefined;
  if (accent !== undefined && !isPosterColor(accent)) throw new Error("The saved poster color could not be read.");
  if (logo !== undefined && (typeof logo !== "string" || logo.length > 720_000 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(logo))) {
    throw new Error("The saved poster logo could not be read.");
  }
  if (typeof logo === "string") {
    const data = atob(logo.slice(logo.indexOf(",") + 1, logo.indexOf(",") + 49));
    const mime = posterLogoMime(Uint8Array.from(data, (character) => character.charCodeAt(0)));
    if (!mime || !logo.startsWith(`data:${mime};`)) throw new Error("The saved logo is not the image it claims to be.");
  }
  if (logoBackground !== undefined && !isPosterColor(logoBackground)) throw new Error("The saved logo background could not be read.");
  if (leadPerk !== undefined && (typeof leadPerk !== "string" || !leadPerk.trim() || leadPerk.length > 80)) {
    throw new Error("The saved headline perk could not be read.");
  }
  if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 150)) throw new Error("The saved poster message could not be read.");
  if (stage !== undefined && stage !== "planned" && stage !== "open") throw new Error("The saved poster wording could not be read.");
  return { choice: value.choice, locator: value.locator, ...(accent ? { accent } : {}), ...(logo ? { logo } : {}),
    ...(logoBackground ? { logoBackground } : {}), ...(leadPerk ? { leadPerk } : {}),
    ...(message ? { message } : {}), ...(stage ? { stage } : {}) };
}
