import { Suspense, useCallback, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import type { GapRow, HeatCell, PlaceCard as Place, Walk } from "../api/types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { lazyComponent, lazyModule } from "../lib/lazy";
import { PlaceCard } from "../components/PlaceCard";
import { SearchBox } from "../components/SearchBox";
import { areaKey, areaShort, km2Text, walkShort, type Area } from "../lib/area";
import { cx } from "../lib/css";
import { FULL_MAP_ENTRY, isFullMapEntry, mapModeBottom, spotTitle } from "../lib/fullmap";
import { NO_WALK, walkLine, type WalkPreview } from "../lib/walk";
import { useEngine } from "../state/engine";
import type { Theme } from "../state/theme";
import { BlueprintMap, type MapPoint } from "./controller";
import { Legend } from "./Legend";
import { openPin, pinFocus, subscribePins } from "./pinFocus";
import { areaWord, gapPins, type Pin } from "./pins";
import { streetViewUrl } from "./realistic";
import { circleWalk } from "./geometry";

const realMap = lazyModule(() => import("./RealisticMap"));
const RealisticMap = lazyComponent(realMap, (module) => module.RealisticMap);

/** Where the docked map is a strip at the top of the results, and a tap on it opens it full screen (pins.css). */
const STRIP = "(max-width: 980px)";

/** A spot placed on the map: by a click or tap, by Enter at the cross, or found by the full-screen map's search. */
export interface PlacedSpot extends MapPoint {
  /** The place's name, when the search found it. */
  label?: string;
}

export interface SurveyMapProps {
  theme: Theme;
  site: MapPoint | null;
  /** The site's name, for the full-screen map's card. */
  label?: string | null;
  walk: Walk | null;
  /** The site's walk as it is traced, for the full-screen map's card. */
  trace?: WalkPreview;
  /**
   * The area the brief or the survey asks for (a walk, a drive or a road distance): it frames a new site and stands in
   * for its ring until traced, and names it meanwhile.
   */
  area: Area;
  /** The survey view is showing: the legend is up and clicks no longer drop pins. */
  surveying: boolean;
  /**
   * Counts survey runs, and is 0 on the brief: a new value (a run started, or shown again) frames the walk, and the
   * radar sweeps it while the run streams.
   */
  run: number;
  streaming: boolean;
  /** The places Qloo lists inside the walk, counted by the legend while no category is open. */
  places: Place[] | null;
  /** The open category, whose places the map labels to match its lists. */
  gap: GapRow | null;
  /** The survey's categories have arrived, so the legend can say to open one. */
  gapsReady?: boolean;
  /** The map can grow to fill the screen, from the control in its corner: on the brief, and docked beside a survey. */
  expandable?: boolean;
  onPick: (spot: PlacedSpot) => void;
  /** The map fills the screen, or no longer does: the page makes the rest of itself inert meanwhile. */
  onExpand?: (expanded: boolean) => void;
  /** "Use this spot" on the full-screen map: the map shrinks back and the brief takes over with the site set. */
  onUse?: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Marks the frame while the keyboard is on the map itself, so the cross and the keys line show (map.css): the map has
 * focus and no click or tap came after the last key.
 */
function markKeys(root: HTMLElement | null, canvas: HTMLElement | null, pointer: boolean): void {
  root?.toggleAttribute("data-keys", !pointer && canvas !== null && document.activeElement === canvas);
}

export function SurveyMap({
  theme,
  site,
  label = null,
  walk,
  trace = NO_WALK,
  area: asked,
  surveying,
  run,
  streaming,
  places,
  gap,
  gapsReady = false,
  expandable = false,
  onPick,
  onExpand,
  onUse,
}: SurveyMapProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const modes = useRef<HTMLDivElement>(null);
  const controller = useRef<BlueprintMap | null>(null);
  /** The last input was a click or a tap rather than a key. */
  const pointer = useRef(false);
  const waking = useEngine().phase === "waking";
  const [expanded, setExpanded] = useState(false);
  /** Where focus goes once the full-screen map shrinks back: its control, or the brief after "Use this spot". */
  const returnTo = useRef<"control" | "brief">("control");
  /** What had focus outside the map when it grew, from a list's mark or the Map button: focus goes back there. */
  const opener = useRef<HTMLElement | null>(null);
  const wasFull = useRef(false);
  /**
   * The pin whose card is open, for the category it belongs to (another category closes it), whether the keyboard
   * opened it, and the list's mark that asked for it, which takes focus back as it closes.
   */
  const [opened, setOpened] = useState<{ pin: Pin; byKeyboard: boolean; gap: GapRow; from: HTMLElement | null; preview?: boolean } | null>(null);
  const shown = opened?.gap === gap ? opened : null;
  const previewTimer = useRef<number | null>(null);
  const dismissTimer = useRef<number | null>(null);
  const overCard = useRef(false);
  /** The open category's taste grid is on the map, so the legend lists it. */
  const [grid, setGrid] = useState(false);
  const [cells, setCells] = useState<HeatCell[]>([]);
  const [realistic, setRealistic] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const failed3D = useCallback((message: string) => { setMapError(message); }, []);
  if (!site && realistic) setRealistic(false);
  /** The docked strip has scrolled out of view: the Map button floats at the foot (phones and tablets). */
  const [away, setAway] = useState(false);
  // A map that can no longer grow (the brief gave way to a survey) is not left full screen.
  if (expanded && !expandable) setExpanded(false);
  const full = expanded && expandable;
  const pinnable = !surveying;

  function clearPreviewTimers() {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
    previewTimer.current = null;
    dismissTimer.current = null;
  }

  function schedulePreview(key: string | null) {
    clearPreviewTimers();
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches || (shown && !shown.preview)) return;
    if (!key) {
      dismissTimer.current = window.setTimeout(() => {
        if (!overCard.current && shown?.preview) { setOpened(null); openPin(null); }
      }, 240);
      return;
    }
    if (!gap || (!full && window.matchMedia(STRIP).matches)) return;
    const pin = gapPins(gap).pins.find((item) => item.key === key);
    if (!pin) return;
    previewTimer.current = window.setTimeout(() => {
      setOpened({ pin, byKeyboard: false, gap, from: null, preview: true });
      openPin(pin.key);
    }, 160);
  }
  const hoverPin = useEffectEvent(schedulePreview);

  function changeMapMode(next: boolean) {
    clearPreviewTimers();
    overCard.current = false;
    if (shown?.preview) { setOpened(null); openPin(null); }
    setMapError(null);
    setRealistic(next);
  }

  function grow() {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && !frame.current?.contains(active) ? active : null;
    window.history.pushState(FULL_MAP_ENTRY, "");
    setExpanded(true);
    onExpand?.(true);
  }

  function shrink(to: "control" | "brief") {
    returnTo.current = to;
    setExpanded(false);
    onExpand?.(false);
    if (isFullMapEntry(window.history.state)) window.history.back();
  }

  function closeCard() {
    clearPreviewTimers();
    overCard.current = false;
    const closing = shown;
    setOpened(null);
    openPin(null);
    if (!closing) return;
    // Full screen, the page under the map is inert: focus stays on the map until it shrinks.
    if (!full && closing.from?.isConnected) closing.from.focus({ preventScroll: true });
    else if (closing.byKeyboard) {
      if (realistic) [...frame.current?.querySelectorAll<HTMLButtonElement>(".realistic-pin") ?? []]
        .find((pin) => pin.dataset.pinKey === closing.pin.key)?.focus({ preventScroll: true });
      else controller.current?.focusPin(closing.pin.key);
    }
  }

  /** A pin was pressed, or a list asked for one: its card opens, from the keyboard with focus in it. */
  function selectPin(pin: Pin, byKeyboard: boolean) {
    clearPreviewTimers();
    overCard.current = false;
    if (!gap) return;
    setOpened({ pin, byKeyboard, gap, from: null });
    openPin(pin.key);
    // The strip has no room for the card: the map opens full screen with it.
    if (!full && expandable && window.matchMedia(STRIP).matches) grow();
  }
  const select = useEffectEvent(selectPin);
  /** A list's mark asks for its place: the docked map shows its card, or, where the map is a strip, opens full screen. */
  const reveal = useEffectEvent((key: string, byKeyboard: boolean) => {
    clearPreviewTimers();
    overCard.current = false;
    setRealistic(false);
    const pin = controller.current?.revealPin(key);
    if (!pin || !gap) return;
    const strip = window.matchMedia(STRIP).matches;
    const active = document.activeElement;
    const from = active instanceof HTMLElement && !frame.current?.contains(active) ? active : null;
    setOpened({ pin, byKeyboard: strip || byKeyboard, gap, from });
    openPin(pin.key);
    if (strip && !full && expandable) grow();
  });

  const pick = useEffectEvent((lat: number, lon: number) => {
    if (pinnable) onPick({ lat, lon });
  });
  const toggle = useEffectEvent(() => {
    if (full) shrink("control");
    else if (expandable) grow();
  });
  // The browser's Back shrinks the full-screen map rather than leaving the page.
  const back = useEffectEvent(() => {
    if (isFullMapEntry(window.history.state)) return;
    returnTo.current = "control";
    setExpanded(false);
    onExpand?.(false);
  });
  const beginRun = useEffectEvent(() => {
    controller.current?.startRun(asked);
    // A survey shown after it ended (restored, or brought back by Forward) is framed without the radar.
    if (!streaming) controller.current?.finishRun();
  });

  useEffect(() => {
    if (!canvas.current || !readout.current) return;
    const map = new BlueprintMap(
      canvas.current,
      readout.current,
      (lat, lon) => {
        pick(lat, lon);
      },
      {
        onExpand: () => {
          toggle();
        },
        onPin: (pin, byKeyboard) => {
          select(pin, byKeyboard);
        },
        onGrid: (drawn, heat = []) => {
          setGrid(drawn);
          setCells(heat);
        },
      },
    );
    controller.current = map;
    // A list's mark asks the map to show its place (GapItem.tsx).
    let asks = pinFocus().asks;
    let hovered = pinFocus().hovered;
    const unsubscribe = subscribePins(() => {
      const focus = pinFocus();
      if (focus.hovered !== hovered) {
        hovered = focus.hovered;
        hoverPin(hovered);
      }
      if (focus.asks === asks) return;
      asks = focus.asks;
      if (focus.shown) reveal(focus.shown, focus.byKeyboard);
    });
    return () => {
      unsubscribe();
      clearPreviewTimers();
      map.destroy();
      controller.current = null;
      document.documentElement.classList.remove("map-full");
    };
  }, []);

  useEffect(() => {
    controller.current?.setTheme(theme);
  }, [theme]);

  // The cross and the keys line are for the keyboard. Leaflet focuses the map from script on a click or a tap, which
  // the browser may show as keyboard focus, so a pointer hides them until the next key is pressed.
  useEffect(() => {
    const byKey = () => {
      pointer.current = false;
      markKeys(frame.current, canvas.current, false);
    };
    document.addEventListener("keydown", byKey, true);
    return () => {
      document.removeEventListener("keydown", byKey, true);
    };
  }, []);

  useEffect(() => {
    controller.current?.setExpandable(expandable);
  }, [expandable]);

  // Full screen, the page under the map stops scrolling; shrinking back, focus returns to the corner control, or to
  // what had it outside the map when it grew.
  useEffect(() => {
    const map = controller.current;
    map?.setExpanded(full, surveying);
    document.documentElement.classList.toggle("map-full", full);
    if (wasFull.current && !full && returnTo.current === "control") {
      const previous = opener.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else map?.focusExpander();
    }
    if (!full) opener.current = null;
    wasFull.current = full;
  }, [full, surveying]);

  useEffect(() => {
    if (!full) return;
    const onPopState = () => {
      back();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [full]);

  // The card at the foot of the full-screen map: the corner controls there float above it.
  const hasCard = full && pinnable && site !== null;
  useEffect(() => {
    const box = card.current;
    const root = frame.current;
    if (!hasCard || !box || !root) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--card-space", `${box.offsetHeight + 24}px`);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--card-space");
    };
  }, [hasCard]);

  // The area asked for, before the site it frames: both can change in one go, as when a survey's brief is taken up.
  const askedKey = areaKey(asked);
  const syncArea = useEffectEvent(() => {
    controller.current?.setArea(asked);
  });
  useEffect(() => {
    syncArea();
  }, [askedKey]);

  // A site is placed where it stands: renaming it there (a dropped pin's address coming) neither drops its pin again nor
  // clears its ring.
  const spot = site ? `${site.lat},${site.lon}` : null;
  const placeSite = useEffectEvent(() => {
    if (site) controller.current?.selectSite(site);
  });
  useEffect(() => {
    placeSite();
  }, [spot]);

  // Selecting a site clears the drawn walk, so the walk is shown again even when it is the same object.
  const drawWalk = useEffectEvent(() => {
    if (walk) controller.current?.showWalk(walk);
  });
  useEffect(() => {
    drawWalk();
  }, [spot, walk]);

  useEffect(() => {
    if (run > 0) beginRun();
  }, [run]);

  useEffect(() => {
    if (!streaming) controller.current?.finishRun();
  }, [streaming]);

  useEffect(() => {
    if (!surveying) controller.current?.clearRun();
  }, [surveying]);

  // Another category, or none: its pins replace the last one's, and no card stays lit.
  useEffect(() => {
    clearPreviewTimers();
    overCard.current = false;
    controller.current?.showGap(gap);
    openPin(null);
  }, [gap]);

  // Full screen, the card floats over the map: the map moves so the pin it describes is not under it.
  const openKey = shown?.pin.key ?? null;
  useEffect(() => {
    if (!openKey || !full || shown?.preview || realistic) return;
    const box = frame.current?.querySelector(".place-card")?.getBoundingClientRect();
    if (box) controller.current?.uncoverPin(openKey, box);
  }, [openKey, full, shown?.preview, realistic]);

  useEffect(() => {
    const root = frame.current, controls = modes.current, map = canvas.current;
    if (!root || !controls || !map) return;
    const measure = () => {
      const view = full || !surveying ? root.getBoundingClientRect() : map.getBoundingClientRect();
      const panelBoxes = [...root.querySelectorAll<HTMLElement>(".place-card, .map-card, .legend, .credits, .leaflet-control-scale")]
        .filter((panel) => panel.getClientRects().length > 0).map((panel) => panel.getBoundingClientRect());
      const offset = root.getBoundingClientRect().bottom - view.bottom + mapModeBottom(view, controls.getBoundingClientRect(), panelBoxes);
      root.style.setProperty("--map-modes-bottom", `${Math.round(offset)}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(controls);
    for (const panel of root.querySelectorAll(".place-card, .map-card, .legend, .credits")) observer.observe(panel);
    root.addEventListener("toggle", measure, true);
    measure();
    return () => { observer.disconnect(); root.removeEventListener("toggle", measure, true); };
  }, [full, surveying, openKey, shown?.preview, hasCard, realistic]);

  // Where the docked map is a strip at the top of the results, the Map button floats once it has scrolled away.
  useEffect(() => {
    const root = frame.current;
    if (!root || !surveying) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setAway(!entry.isIntersecting);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, [surveying]);

  /**
   * Escape closes an open card first, from the card or a pin. Full screen, it then shrinks the map (after closing an
   * open list of search results), and Tab stays on it.
   */
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && shown && !event.defaultPrevented) {
      event.preventDefault();
      closeCard();
      return;
    }
    if (!full) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      shrink("control");
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => item.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const title = site ? spotTitle(label, site.lat, site.lon) : null;
  const area = areaWord(walk?.travel ?? asked.travel);
  const line = walkLine(trace, asked, waking);
  /** The map's own key, at its bottom-left once a site is placed: what its dashed ring is, traced or on its way. */
  const tracing = !walk && !surveying && trace.phase === "tracing";
  const key = walk
    ? `${walkShort(walk)} · ${km2Text(walk.area_km2)} km²`
    : tracing
      ? `Tracing a ${areaShort(asked)}…`
      : areaShort(asked);

  return (
    <>
      <div
        ref={frame}
        className={cx("map-frame", full && "expanded")}
        data-expandable={expandable ? "" : undefined}
        data-dock={surveying && !full ? "" : undefined}
        data-map-mode={realistic ? "3d" : "2d"}
        role={full ? "dialog" : "region"}
        aria-modal={full ? true : undefined}
        aria-label={full ? "Full-screen map" : "Map of the site and its surroundings"}
        onKeyDown={keyDown}
        onPointerDown={() => {
          pointer.current = true;
          markKeys(frame.current, canvas.current, true);
        }}
        onFocus={() => {
          markKeys(frame.current, canvas.current, pointer.current);
        }}
        onBlur={() => {
          markKeys(frame.current, canvas.current, pointer.current);
        }}
      >
        <div
          ref={canvas}
          className="map-canvas"
          aria-hidden={realistic}
          inert={realistic}
          onKeyDown={(event) => {
            // Enter places the site at the cross in the middle, for the keyboard.
            if (event.key !== "Enter" || event.target !== event.currentTarget || !pinnable) return;
            event.preventDefault();
            const center = controller.current?.center();
            if (center) onPick(center);
          }}
        />
        {realistic && site ? <ErrorBoundary fallback={<p className="realistic-notice" role="alert">The 3D view could not load. Choose 2D to continue.</p>}>
          <Suspense fallback={<p className="realistic-notice" role="status">Loading the optional 3D renderer…</p>}>
            <RealisticMap site={site} walk={walk ?? circleWalk(site.lat, site.lon, asked)} gap={gap} cells={cells}
              pinnable={pinnable} onPick={(lat, lon) => { if (pinnable) onPick({ lat, lon }); }}
              onPin={selectPin} onError={failed3D} />
          </Suspense>
        </ErrorBoundary> : null}
        {mapError && realistic ? <p className="realistic-notice" role="alert">{mapError}{" "}
          <button type="button" onClick={() => { changeMapMode(false); }}>Return to 2D</button></p> : null}
        <div ref={modes} className="map-modes" role="group" aria-label="Map view">
          <button type="button" aria-label="2D" title="2D evidence map" aria-pressed={!realistic} onClick={() => { changeMapMode(false); }}>2D</button>
          <button type="button" aria-label="3D buildings" aria-pressed={realistic} disabled={!site}
            title={site ? "Optional mapped buildings and streets" : "Choose a site before opening 3D"}
            onClick={() => { changeMapMode(true); }}>3D</button>
          {site ? <a href={streetViewUrl(shown?.pin ?? site)} title="Open Street View in Google Maps" aria-label="Street View"
            target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="2" /><path d="M8 11L12 8L16 11M12 8V16M12 16L9 21M12 16L15 21" />
            </svg></a> : null}
        </div>
        <div ref={readout} className="readout mono" aria-hidden="true" />
        {pinnable ? (
          <>
            <span className="map-cross" aria-hidden="true" />
            <p className="map-keys" aria-hidden="true">
              Arrow keys pan · + and − zoom · Enter places the site at the cross
            </p>
          </>
        ) : null}
        {site ? null : (
          <div className="map-hint">
            <span className="say-click">Click</span>
            <span className="say-tap">Tap</span> the map to place a site
          </div>
        )}
        {site && !full ? (
          <p className="map-key" aria-hidden="true" data-tracing={tracing ? "" : undefined}>
            <i />
            <span>{key}</span>
          </p>
        ) : null}
        {full && pinnable ? (
          <div className="map-search">
            <SearchBox
              placeholder="Search an address or area"
              site={site}
              siteLabel={label}
              onPick={(found) => {
                onPick({ lat: found.lat, lon: found.lon, label: found.label });
              }}
            />
          </div>
        ) : null}
        {full && pinnable && site && title ? (
          <div ref={card} className="map-card">
            <div className="map-card-text" role="status">
              <strong className={cx("map-card-title", title.isCoords && "coords")}>{title.text}</strong>
              {line ? <span className={cx("map-card-walk", trace.phase === "resting" && "resting")}>{line}</span> : null}
            </div>
            <button
              type="button"
              className="map-use"
              onClick={() => {
                shrink("brief");
                onUse?.();
              }}
            >
              <span>Use this spot</span>
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 12h15M13 6l6 6-6 6" />
                </svg>
              </i>
            </button>
          </div>
        ) : null}
        {shown ? <PlaceCard pin={shown.pin} area={area} focus={shown.byKeyboard} compact={shown.preview}
          onExpand={() => { selectPin(shown.pin, false); }}
          onPointerEnter={() => { overCard.current = true; clearPreviewTimers(); }}
          onPointerLeave={() => { overCard.current = false; schedulePreview(null); }}
          onClose={closeCard} /> : null}
        {surveying ? (
          <Legend
            areaLabel={walk ? walkShort(walk) : areaShort(asked)}
            area={area}
            gap={gap}
            placeCount={places?.length ?? null}
            canOpen={gapsReady}
            grid={grid}
          />
        ) : null}
        {surveying && !full ? <button type="button" className="map-open" aria-label="Open the map full screen" onClick={grow} /> : null}
      </div>
      {surveying && !full && away ? (
        <button type="button" className="map-pill" onClick={grow}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2zM9 4.5v13M15 6.5v13" />
          </svg>
          Map{gap ? <b> · {gap.genre}</b> : null}
        </button>
      ) : null}
    </>
  );
}
