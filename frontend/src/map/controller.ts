import * as L from "leaflet";
import { api } from "../api/client";
import type { GapRow, HeatCell, LatLon, Walk } from "../api/types";
import { areaKey, WALK_10, type Area } from "../lib/area";
import { coords } from "../lib/format";
import { expandLabel, streetZoom, walkReach } from "../lib/fullmap";
import { prefersReducedMotion } from "../lib/motion";
import type { Theme } from "../state/theme";
import { arc, cellSpan, metersToLat, reachM } from "./geometry";
import { PinLayer, SITE_LAYER } from "./pinLayer";
import { areaWord, type Pin } from "./pins";

export interface MapPoint {
  lat: number;
  lon: number;
}

export interface MapOptions {
  /** Adds the corner control that grows the map to fill the screen and back; called when it is pressed. */
  onExpand?: () => void;
  /** A pin of the open category was clicked, tapped, or pressed with Enter or Space. */
  onPin?: (pin: Pin, byKeyboard: boolean) => void;
  /** The open category's taste grid is on the map, or no longer is. */
  onGrid?: (shown: boolean) => void;
}

/**
 * Esri's light and dark gray canvases, each split into a base and a labels layer so the labels sit above the taste
 * grid. Esri serves them over HTTP/1.1 only, so tiles alternate between its two hosts to double the connections.
 */
