import { useMemo, useSyncExternalStore } from "react";
import { DEFAULT_POSTER_APPEARANCE, readPosterAppearance, type PosterAppearance } from "../lib/posterBrand";

const KEY = "walk-in-poster:";
type PosterStorage = Pick<Storage, "getItem" | "setItem">;

/** One saved design for the editor, report preview and report document, including when storage is unavailable. */
export function createPosterDesignStore(storage: () => PosterStorage | null) {
  const drafts = new Map<string, string>();
  const listeners = new Set<() => void>();
  const refresh = () => { for (const listener of listeners) listener(); };
  return {
    get(scope: string): string | null {
      if (drafts.has(scope)) return drafts.get(scope) ?? null;
      try { return storage()?.getItem(KEY + scope) ?? null; } catch { return null; }
    },
    save(scope: string, appearance: PosterAppearance): boolean {
      const text = JSON.stringify(appearance);
      let saved = false;
      try {
        const target = storage();
        if (target) { target.setItem(KEY + scope, text); saved = true; }
      } catch { /* The design still lasts for this visit. */ }
      if (saved) drafts.delete(scope);
      else drafts.set(scope, text);
      refresh();
      return saved;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (typeof window !== "undefined") window.addEventListener("storage", listener);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", listener);
      };
    },
  };
}

export const posterDesign = createPosterDesignStore(() => typeof window === "undefined" ? null : window.localStorage);

export function usePosterAppearance(scope: string): PosterAppearance {
  const raw = useSyncExternalStore(posterDesign.subscribe, () => posterDesign.get(scope), () => posterDesign.get(scope));
  return useMemo(() => {
    try { return readPosterAppearance(raw); } catch { return { ...DEFAULT_POSTER_APPEARANCE }; }
  }, [raw]);
}
