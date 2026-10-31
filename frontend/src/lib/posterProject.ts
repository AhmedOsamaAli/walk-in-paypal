import type { Campaign } from "../api/founders";
import type { Kit } from "../api/kit";
import type { PosterInput } from "./poster";
import { posterSubject } from "./posterBrand";

const TECHNICAL = /\b(?:parcel|qloo|over[- ]?index|gap score|same[- ]size|within (?:an? )?\d+[- ]minute|crossing town)\b/i;
export const openingClaim = (text: string) => /\b(?:now open|is open|are open|open daily|open every|now available|ready|provided)\b|^open\b/i.test(text);
const words = (text: string) => text.toLowerCase().replace(/&/g, " and ").match(/[a-z0-9]+/g) ?? [];
const DANGLING = /\b(?:and|or|the|a|an|our|your|freshly|including|featuring|such as)\s*[,;:\u2026.!?]*$|\b(?:with|for|from|of|to)\s*[,;:]*$/i;

/** Keep whole source sentences; never turn a clipped ad into a new factual claim. */
export function completePosterCopy(text: string | null | undefined, sentence = false): string | null {
  if (!text?.trim()) return null;
  const line = text.trim().replace(/\s+/g, " ");
  const whole = [...line.matchAll(/(?:^|(?<=[.!?])\s+)([^.!?]+[.!?])(?=\s|$)/g)]
    .flatMap((match) => match[1] ? [match[1]] : []);
  const selected = sentence ? whole.filter((part) => !DANGLING.test(part)).join(" ") : line;
  if (!selected || selected.length > 150 || DANGLING.test(selected) || /(?:\.{3}|\u2026)$/.test(selected)) return null;
  return selected;
}

function customerMessage(text: string, kit: Kit): boolean {
  const ordinary = new Set([...words(kit.concept.name), ...words(kit.concept.genre),
    "a", "an", "the", "and", "new", "now", "your", "local", "here", "in", "at", "on", "is", "our", "place", "visit", "discover"]);
  const plain = text.replace(/[\u2010-\u2015\u2212]/g, "-");
  const subject = posterSubject(kit.concept.name, kit.concept.genre, []);
  const mismatch = subject === "pastry" && /\b(?:your new|our|a new) coffee shop\b/i.test(plain);
  return completePosterCopy(text) !== null && !mismatch && !TECHNICAL.test(plain) &&
    words(text).some((word) => !ordinary.has(word));
}

/** Reuse the checked ad copy. Raw concept words guide the illustration but are never printed as new claims. */
export function posterForKit(kit: Kit): PosterInput {
  const offer = new Set((kit.dossier.offer?.sheet ?? []).flatMap((item) => words(item.item)));
  const offerLines = (kit.dossier.offer?.sheet ?? []).map((item) => item.item);
  const candidates = [
    ...(kit.copy.google_search?.headlines ?? []), kit.poster.headline ?? "",
    kit.copy.nextdoor?.headline ?? "", kit.copy.meta?.headline ?? "",
    ...offerLines,
  ].filter((line) => customerMessage(line, kit));
  const messages = [...new Set(candidates)].sort((first, second) =>
    words(second).filter((word) => offer.has(word)).length - words(first).filter((word) => offer.has(word)).length);
  const headline = messages.find((line) => !openingClaim(line)) ?? null;
  const descriptions = [...(kit.copy.google_search?.descriptions ?? []), kit.poster.subline ?? "",
    kit.copy.meta?.description ?? ""].map((line) => completePosterCopy(line, true))
    .filter((line): line is string => line !== null && customerMessage(line, kit) && !openingClaim(line) &&
      !/\b(?:your new|new on the block|come say hello|walk in and say hello|spotless facilities)\b/i.test(line) &&
      words(line).join(" ") !== words(headline ?? "").join(" "));
  return {
    ...kit.poster,
    tagline: completePosterCopy(kit.poster.tagline),
    headline,
    subline: descriptions[0] ?? null,
    messages,
    location_label: kit.dossier.cover?.site_label ?? kit.poster.neighborhoods.join(" · "),
    identity: { kind: kit.concept.genre, keywords: (kit.dossier.offer?.sheet ?? []).map((item) => item.item) },
  };
}

function completeShortLine(text: string): string | null {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return first && first.length <= 100 ? first : null;
}

/** A campaign already keeps its business and terms, so its poster still works if its original kit is gone. */
export function posterForCampaign(campaign: Campaign): PosterInput {
  return {
    name: campaign.name,
    tagline: completeShortLine(campaign.concept.summary) ?? campaign.concept.genre,
    headline: null, subline: null, hours: null, claim: null,
    site: [campaign.place.lat, campaign.place.lon],
    neighborhoods: [campaign.place.label],
    location_label: campaign.place.label,
    identity: { kind: campaign.concept.genre, keywords: [campaign.concept.summary, campaign.pitch] },
  };
}
