import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { founders, type KitCampaign } from "../api/founders";
import { kits, type KitStatus, type KitView } from "../api/kit";
import { plainError } from "../lib/account";

export const KIT_POLL_MS = 2000;
/** Polls that fail in a row before the page stops asking and says so. */
export const KIT_POLL_TRIES = 5;
export const KIT_GONE = "This kit link isn't valid, or the kit is no longer available.";

/** What following a kit that is being built needs; the hook passes the network and a timer, tests pass stand-ins. */
export interface KitPoll {
  load: () => Promise<KitView>;
  /** Waits for the next poll; resolves false once following was cancelled. */
  wait: () => Promise<boolean>;
  cancelled: () => boolean;
  /** Each copy of the kit, as it is read. */
  update: (view: KitView) => void;
  /** Polling gave up: the kit is gone, or kept failing to load. */
  fail: (message: string, gone: boolean) => void;
}

/** Polls a kit every couple of seconds until it is no longer being built. */
export async function followKit(poll: KitPoll): Promise<void> {
  let failures = 0;
  while (await poll.wait()) {
    let view: KitView;
    try {
      view = await poll.load();
    } catch (error) {
      if (poll.cancelled()) return;
      const gone = error instanceof ApiError && error.status === 404;
      failures += 1;
      if (gone || failures >= KIT_POLL_TRIES) {
        poll.fail(gone ? KIT_GONE : plainError(error, "The kit stopped answering. Reload the page to check on it."), gone);
        return;
      }
      continue;
    }
    if (poll.cancelled()) return;
    failures = 0;
    poll.update(view);
    if (view.status !== "building") return;
  }
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const cancel = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export type KitLoad =
  | { state: "loading" }
  | { state: "shown"; view: KitView; stalled: string | null }
  | { state: "missing" }
  | { state: "failed"; message: string };

/**
 * A kit by its token, followed every two seconds while it is being built; `restart` follows it again (after a retry).
 * Once it is ready its Founders campaigns are read beside it (they are not part of the kit's page, which may come from
 * a cache): the kit shows without waiting for them, and `view.campaigns` is missing until they arrive. Given who is
 * signed in (`viewer`: undefined until the session has first answered), a sign-in or sign-out reads the campaigns
 * again, since which of them is the viewer's own changes with them.
 */
export function useKit(token: string, viewer?: string | null) {
  const [load, setLoad] = useState<{ token: string; load: KitLoad }>({ token, load: { state: "loading" } });
  const [run, setRun] = useState(0);
  const [seen, setSeen] = useState(viewer);
  const [signIns, setSignIns] = useState(0);
  const [campaigns, setCampaigns] = useState<{ key: string; list: KitCampaign[]; error: string | null } | null>(null);
  if (viewer !== seen) {
    setSeen(viewer);
    if (seen !== undefined && viewer !== undefined) setSignIns(signIns + 1);
  }

  useEffect(() => {
    const abort = new AbortController();
    const show = (next: KitLoad) => {
      if (!abort.signal.aborted) setLoad({ token, load: next });
    };
    void (async () => {
      let view: KitView;
      try {
        view = await kits.get(token, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        show(error instanceof ApiError && error.status === 404 ? { state: "missing" } : { state: "failed", message: plainError(error, "The kit could not be loaded.") });
        return;
      }
      show({ state: "shown", view, stalled: null });
      if (view.status !== "building") return;
      await followKit({
        load: () => kits.get(token, abort.signal),
        wait: () => pause(KIT_POLL_MS, abort.signal),
        cancelled: () => abort.signal.aborted,
        update: (next) => {
          show({ state: "shown", view: next, stalled: null });
        },
        fail: (message, gone) => {
          if (gone) show({ state: "missing" });
          else setLoad((previous) => (previous.load.state === "shown" && !abort.signal.aborted ? { token, load: { ...previous.load, stalled: message } } : previous));
        },
      });
    })();
    return () => {
      abort.abort();
    };
  }, [token, run]);

  const restart = useCallback(() => {
    setRun((count) => count + 1);
  }, []);

  const shown = load.token === token ? load.load : ({ state: "loading" } as const);
  const ready = shown.state === "shown" && shown.view.status === "ready";
  const key = `${token} ${run} ${signIns}`;
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    founders.forKit(token, abort.signal).then(
      (list) => {
        if (!abort.signal.aborted) setCampaigns({ key, list, error: null });
      },
      () => {
        if (!abort.signal.aborted) setCampaigns({
          key, list: [], error: "Campaign details could not be checked. Reload before printing the poster or report.",
        });
      },
    );
    return () => {
      abort.abort();
    };
  }, [ready, token, key]);

  const listed = campaigns?.key === key ? campaigns.list : undefined;
  return {
    load: shown.state === "shown" && listed ? { ...shown, view: { ...shown.view, campaigns: listed } } : shown,
    campaignsError: campaigns?.key === key ? campaigns.error : null,
    restart,
  };
}

/** What a page says aloud about its kit: that it is being built, then that it is ready or could not be built. */
export interface KitWords {
  building: string;
  ready: string;
  failed: string;
}

/**
 * The news in a change of the kit's status, for a live region: a build starting, and how a build ended. A kit that is
 * already ready or failed when the page opens is news to nobody: the page's title says it.
 */
export function kitNews(before: KitStatus | null, now: KitStatus | null, words: KitWords): string {
  if (now === null || now === before) return "";
  if (now === "building") return words.building;
  return before === "building" ? words[now] : "";
}

/** The latest news about the kit's status, kept until the status changes again. */
export function useKitNews(status: KitStatus | null, words: KitWords): string {
  const [news, setNews] = useState<{ status: KitStatus | null; text: string }>({ status, text: "" });
  if (news.status !== status) setNews({ status, text: kitNews(news.status, status, words) });
  return news.text;
}