const ESRI = "https://{s}.arcgisonline.com/ArcGIS/rest/services/Canvas";
const TILES: Record<Theme, { base: string; labels: string }> = {
  light: {
    base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
  dark: {
    base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
};
const TILE_OPTIONS: L.TileLayerOptions = { subdomains: ["server", "services"], maxNativeZoom: 16, maxZoom: 19, className: "basemap" };
/** The data credits Esri's and OpenStreetMap's terms require. */
const CREDITS =
  'Powered by <a href="https://www.esri.com">Esri</a> &middot; Esri, HERE, Garmin &middot; &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** OpenStreetMap's attribution guideline lets the credits collapse after the first pan, zoom or click, or this long. */
const CREDITS_OPEN_MS = 5000;
/** Matches the basemap fade in map.css. */
const BASEMAP_FADE_MS = 600;
/** How long a theme switch waits for the new tiles before showing them anyway, say on a hidden map. */
const BASEMAP_SWAP_TIMEOUT_MS = 30_000;
const PIN_HTML = '<div class="site-pin"><span class="sq"></span><span class="tagl">Site</span></div>';
/** The corner control's icons: four corners pointing out to grow the map, and in to shrink it back. Both stay in the
 * button, which shows one or the other: replacing them mid-click would detach the click's target from the control. */
const EXPAND_ICONS =
  '<svg class="grow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/></svg>' +
  '<svg class="shrink" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/></svg>';

/** One theme's tile layers. */
interface Basemap {
  theme: Theme;
  layers: L.TileLayer[];
}

/**
 * The same area traced again, as when the survey's own trace replaces the brief's: drawn once, so it does not fade in
 * twice. A walk and a drive of the same minutes are different areas, however alike their rings' lengths.
 */
function sameWalk(a: Walk, b: Walk): boolean {
  return (
    (a.travel ?? "walk") === (b.travel ?? "walk") &&
    a.minutes === b.minutes &&
    (a.km ?? null) === (b.km ?? null) &&
    a.ring.length === b.ring.length &&
    a.ring[0]?.[0] === b.ring[0]?.[0] &&
    a.ring[0]?.[1] === b.ring[0]?.[1]
  );
}

function dropBasemap(basemap: Basemap | null): void {
  for (const layer of basemap?.layers ?? []) layer.remove();
}

/**
 * The survey map: Leaflet driven imperatively, outside React's render. Overlays carry class names and take their
 * colors from the theme's CSS variables, so a theme switch only swaps the tiles.
 */
export class BlueprintMap {
  private readonly map: L.Map;
  private readonly readout: HTMLElement;
  /** The current theme's tiles, shown or still loading. */
  private basemap: Basemap | null = null;
  /** The previous theme's tiles, kept on screen until the current ones have loaded. */
  private fading: Basemap | null = null;
  private readonly gridRenderer: L.Canvas;
  private readonly layers: Record<"grid" | "ring" | "gap" | "site", L.LayerGroup>;
  /** The open category's labeled pins. */
  private readonly pins: PinLayer;
  private readonly onGrid: (shown: boolean) => void;
  /** On narrow screens the frame grows for the survey and shrinks back for the brief; Leaflet must re-measure it. */
  private readonly resizer: ResizeObserver;
  private readonly idleQueue: (() => void)[] = [];
  private readonly grids = new Map<string, HeatCell[]>();
  private readonly timers = new Set<number>();
  private moving = false;
  private pointerOnMap = false;
  private destroyed = false;
  private site: MapPoint | null = null;
  private walk: Walk | null = null;
  /** The area the brief or the survey asks for: until its ring is traced, a circle of its reach stands in for it. */
  private area: Area = WALK_10;
  /** The owner changed the area since its ring was last framed: its next ring is framed, in or out. */
  private areaChanged = false;
  private running = false;
  private radar: L.Marker | null = null;
  private gap: GapRow | null = null;
  private runToken = 0;
  private moveToken = 0;
  /** The corner control that grows the map to fill the screen, and its box in the corner. */
  private expander: HTMLButtonElement | null = null;
  private expandBox: HTMLElement | null = null;
  /** The map fills the screen: a site chosen meanwhile is framed at street level. */
  private expanded = false;

  constructor(element: HTMLElement, readout: HTMLElement, onPick: (lat: number, lon: number) => void, options: MapOptions = {}) {
    this.readout = readout;
    const map = L.map(element, { zoomControl: false, worldCopyJump: true, attributionControl: false }).setView([40.735, -73.975], 12);
    this.map = map;
    if (options.onExpand) this.addExpander(options.onExpand);
    L.control.zoom({ position: "topright" }).addTo(map);
    this.addCredits();
    const scale = L.control.scale({ position: "bottomright", imperial: false, maxWidth: 120 }).addTo(map);
    // The scale bar is a label, not a place: a click on it must not drop a pin under it.
    const scaleBox = scale.getContainer();
    if (scaleBox) L.DomEvent.disableClickPropagation(scaleBox);
    for (const [name, zIndex] of [["grid", 350], ["labels", 360], ["radar", 380]] as const) {
      const pane = map.createPane(name);
      pane.style.zIndex = String(zIndex);
      pane.style.pointerEvents = "none";
    }
    map.getPane("grid")?.classList.add("grid-pane");
    this.gridRenderer = L.canvas({ padding: 0.5, pane: "grid" });
    this.layers = {
      grid: L.layerGroup().addTo(map),
      ring: L.layerGroup().addTo(map),
      gap: L.layerGroup().addTo(map),
      site: L.layerGroup().addTo(map),
    };
    this.pins = new PinLayer(map, {
      onSelect: (pin, byKeyboard) => {
        options.onPin?.(pin, byKeyboard);
      },
    });
    this.onGrid = options.onGrid ?? (() => undefined);

    map.on("mouseover", () => {
      this.pointerOnMap = true;
    });
    map.on("mouseout", () => {
      this.pointerOnMap = false;
      this.showCenter();
    });
    map.on("move", () => {
      this.showCenter();
    });
    map.on("mousemove", (event: L.LeafletMouseEvent) => {
      this.readout.textContent = coords(event.latlng.lat, event.latlng.lng);
    });
    map.on("click", (event: L.LeafletMouseEvent) => {
      const { lat, lng } = event.latlng.wrap();
      onPick(lat, lng);
    });
    // Paths added while the map is flying are projected against a moving origin and appear offset until the
    // flight ends, so every overlay is drawn only once the map is idle.
    map.on("movestart", () => {
      this.moving = true;
    });
    map.on("moveend", () => {
      this.moving = false;
      for (const draw of this.idleQueue.splice(0)) draw();
    });
    // Keeps the center where it was, so a resized frame never pushes the site off to one side.
    this.resizer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    this.resizer.observe(element);
    this.showCenter();
  }

  destroy(): void {
    this.destroyed = true;
    this.resizer.disconnect();
    for (const timer of this.timers) window.clearTimeout(timer);
    this.idleQueue.length = 0;
    this.map.off("zoomend", this.resizeRadar);
    this.pins.destroy();
    this.map.remove();
  }

  /** Swaps the tiles; overlays restyle themselves from the theme's variables, except the canvas grid. */
  setTheme(theme: Theme): void {
    this.showBasemap(theme);
    const fillColor = this.gridColor();
    this.layers.grid.eachLayer((layer) => {
      if (layer instanceof L.Path) layer.setStyle({ fillColor });
    });
  }

  selectSite(site: MapPoint): void {
    this.site = site;
    this.walk = null;
    this.clearRun();
    this.layers.ring.clearLayers();
    this.drawPin(site);
    // Close enough to see the area whole, as far as it is known before it is traced (the circle of its reach), and never
    // further out than the map already is, so a pin moved about at street level stays there; once traced, the ring
    // brings the map out if it reaches past the edges (fitWalk). Full screen, a site placed from a city-wide view or
    // found by the search is framed at street level.
    const zoom = this.expanded ? this.siteZoom(site) : Math.min(16, this.reachZoom(site));
    this.map.flyTo([site.lat, site.lon], Math.max(this.map.getZoom(), zoom), this.flight(1.4));
  }

  /** The area the brief or the survey asks for: its circle frames a new site, and stands in for its ring until traced. */
  setArea(area: Area): void {
    if (areaKey(area) !== areaKey(this.area)) this.areaChanged = true;
    this.area = area;
  }

  /**
   * The map fills the screen, or no longer does: the corner control says which. The frame has just changed size, so
   * Leaflet re-measures it now, keeping the same center. Over a survey, the area is framed again for the new size, in or
   * out; on the brief, the full-screen map keeps the owner's street level, and the area shows whole once back.
   */
  setExpanded(expanded: boolean, survey = false): void {
    const changed = expanded !== this.expanded;
    this.expanded = expanded;
    this.labelExpander();
    this.map.invalidateSize();
    // The open category's pins are framed again for the map's new size.
    if (changed && this.gap && this.pins.size) this.frame();
    else if (changed && this.walk && (survey || !expanded)) this.fitWalk(this.walk, survey);
  }

  /** Shows the corner control only where the map can grow: on the brief, and docked beside a survey. */
  setExpandable(expandable: boolean): void {
    if (this.expandBox) this.expandBox.hidden = !expandable;
  }

  focusExpander(): void {
    this.expander?.focus({ preventScroll: true });
  }

  /** Brings a pin of the open category into view, for a list's "show on the map"; null when it is not drawn. */
  revealPin(key: string): Pin | null {
    return this.pins.reveal(key, !prefersReducedMotion());
  }

  focusPin(key: string): void {
    this.pins.focus(key);
  }

  /** Once the map is still, moves it so a pin is not under its card (`cover`, over the full-screen map). */
  uncoverPin(key: string, cover: DOMRect): void {
    this.whenIdle(() => {
      if (!this.destroyed) this.pins.uncover(key, cover, !prefersReducedMotion());
    });
  }

  /** The middle of the map: where Enter places the site from the keyboard. */
  center(): MapPoint {
    const { lat, lng } = this.map.getCenter().wrap();
    return { lat, lon: lng };
  }

  showWalk(walk: Walk): void {
    const previous = this.walk;
    this.walk = walk;
    const same = previous !== null && sameWalk(previous, walk) && this.layers.ring.getLayers().length > 0;
    if (!same) {
      this.whenIdle(() => {
        this.drawWalk(walk);
        this.fitWalk(walk);
      });
    }
  }

  /** A survey started: frame the area and sweep it with the radar until the run ends. */
  startRun(area: Area): void {
    this.clearRun();
    this.running = true;
    this.area = area;
    // The frame may have just changed size for the survey view; frame the walk against its new size.
    this.map.invalidateSize();
    this.map.flyToBounds(this.walkBounds(), { ...this.padding(), maxZoom: 16, ...this.flight(1.2) });
    this.startRadar();
  }

  finishRun(): void {
    this.running = false;
    this.stopRadar();
  }

  /** Removes everything a survey drew, keeping the site and its walk. */
  clearRun(): void {
    this.runToken += 1;
    this.running = false;
    this.gap = null;
    this.clearGap();
    this.stopRadar();
  }

  /**
   * Shows one category's places as labeled pins, the trips to the ones people here love outside the walk and its taste
   * grid, framed with the walk; or, for null, clears them and frames the site and its walk again.
   */
  showGap(gap: GapRow | null): void {
    const had = this.gap !== null;
    this.gap = gap;
    if (!gap) {
      this.clearGap();
      if (had && this.site && !this.running) {
        this.map.flyToBounds(this.walkBounds(), { ...this.padding(), maxZoom: 16, ...this.flight(1.2) });
      }
      return;
    }
    const token = this.runToken;
    this.whenIdle(() => {
      if (this.gap === gap && token === this.runToken) this.drawGap(gap);
    });
  }

  private readonly resizeRadar = (): void => {
    if (this.radar && this.site) this.radar.setIcon(this.radarIcon(this.site));
  };

  private whenIdle(draw: () => void): void {
    if (this.moving) this.idleQueue.push(draw);
    else draw();
  }

  private later(callback: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) callback();
    }, ms);
    this.timers.add(timer);
  }

  private flight(duration: number): L.ZoomPanOptions {
    return { animate: !prefersReducedMotion(), duration };
  }

  /**
   * Room kept around what a flight frames, scaled to the map: about 26 px on the small docked map, 80 at full screen.
   * The labels stand half their height beside their places, and the corner controls take the top. The map's key, at its
   * bottom-left on the brief and on a survey's strip, keeps the foot clear as well, so no ring or pin hides under it.
   */
  private padding(): Pick<L.FitBoundsOptions, "paddingTopLeft" | "paddingBottomRight"> {
    const { x, y } = this.map.getSize();
    const pad = Math.round(Math.min(80, Math.max(18, Math.min(x, y) * 0.12)));
    return { paddingTopLeft: [pad + 12, pad + 24], paddingBottomRight: [pad + 12, Math.max(pad + 20, this.keyClearance())] };
  }

  /** How far above the map's foot its key reaches, with room for a pin's label over it; 0 while no key shows. */
  private keyClearance(): number {
    const canvas = this.map.getContainer();
    const key = canvas.parentElement?.querySelector<HTMLElement>(".map-key");
    if (!key?.getClientRects().length) return 0;
    return Math.round(canvas.getBoundingClientRect().bottom - key.getBoundingClientRect().top) + 16;
  }

  /** Frames the open category's pins and the walk, for the map's size now: the frame may have just been resized. */
  private frame(): void {
    this.map.invalidateSize();
    const bounds = this.walkBounds();
    const pins = this.pins.bounds();
    if (pins) bounds.extend(pins);
    this.map.flyToBounds(bounds, { ...this.padding(), maxZoom: 16, ...this.flight(1.2) });
  }

  /** The canvas grid cannot be styled with CSS, so it reads its color from the theme. */
  private gridColor(): string {
    return getComputedStyle(this.map.getContainer()).getPropertyValue("--map-grid-fill").trim() || "#0000ff";
  }

  /**
   * Loads the theme's tiles hidden under the ones on screen, fades them in once every visible tile has arrived and only
   * then drops the old, so a theme switch never shows an empty or half-swapped map while tiles download. Switching
   * back before then keeps what is on screen.
   */
  private showBasemap(theme: Theme): void {
    if (this.basemap?.theme === theme) return;
    if (this.fading?.theme === theme) {
      dropBasemap(this.basemap);
      this.basemap = this.fading;
      this.fading = null;
      return;
    }
    dropBasemap(this.fading);
    const previous = this.basemap;
    const opacity = previous ? 0 : 1;
    const tiles = TILES[theme];
    const next: Basemap = {
      theme,
      layers: [
        L.tileLayer(tiles.base, { ...TILE_OPTIONS, opacity }),
        L.tileLayer(tiles.labels, { ...TILE_OPTIONS, opacity, pane: "labels" }),
      ],
    };
    this.fading = previous;
    this.basemap = next;
    for (const layer of next.layers) layer.addTo(this.map);
    if (!previous) return;

    let shown = false;
    const show = () => {
      if (shown || this.basemap !== next) return;
      shown = true;
      for (const layer of next.layers) layer.setOpacity(1);
      this.later(() => {
        if (this.fading !== previous) return;
        dropBasemap(previous);
        this.fading = null;
      }, BASEMAP_FADE_MS);
    };
    let loading = next.layers.length;
    for (const layer of next.layers) {
      layer.once("load", () => {
        loading -= 1;
        if (loading === 0) show();
      });
    }
    this.later(show, BASEMAP_SWAP_TIMEOUT_MS);
  }

  private showCenter(): void {
    if (this.pointerOnMap) return;
    const center = this.map.getCenter();
    this.readout.textContent = coords(center.lat, center.lng);
  }

  /**
   * The corner control that grows the map to fill the screen and back, drawn like the zoom buttons. A click on it is
   * not a click on the map: it stops at the control, so it never places a site under it, even once the map has grown.
   */
  private addExpander(onExpand: () => void): void {
    const control = new L.Control({ position: "topleft" });
    control.onAdd = () => {
      const box = L.DomUtil.create("div", "map-expand");
      const button = L.DomUtil.create("button", "map-expand-btn", box);
      button.type = "button";
      button.innerHTML = EXPAND_ICONS;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onExpand();
      });
      this.expandBox = box;
      this.expander = button;
      this.labelExpander();
      return box;
    };
    control.addTo(this.map);
  }

  private labelExpander(): void {
    const button = this.expander;
    if (!button) return;
    const label = expandLabel(this.expanded);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.toggleAttribute("data-expanded", this.expanded);
  }

  /** Street level for a site on the full-screen map: 16, or 15 when its area would not show whole at 16. */
  private siteZoom(site: MapPoint): number {
    const reach = L.latLng(site.lat, site.lon).toBounds(2 * walkReach(this.area));
    return streetZoom(this.map.getBoundsZoom(reach, false, L.point(48, 48)));
  }

  /** The zoom at which the circle of the area's reach around a site shows whole. */
  private reachZoom(site: MapPoint): number {
    const reach = L.latLng(site.lat, site.lon).toBounds(2 * reachM(this.area));
    return this.map.getBoundsZoom(reach, false, L.point(48, 48));
  }

  /**
   * The area whole: the ring of an area the owner has just changed is framed, in or out, and so is any ring when
   * `always` (a survey's map that has just changed size); any other ring that reaches past the map's edges brings the
   * map out to its bounds, whatever its size, and one already in view leaves the map where the owner put it. Not on the
   * brief's full-screen map, which stays at street level for placing the site, nor over an open category, which frames
   * its pins with the area.
   */
  private fitWalk(walk: Walk, always = false): void {
    if (walk !== this.walk || this.gap || this.destroyed || (this.expanded && !always)) return;
    const ring = L.latLngBounds(walk.ring);
    if (!ring.isValid()) return;
    const changed = this.areaChanged;
    this.areaChanged = false;
    if (!always && !changed && this.map.getBounds().contains(ring)) return;
    this.map.flyToBounds(ring, { ...this.padding(), maxZoom: 16, ...this.flight(1.2) });
  }

  /**
   * The credits in the map's corner: in full when the map appears, then collapsed into an (i) button after the first
   * pan, zoom or click, or after five seconds, as OpenStreetMap's guideline allows. The button opens them again.
   * Leaflet's own control rewrites its contents whenever the tiles change, so this one is separate.
   */
  private addCredits(): void {
    const control = new L.Control({ position: "bottomright" });
    control.onAdd = () => {
      const box = L.DomUtil.create("div", "credits open");
      const button = L.DomUtil.create("button", "credits-toggle", box);
      button.type = "button";
      button.textContent = "i";
      button.setAttribute("aria-label", "Map credits");
      button.setAttribute("aria-controls", "map-credits");
      button.setAttribute("aria-expanded", "true");
      const text = L.DomUtil.create("span", "credits-text", box);
      text.id = "map-credits";
      text.innerHTML = CREDITS;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);

      let settled = false;
      const show = (open: boolean) => {
        box.classList.toggle("open", open);
        button.setAttribute("aria-expanded", String(open));
      };
      const collapse = () => {
        if (settled) return;
        settled = true;
        show(false);
      };
      button.addEventListener("click", () => {
        settled = true;
        show(!box.classList.contains("open"));
      });
      this.map.once("movestart", collapse);
      this.map.once("zoomstart", collapse);
      this.map.once("click", collapse);
      this.later(collapse, CREDITS_OPEN_MS);
      return box;
    };
    control.addTo(this.map);
  }

  private drawPin(site: MapPoint): void {
    this.layers.site.clearLayers();
    const icon = L.divIcon({ className: "site-icon", iconSize: [0, 0], html: PIN_HTML });
    // Above every pin: a pin never hides the site.
    L.marker([site.lat, site.lon], { icon, interactive: false, keyboard: false, zIndexOffset: SITE_LAYER }).addTo(this.layers.site);
  }

  private drawWalk(walk: Walk): void {
    if (walk !== this.walk) return;
    this.layers.ring.clearLayers();
    L.polygon(walk.ring, { weight: 1.4, dashArray: "4 6", lineJoin: "round", interactive: false, className: "walk" }).addTo(
      this.layers.ring,
    );
  }

  /** The ring traced, or else the circle of the area's reach around the site. */
  private walkBounds(): L.LatLngBounds {
    if (this.walk) return L.latLngBounds(this.walk.ring);
    return this.site ? L.latLng(this.site.lat, this.site.lon).toBounds(2 * reachM(this.area)) : this.map.getBounds();
  }

  private radarIcon(site: MapPoint): L.DivIcon {
    const center = L.latLng(site.lat, site.lon);
    const radius = this.walk?.radius_m ?? reachM(this.area);
    const a = this.map.latLngToLayerPoint(center);
    const b = this.map.latLngToLayerPoint(L.latLng(center.lat + metersToLat(radius), center.lng));
    const r = Math.max(12, Math.round(Math.abs(a.y - b.y)));
    return L.divIcon({ className: "radar-icon", iconSize: [r * 2, r * 2], iconAnchor: [r, r], html: '<div class="radar"></div>' });
  }

  private startRadar(): void {
    this.stopRadar();
    if (!this.site || prefersReducedMotion()) return;
    const token = this.runToken;
    this.whenIdle(() => {
      if (!this.running || this.radar || !this.site || token !== this.runToken) return;
      this.radar = L.marker([this.site.lat, this.site.lon], {
        icon: this.radarIcon(this.site),
        pane: "radar",
        interactive: false,
        keyboard: false,
      }).addTo(this.map);
      this.map.on("zoomend", this.resizeRadar);
    });
  }

  private stopRadar(): void {
    this.radar?.remove();
    this.radar = null;
    this.map.off("zoomend", this.resizeRadar);
  }

  private clearGap(): void {
    this.moveToken += 1;
    this.layers.gap.clearLayers();
    this.layers.grid.clearLayers();
    this.pins.clear();
    this.map.getPane("grid")?.classList.remove("in");
    this.onGrid(false);
  }

  private drawGap(gap: GapRow): void {
    const site = this.site;
    if (!site) return;
    this.clearGap();
    const pins = this.pins.show(gap, site, areaWord(this.walk?.travel));
    // Only the places people here love more than the city say anything about travel; the city's famous spots do not.
    const trips = pins.filter((pin) => pin.role === "loved" && !pin.inArea);
    if (trips.length) {
      const origin: LatLon = [site.lat, site.lon];
      this.afterMove(() => {
        this.drawTrips(origin, trips);
      });
    }
    this.frame();
    void this.drawGrid(gap);
  }

  private drawTrips(origin: LatLon, trips: Pin[]): void {
    trips.forEach((pin, k) => {
      const line = L.polyline(arc(origin, [pin.lat, pin.lon]), { weight: 1.3, interactive: false, className: "leak" }).addTo(
        this.layers.gap,
      );
      this.drawLine(line, k * 80);
    });
  }
  /** Runs once the next flight ends, or after a timeout if the map does not move; a newer gap cancels it. */
  private afterMove(callback: () => void): void {
    const token = ++this.moveToken;
    let ran = false;
    const run = () => {
      if (ran || token !== this.moveToken || this.destroyed) return;
      ran = true;
      callback();
    };
    this.map.once("moveend", run);
    this.later(run, prefersReducedMotion() ? 50 : 1500);
  }

  private drawLine(line: L.Polyline, delay: number): void {
    const path = line.getElement();
    if (!(path instanceof SVGPathElement) || prefersReducedMotion()) return;
    const length = path.getTotalLength();
    path.style.transition = "none";
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    // Reading layout commits the hidden dash before the transition is restored, so the line draws itself.
    path.getBoundingClientRect();
    path.style.transition = "";
    path.addEventListener(
      "transitionend",
      () => {
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
      },
      { once: true },
    );
    this.later(() => {
      path.style.strokeDashoffset = "0";
    }, 40 + delay);
  }

  private async drawGrid(gap: GapRow): Promise<void> {
    const site = this.site;
    if (!site) return;
    const key = `${site.lat.toFixed(5)},${site.lon.toFixed(5)}|${gap.genre_id}`;
    let cells = this.grids.get(key);
    if (!cells) {
      try {
        cells = (await api.heatmap(site.lat, site.lon, gap.genre_id)).cells ?? [];
        this.grids.set(key, cells);
      } catch {
        cells = [];
      }
    }
    if (this.gap !== gap || this.destroyed) return;
    const shown = cells;
    this.whenIdle(() => {
      if (this.gap !== gap) return;
      this.layers.grid.clearLayers();
      const fillColor = this.gridColor();
      for (const cell of shown) {
        if (cell.affinity < 0.45) continue;
        const [dLat, dLon] = cellSpan(cell.geohash);
        const strength = (cell.affinity - 0.45) / 0.55;
        L.rectangle(
          [
            [cell.lat - dLat / 2, cell.lon - dLon / 2],
            [cell.lat + dLat / 2, cell.lon + dLon / 2],
          ],
          {
            renderer: this.gridRenderer,
            stroke: false,
            fillColor,
            fillOpacity: 0.04 + 0.32 * strength ** 1.8,
            interactive: false,
          },
        ).addTo(this.layers.grid);
      }
      this.onGrid(this.layers.grid.getLayers().length > 0);
      const pane = this.map.getPane("grid");
      pane?.classList.remove("in");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          pane?.classList.add("in");
        }),
      );
    });
  }
}
