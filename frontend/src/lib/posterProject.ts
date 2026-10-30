import type { Campaign } from "../api/founders";
import type { Kit } from "../api/kit";
import type { PosterInput } from "./poster";

const TECHNICAL = /\b(?:parcel|qloo|over[- ]?index|gap score|same[- ]size|within (?:an? )?\d+[- ]minute|crossing town)\b/i;
export const openingClaim = (text: string) => /\b(?:now open|is open|are open|open daily|open every|now available|ready|provided)\b|^open\b/i.test(text);
const words = (text: string) => text.toLowerCase().replace(/&/g, " and ").match(/[a-z0-9]+/g) ?? [];

function customerMessage(text: string, kit: Kit): boolean {
  const ordinary = new Set([...words(kit.concept.name), ...words(kit.concept.genre),
    "a", "an", "the", "and", "new", "now", "your", "local", "here", "in", "at", "on", "is", "our", "place", "visit", "discover"]);
  const plain = text.replace(/[\u2010-\u2015\u2212]/g, "-");
  return Boolean(text.trim()) && text.length <= 150 && !TECHNICAL.test(plain) &&
    words(text).some((word) => !ordinary.has(word));
}

/** Reuse the checked ad copy. Raw concept words guide the illustration but are never printed as new claims. */
export function posterForKit(kit: Kit): PosterInput {
  const offer = new Set((kit.dossier.offer?.sheet ?? []).flatMap((item) => words(item.item)));
  const candidates = [
    ...(kit.copy.google_search?.headlines ?? []), kit.poster.headline ?? "",
    kit.copy.nextdoor?.headline ?? "", kit.copy.meta?.headline ?? "",
  ].filter((line) => customerMessage(line, kit));
  const messages = [...new Set(candidates)].sort((first, second) =>
    words(second).filter((word) => offer.has(word)).length - words(first).filter((word) => offer.has(word)).length);
  const descriptions = [...(kit.copy.google_search?.descriptions ?? []), kit.poster.subline ?? "",
    kit.copy.meta?.description ?? ""].filter((line) => customerMessage(line, kit) && !openingClaim(line));
  return {
    ...kit.poster,
    headline: messages.find((line) => !openingClaim(line)) ?? null,
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
