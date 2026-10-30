/* Walk-in Founders: neighbors back a business before its lease is signed. PayPal only holds each pledge; everyone is
   charged only if enough people join by the deadline. The campaign API, as docs/founders/CONTRACT.md has it. Amounts are
   strings with two decimals ("25.00"), times ISO 8601 in UTC. */
import { ApiError, post, request } from "./client";

/** GET /api/config's `paypal`: `enabled` is false when PayPal is not configured, and pledging is then off. */
export interface PayPalConfig {
  enabled: boolean;
  /** The public REST client id the JS SDK needs. */
  client_id: string | null;
  environment: "sandbox" | "live";
  currency: "USD";
}

export type CampaignStatus = "open" | "funded" | "collected" | "partial" | "expired" | "cancelled";

export interface CampaignProgress {
  /** Neighbors whose pledge PayPal holds (or collected). */
  supporters: number;
  goal: number;
  remaining: number;
  percent: number;
  /** What the pledges PayPal holds, or has collected, add up to: "300.00". A second pledge from one neighbor adds its
   * money, though not another neighbor. */
  total: string;
  funded: boolean;
}

export type PayoutStatus = "none" | "pending" | "paid" | "failed";

/** What only the campaign's owner reads. */
export interface CampaignOwner {
  /** Pledges by status: "authorized", "captured", "voided", "declined", "created"… */
  counts: Record<string, number>;
  /** The settlement, in plain words, once settled. */
  report: string[] | null;
  payout: {
    status: PayoutStatus;
    amount: string | null;
    /** Masked: "o***@example.com". */
    email: string;
  };
}

/** GET /api/campaigns/{id}: the campaign's page, with the owner's part when its owner reads it. */
export interface Campaign {
  id: string;
  status: CampaignStatus;
  /** Still takes pledges. */
  accepting: boolean;
  kit_token: string | null;
  kit_url: string | null;
  survey_url: string | null;
  source?: "owner";
  /** The business, from the kit. */
  name: string;
  place: { label: string; lat: number; lon: number; area: string };
  concept: { genre: string; summary: string };
  /** Up to three lines from the survey: why this, why here. */
  evidence: string[];
  title: string;
  pitch: string;
  perks: string[];
  how_it_works: string;
  amount: string;
  currency: "USD";
  goal: number;
  deadline: string;
  closed_at: string | null;
  progress: CampaignProgress;
  is_owner: boolean;
  owner?: CampaignOwner;
}

/** An open campaign as GET /api/campaigns lists it. */
export interface CampaignCard {
  id: string;
  /** /p/{id} */
  url: string;
  title: string;
  name: string;
  place: { label: string; lat: number; lon: number };
  /** From the point asked about; null when none was. */
  distance_km: number | null;
  amount: string;
  goal: number;
  supporters: number;
  /** What the pledges PayPal holds add up to: "75.00". */
  total: string;
  deadline: string;
}

/** A kit's open campaign (GET /api/kits/{token}/campaigns): the viewer's own first, then newest first. */
export interface KitCampaign {
  id: string;
  url: string;
  is_owner: boolean;
  status: CampaignStatus;
  amount: string;
  goal: number;
  supporters: number;
  /** What the pledges PayPal holds add up to: "75.00". */
  total: string;
  deadline: string;
}

/** A campaign as My places lists it (GET /api/me/places). */
export interface PlacesCampaign {
  id: string;
  title: string;
  status: CampaignStatus;
  supporters: number;
  /** What its pledges add up to, held or collected: "75.00". */
  total: string;
  goal: number;
  deadline: string;
  url: string;
}

/** The money terms, which the owner alone sets. */
export interface MoneyTerms {
  amount: string;
  goal: number;
  deadline: string;
  /** The owner's own perk, word for word: "10% off every visit in the first year". */
  perk: string | null;
}

export interface CampaignTerms extends MoneyTerms {
  kit_token: string;
}

export const BUSINESS_KINDS = ["cafe", "restaurant", "bakery", "bar", "gym", "studio", "salon", "barber",
  "bookstore", "shop", "grocery", "kids", "services", "other"] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];
export interface BusinessDescription {
  name: string;
  kind: BusinessKind;
  description: string;
  why_here: string;
  address: string;
  lat: number;
  lon: number;
}
export type BusinessTerms = BusinessDescription & MoneyTerms;
export type NewBusinessCampaign = BusinessTerms & { payout_email: string; title: string; pitch: string; perks: string[] };
/** POST /api/campaigns/draft: the words, or the reasons the terms are not allowed (then nothing is drafted). */
export interface CampaignDraft {
  title: string;
  pitch: string;
  perks: string[];
  how_it_works: string;
  problems: string[];
}

/** POST /api/campaigns: the terms, the payout email and the words as the owner edited them. */
export interface NewCampaign extends CampaignTerms {
  payout_email: string;
  title: string;
  pitch: string;
  perks: string[];
}

export type PledgeFlow = "buttons" | "redirect";

export interface PledgeStarted {
  order_id: string;
  /** PayPal's approval link, for the redirect flow. */
  approve_url: string | null;
  /** Private bearer token: given once, never published with the campaign. */
  receipt: string;
}

export interface PledgeReceipt {
  status: string;
  state: string;
  explanation: string;
  withdrawable: boolean;
  amount: string;
  currency: string;
  pledged_at: string;
  campaign: Pick<Campaign, "id" | "title" | "name" | "status" | "accepting" | "amount" | "currency" | "goal" |
    "deadline" | "closed_at" | "progress"> & {
    url: string;
    place: Pick<Campaign["place"], "label" | "area">;
  };
}

export interface PledgeAuthorized {
  status: "authorized" | "declined";
  progress: CampaignProgress;
}

