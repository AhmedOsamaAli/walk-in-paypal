/* What each address of the app needs before it can show, started ahead of need: the chunks of code that draw it, and the
   answer it shows. Links start it as they are hovered, focused or touched; the app starts it for the address it opens
   on; lists of examples start it for their surveys and kits once the screen is idle. */
import { useEffect } from "react";
import { ahead, runPath } from "./api/client";
import { kitPath } from "./api/kit";
import { examplesChunk, foundersChunk, kitChunk, mapChunk, placesChunk, privacyChunk, surveyChunk } from "./chunks";
import { whenIdle } from "./lib/lazy";
import { parseRoute, type Route } from "./lib/routes";

const CHUNKS = {
  map: mapChunk,
  survey: surveyChunk,
  kit: kitChunk,
  examples: examplesChunk,
  places: placesChunk,
  privacy: privacyChunk,
  founders: foundersChunk,
};

export type ChunkName = keyof typeof CHUNKS;

export interface RouteNeeds {
  chunks: ChunkName[];
  /** The API path of the answer it shows, when it is one that can be fetched ahead. */
  data: string | null;
}

/**
 * What an address needs to show: the brief its map, a survey its view, the map and its record, a kit its page and itself.
 * Founders' pages need their code only: a campaign's answer depends on who asks and changes with every pledge.
 */
export function needsOf(route: Route): RouteNeeds {
  switch (route.page) {
    case "brief":
      return { chunks: ["map"], data: null };
    case "survey":
      return { chunks: ["survey", "map"], data: runPath(route.id) };
    case "kit":
    case "dossier":
      return { chunks: ["kit"], data: kitPath(route.token) };
    case "examples":
    case "places":
    case "privacy":
      return { chunks: [route.page], data: null };
    case "founders":
    case "start-campaign":
    case "campaign":
    case "receipt":
      return { chunks: ["founders"], data: null };
  }
}

/** The app's route for a link, or null for a link that leaves the app. */
export function routeOf(href: string, base: string): Route | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  return url.origin === new URL(base).origin ? parseRoute(url.pathname, url.search) : null;
}

export interface PreloadOptions {
  /** The code that draws the address too, not only its answer: true unless that code is sure to be loaded anyway. */
  code?: boolean;
}

/** Starts loading what an address shows: its chunks, unless `code` is false, and its answer when it has one. */
export function preloadRoute(route: Route, { code = true }: PreloadOptions = {}): void {
  const { chunks, data } = needsOf(route);
  if (code) for (const name of chunks) CHUNKS[name].preload();
  if (data) ahead.prefetch(data);
}

/** The same, for a link's address; nothing for a link that leaves the app. */
export function preloadLink(href: string, options?: PreloadOptions): void {
  const route = routeOf(href, window.location.href);
  if (route) preloadRoute(route, options);
}

/** Whether the visitor asked to save data, or is on a connection too slow for anything but what they asked for. */
function sparing(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? "");
}

/**
 * Fetches these links' answers (and their code, unless `code` is false) once the page has loaded and the browser is
 * idle, so the first screen's own downloads (the map's tiles, its fonts) go first; never for a visitor saving data. The
 * function it returns cancels it.
 */
export function preloadWhenIdle(hrefs: readonly string[], options?: PreloadOptions): () => void {
  if (!hrefs.length || sparing()) return () => undefined;
  let cancelIdle: (() => void) | null = null;
  const start = () => {
    cancelIdle = whenIdle(() => {
      for (const href of hrefs) preloadLink(href, options);
    });
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
  return () => {
    window.removeEventListener("load", start);
    cancelIdle?.();
  };
}

/** preloadWhenIdle for as long as a component shows these links; a new set of links starts it again. */
export function usePreloadWhenIdle(hrefs: readonly string[], { code = true }: PreloadOptions = {}): void {
  const links = hrefs.join("\n");
  useEffect(() => preloadWhenIdle(links ? links.split("\n") : [], { code }), [links, code]);
}
