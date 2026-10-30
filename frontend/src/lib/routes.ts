/**
 * What a URL asks for: the brief, a survey by its run id (with one concept's design sheet open), the signed-in user's
 * places, the privacy note, the finished examples, a launch kit by its token and the kit's report, the Founders
 * campaigns, or one campaign's page.
 */
export type Route = { page: "brief" } | SurveyRoute | PageRoute;

export interface SurveyRoute {
  page: "survey";
  id: string;
  /** The concept whose design sheet is open, from `?sheet=`. */
  sheet: number | null;
}

/** A launch kit (/k/{token}) or its report (/k/{token}/dossier): open to anyone with the link. */
export interface KitRoute {
  page: "kit" | "dossier";
  token: string;
}

/** A Founders campaign (/p/{id}), with what PayPal sent a supporter back with from its own page. */
export interface CampaignRoute {
  page: "campaign";
  id: string;
  /** `?pledge={id}`: the pledge the supporter approved in PayPal (ours, or PayPal's order id), which this page then
   * authorizes. */
  pledge: string | null;
  /** `?cancelled=1`: the supporter left PayPal without approving, so nothing was held. */
  cancelled: boolean;
}

/** The pages that are not the survey sheet and its map. */
export type PageRoute =
  | { page: "places" }
  | { page: "privacy" }
  | { page: "examples" }
  | { page: "founders" }
  | { page: "start-campaign" }
  | { page: "receipt"; token: string }
  | KitRoute
  | CampaignRoute;

export const BRIEF_URL = "/";
export const PLACES_URL = "/me";
export const PRIVACY_URL = "/privacy";
/** Finished surveys anyone can open before running one. */
export const EXAMPLES_URL = "/examples";
/** The open Founders campaigns, and how to start one. */
export const FOUNDERS_URL = "/founders";
export const START_CAMPAIGN_URL = "/founders/start";

const SURVEY_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/;
const PLACES_PATH = /^\/me\/?$/;
const PRIVACY_PATH = /^\/privacy\/?$/;
const EXAMPLES_PATH = /^\/examples\/?$/;
const FOUNDERS_PATH = /^\/founders\/?$/;
// A kit's token, as the server checks it (app/routes/kits.py).
const KIT_PATH = /^\/k\/([A-Za-z0-9_-]{1,64})\/?$/;
const DOSSIER_PATH = /^\/k\/([A-Za-z0-9_-]{1,64})\/dossier\/?$/;
const CAMPAIGN_PATH = /^\/p\/([A-Za-z0-9_-]{1,64})\/?$/;
const RECEIPT_PATH = /^\/r\/([A-Za-z0-9_-]{32})\/?$/;
// What PayPal sends a supporter back with: our pledge's id, or PayPal's order id ("5O190127TN364715T"); the server
// takes either.
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHEET = /^\d{1,2}$/;

/** Every path but these shows the brief. */
export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const survey = SURVEY_PATH.exec(pathname)?.[1];
  if (survey) {
    const sheet = params.get("sheet");
    return { page: "survey", id: survey, sheet: sheet !== null && SHEET.test(sheet) ? Number(sheet) : null };
  }
  if (PLACES_PATH.test(pathname)) return { page: "places" };
  if (PRIVACY_PATH.test(pathname)) return { page: "privacy" };
  if (EXAMPLES_PATH.test(pathname)) return { page: "examples" };
  if (FOUNDERS_PATH.test(pathname)) return { page: "founders" };
  if (pathname === START_CAMPAIGN_URL || pathname === `${START_CAMPAIGN_URL}/`) return { page: "start-campaign" };
  const receipt = RECEIPT_PATH.exec(pathname)?.[1];
  if (receipt) return { page: "receipt", token: receipt };
  const kit = KIT_PATH.exec(pathname)?.[1];
  if (kit) return { page: "kit", token: kit };
  const dossier = DOSSIER_PATH.exec(pathname)?.[1];
  if (dossier) return { page: "dossier", token: dossier };
  const campaign = CAMPAIGN_PATH.exec(pathname)?.[1];
  if (campaign) {
    const pledge = params.get("pledge");
    return {
      page: "campaign",
      id: campaign,
      pledge: pledge !== null && ORDER_ID.test(pledge) ? pledge : null,
      cancelled: params.get("cancelled") === "1",
    };
  }
  return { page: "brief" };
}

export function isPage(route: Route): route is PageRoute {
  return route.page !== "brief" && route.page !== "survey";
}

/** "/s/{id}", with "?sheet={index}" while a concept's design sheet is open. */
export function surveyUrl(id: string, sheet: number | null = null): string {
  const path = `/s/${encodeURIComponent(id)}`;
  return sheet === null ? path : `${path}?sheet=${sheet}`;
}

/** "/k/{token}": a launch kit. */
export function kitUrl(token: string): string {
  return `/k/${encodeURIComponent(token)}`;
}

/** "/k/{token}/dossier": the kit's report, as a document to print or save as a PDF. */
export function dossierUrl(token: string): string {
  return `${kitUrl(token)}/dossier`;
}

/** "/p/{id}": a Founders campaign's page. */
export function campaignUrl(id: string): string {
  return `/p/${encodeURIComponent(id)}`;
}

export function receiptUrl(token: string): string {
  return `/r/${encodeURIComponent(token)}`;
}

/** The address a page route shows; a campaign's without what PayPal sent the supporter back with. */
export function pageUrl(route: PageRoute): string {
  switch (route.page) {
    case "places":
      return PLACES_URL;
    case "privacy":
      return PRIVACY_URL;
    case "examples":
      return EXAMPLES_URL;
    case "founders":
      return FOUNDERS_URL;
    case "start-campaign":
      return START_CAMPAIGN_URL;
    case "kit":
      return kitUrl(route.token);
    case "dossier":
      return dossierUrl(route.token);
    case "campaign":
      return campaignUrl(route.id);
    case "receipt":
      return receiptUrl(route.token);
  }
}

/** Whether two page routes show the same page, whatever their query: one kit's page is not another's. */
export function samePage(a: PageRoute, b: PageRoute): boolean {
  return pageUrl(a) === pageUrl(b);
}

export function currentRoute(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}

/** The address without its hash: a section link changes only the hash, which is not a navigation. */
export function currentAddress(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The address bar already shows the brief, with nothing after the slash. */
export function onBriefUrl(): boolean {
  return window.location.pathname === BRIEF_URL && !window.location.search && !window.location.hash;
}
