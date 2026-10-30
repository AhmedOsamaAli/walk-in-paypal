/* A Founders campaign as its page follows it, and the pledges this browser placed, remembered so they can be withdrawn. */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { founders, type Campaign, type CampaignProgress } from "../api/founders";
import { plainError } from "../lib/account";

/** How often an open campaign's page reads its count again while it is in view. */
export const CAMPAIGN_POLL_MS = 30_000;

export type CampaignLoad =
  | { state: "loading" }
  | { state: "shown"; campaign: Campaign }
  | { state: "missing" }
  | { state: "failed"; message: string };

/**
 * A campaign by its id: read when the page opens and again when the reader signs in or out (its owner reads more), then
 * every 30 seconds while it takes pledges and the page is in view, so the count stays current. `viewer` is who is signed
 * in, or undefined until the session has first answered (the first read already went with the reader's cookie).
 */
export function useCampaign(id: string, viewer: string | null | undefined) {
  const [load, setLoad] = useState<{ id: string; load: CampaignLoad }>({ id, load: { state: "loading" } });
  const [run, setRun] = useState(0);
  const [seen, setSeen] = useState(viewer);
  if (viewer !== seen) {
    setSeen(viewer);
    if (seen !== undefined && viewer !== undefined) setRun(run + 1);
  }

  useEffect(() => {
    const abort = new AbortController();
    founders.campaign(id, abort.signal).then(
      (campaign) => {
        setLoad({ id, load: { state: "shown", campaign } });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setLoad({
          id,
          load:
            error instanceof ApiError && error.status === 404
              ? { state: "missing" }
              : { state: "failed", message: plainError(error, "The campaign could not be loaded.") },
        });
      },
    );
    return () => {
      abort.abort();
    };
  }, [id, run]);

  const shown = load.id === id && load.load.state === "shown" ? load.load.campaign : null;
  const accepting = shown?.accepting === true;

  // A quiet read now and then: a failure keeps what is shown.
  useEffect(() => {
    if (!accepting) return;
    let live = true;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      founders.campaign(id).then(
        (campaign) => {
          if (live) setLoad((previous) => (previous.id === id ? { id, load: { state: "shown", campaign } } : previous));
        },
        () => undefined,
      );
    }, CAMPAIGN_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id, accepting, run]);

  const reload = useCallback(() => {
    setRun((count) => count + 1);
  }, []);
  const replace = useCallback(
    (campaign: Campaign) => {
      setLoad({ id, load: { state: "shown", campaign } });
    },
    [id],
  );
  const setProgress = useCallback(
    (progress: CampaignProgress) => {
      setLoad((previous) =>
        previous.id === id && previous.load.state === "shown"
          ? { id, load: { state: "shown", campaign: { ...previous.load.campaign, progress } } }
          : previous,
      );
    },
    [id],
  );

  return { load: load.id === id ? load.load : ({ state: "loading" } as const), reload, replace, setProgress };
}

// ---------- The pledges this browser placed: withdrawing one needs its PayPal order id ----------

const PLEDGE_KEY = "walk-in-pledge:";

export interface HeldPledge {
  /** The pledge's id, or PayPal's order id: withdrawing it asks for either. */
  orderId: string;
  /** When PayPal placed the hold. */
  at: string;
  /** The private receipt, absent on pledges made before receipts were added. */
  receipt?: string;
}

/** A remembered pledge as it was stored; null for anything else. */
export function readPledge(text: string | null): HeldPledge | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("orderId" in value) || !("at" in value)) return null;
    const { orderId, at } = value;
    if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId) || typeof at !== "string") return null;
    const receipt = "receipt" in value && typeof value.receipt === "string" && /^[A-Za-z0-9_-]{32}$/.test(value.receipt)
      ? value.receipt : undefined;
    return { orderId, at, ...(receipt ? { receipt } : {}) };
  } catch {
    return null;
  }
}

/** The pledge this browser holds for a campaign, if any. */
export function heldPledge(campaignId: string): HeldPledge | null {
  try {
    return readPledge(window.localStorage.getItem(PLEDGE_KEY + campaignId));
  } catch {
    return null;
  }
}

/** Remembers a held pledge, or forgets it once withdrawn. */
export function keepPledge(campaignId: string, pledge: HeldPledge | null): void {
  try {
    if (pledge) window.localStorage.setItem(PLEDGE_KEY + campaignId, JSON.stringify(pledge));
    else window.localStorage.removeItem(PLEDGE_KEY + campaignId);
  } catch {
    // Private browsing can refuse storage: the pledge then counts, but withdrawing it needs this page still open.
  }
}
