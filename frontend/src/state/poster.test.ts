import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POSTER_APPEARANCE } from "../lib/posterBrand";
import { createPosterDesignStore } from "./poster";

describe("one poster design across the editor and report", () => {
  it("restores and updates the same project scope without changing other projects", () => {
    const values = new Map<string, string>([["walk-in-poster:kit:a", '{"choice":"botanical","locator":false}']]);
    const store = createPosterDesignStore(() => ({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    }));
    expect(store.get("kit:a")).toContain("botanical");
    const changed = { ...DEFAULT_POSTER_APPEARANCE, accent: "#214c37", logo: "data:image/png;base64,logo", leadPerk: "Opening invitation" };
    expect(store.save("kit:a", changed)).toBe(true);
    expect(JSON.parse(store.get("kit:a") ?? "{}")).toEqual(changed);
    expect(store.get("campaign:other")).toBeNull();
  });

  it("notifies both surfaces, and stops notifying a surface that unmounts", () => {
    const store = createPosterDesignStore(() => null);
    const editor = vi.fn(), report = vi.fn();
    const leave = store.subscribe(editor);
    store.subscribe(report);
    store.save("kit:a", DEFAULT_POSTER_APPEARANCE);
    expect(editor).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    leave();
    store.save("kit:a", { ...DEFAULT_POSTER_APPEARANCE, locator: true });
    expect(editor).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("keeps the customized report consistent during this visit if storage is denied", () => {
    const store = createPosterDesignStore(() => { throw new Error("storage denied"); });
    expect(store.get("kit:a")).toBeNull();
    const changed = { ...DEFAULT_POSTER_APPEARANCE, accent: "#214c37" };
    expect(store.save("kit:a", changed)).toBe(false);
    expect(JSON.parse(store.get("kit:a") ?? "{}")).toEqual(changed);
  });
});