export interface PledgeWithdrawn {
  status: "withdrawn";
  progress: CampaignProgress;
}

/** Where to look for campaigns: the nearest first, within `km` (25 unless given, at most 100). */
export interface Near {
  lat: number;
  lon: number;
  km?: number;
}

const segment = (text: string) => encodeURIComponent(text);

/** "/api/campaigns", or with the point and radius asked about: "/api/campaigns?lat=30.0444&lon=31.2357&km=25". */
export function campaignsPath(near: Near | null): string {
  if (!near) return "/api/campaigns";
  const params = new URLSearchParams({ lat: near.lat.toFixed(4), lon: near.lon.toFixed(4) });
  if (near.km !== undefined) params.set("km", String(near.km));
  return `/api/campaigns?${params.toString()}`;
}

export const founders = {
  draftBusiness: (terms: BusinessTerms) => request<CampaignDraft>("/api/business-campaigns/draft", post(terms)),
  publishBusiness: (campaign: NewBusinessCampaign) => request<{ id: string; url: string }>("/api/business-campaigns", post(campaign)),
  /** The AI's words for the terms, or why the terms are not allowed. Signed in. */
  draft: (terms: CampaignTerms) => request<CampaignDraft>("/api/campaigns/draft", post(terms)),
  /** 422 with `problems` when a term or an edited line breaks a rule; 409 with `url` when one is already open. */
  publish: (campaign: NewCampaign) => request<{ id: string; url: string }>("/api/campaigns", post(campaign)),
  campaign: (id: string, signal?: AbortSignal) => request<Campaign>(`/api/campaigns/${segment(id)}`, { signal }),
  /** Open campaigns: the nearest first around a point, else the newest first; at most 50. */
  list: (near: Near | null, signal?: AbortSignal) => request<{ campaigns: CampaignCard[] }>(campaignsPath(near), { signal }),
  /**
   * A kit's campaigns that take pledges, the viewer's own first. Apart from the kit's page, which is the same for
   * everyone and may come from a cache; these depend on who asks and change with every pledge.
   */
  forKit: async (token: string, signal?: AbortSignal) =>
    (await request<{ campaigns: KitCampaign[] }>(`/api/kits/${segment(token)}/campaigns`, { signal })).campaigns,
  /** Starts a pledge: PayPal's order for the campaign's amount, with intent AUTHORIZE; 409 once it takes no more. */
  pledge: (id: string, flow: PledgeFlow = "buttons") =>
    request<PledgeStarted>(`/api/campaigns/${segment(id)}/pledges`, post({ flow })),
  /** Places the hold once the supporter approved; 402 with `retry` when PayPal declined the way they paid. */
  authorize: (id: string, orderId: string) =>
    request<PledgeAuthorized>(`/api/campaigns/${segment(id)}/pledges/${segment(orderId)}/authorize`, post()),
  /** Releases the hold while the campaign is open. */
  withdraw: (id: string, orderId: string) =>
    request<PledgeWithdrawn>(`/api/campaigns/${segment(id)}/pledges/${segment(orderId)}/withdraw`, post()),
  /** The owner: settles now, once funded (or past the deadline). */
  close: (id: string) => request<Campaign>(`/api/campaigns/${segment(id)}/close`, post()),
  /** The owner, short of the goal: releases every hold. */
  cancel: (id: string) => request<Campaign>(`/api/campaigns/${segment(id)}/cancel`, post()),
  receipt: (token: string, signal?: AbortSignal) =>
    request<PledgeReceipt>(`/api/receipts/${segment(token)}`, { signal, cache: "no-store", referrerPolicy: "no-referrer" }),
  withdrawReceipt: (token: string) =>
    request<PledgeReceipt>(`/api/receipts/${segment(token)}/withdraw`, { ...post(), referrerPolicy: "no-referrer" }),
};

// ---------- What an error's body adds to its detail ----------

function field(error: unknown, name: string): unknown {
  if (!(error instanceof ApiError) || typeof error.body !== "object" || error.body === null) return undefined;
  return (error.body as Record<string, unknown>)[name];
}

/** Plain lines from a list of strings, or of FastAPI's validation errors ({msg}). */
function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown) =>
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null && "msg" in item && typeof item.msg === "string"
          ? item.msg
          : "",
    )
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A 402 the buttons recover from by letting the supporter choose another way to pay (PayPal declined theirs). */
export function canRetry(error: unknown): boolean {
  return error instanceof ApiError && error.status === 402 && field(error, "retry") === true;
}

/** The campaign a 409 points to: the one this user already has open for the kit. */
export function conflictUrl(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const url = field(error, "url");
  return typeof url === "string" && url.startsWith("/") ? url : null;
}

/** Why a 422 refused the campaign: its `problems`, a `detail` that lists them, or its one message. */
export function problemsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const listed = lines(field(error, "problems"));
  if (listed.length) return listed;
  const detail = field(error, "detail");
  const nested = typeof detail === "object" && detail !== null && "problems" in detail ? lines(detail.problems) : [];
  if (nested.length) return nested;
  const listedDetail = lines(detail);
  if (listedDetail.length) return listedDetail;
  return error.explained ? [error.message] : [];
}

/** GET /api/config's `paypal`, when the server sent a usable one. */
export function paypalOf(config: { paypal?: unknown } | null): PayPalConfig | null {
  const paypal = config?.paypal;
  if (typeof paypal !== "object" || paypal === null || !("enabled" in paypal)) return null;
  const { enabled, client_id: clientId, environment, currency } = paypal as Partial<PayPalConfig>;
  return {
    enabled: enabled === true && typeof clientId === "string" && clientId.trim() !== "",
    client_id: typeof clientId === "string" ? clientId : null,
    environment: environment === "live" ? "live" : "sandbox",
    currency: currency ?? "USD",
  };
}
