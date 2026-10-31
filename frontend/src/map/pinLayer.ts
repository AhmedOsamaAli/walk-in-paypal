/* The open category's pins on the Leaflet map (pins.ts says which and how they are labeled; pins.css draws them). Each
   pin is a keyboard-reachable button: Enter, Space, a click or a tap opens its card, and hovering or focusing it lights
   the same place in the lists, and mouse hover opens a compact preview (pinFocus.ts). Badges that would cover each other, the site or
   the map's controls step aside, with a short line back to the place, stay inside the map, and are placed again
   whenever the map stops moving. */
import * as L from "leaflet";
import type { GapRow } from "../api/types";
import { lightPin, pinFocus, setPinHover, subscribePins } from "./pinFocus";
import { AREA, declutter, gapPins, pinLabel, type Box, type Pin, type PinRole } from "./pins";

/** A badge with its ring, in pixels. */
const BADGE = 26;
/** The site's square and its tag, around the site's point (map.css .site-pin): badges keep off both. */
const SITE_CLEAR: readonly Box[] = [
  { left: -14, top: -14, right: 14, bottom: 14 },
  { left: 14, top: -37, right: 70, bottom: -10 },
];
/** Numbers above letters where they meet; a lit or open pin above all of them. The site stays above every pin. */
const LAYER: Record<PinRole, number> = { inside: 400, osm: 300, loved: 200, famous: 200 };
const LIT = 3000;
export const SITE_LAYER = 9000;

interface Drawn {
  pin: Pin;
  marker: L.Marker;
  /** The .pin element that holds the badge, its line and its dot. */
  root: HTMLElement;
}

function part(className: string, text = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

export interface PinLayerOptions {
  /** A pin was clicked, tapped, or pressed with Enter or Space. */
  onSelect: (pin: Pin, byKeyboard: boolean) => void;
}

export class PinLayer {
  private readonly map: L.Map;
  private readonly group: L.LayerGroup;
  private readonly onSelect: PinLayerOptions["onSelect"];
  private readonly drawn = new Map<string, Drawn>();
  private readonly unsubscribe: () => void;
  private site: L.LatLng | null = null;
  private lit: string | null = null;
  private opened: string | null = null;

  constructor(map: L.Map, options: PinLayerOptions) {
    this.map = map;
    this.onSelect = options.onSelect;
    this.group = L.layerGroup().addTo(map);
    map.on("moveend viewreset resize", this.arrange);
    this.unsubscribe = subscribePins(() => {
      this.restyle();
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.map.off("moveend viewreset resize", this.arrange);
    this.clear();
    this.group.remove();
  }

  /**
   * Draws a category's pins around the site, replacing any drawn before, and returns them in order. `area` names the
   * survey's area in their labels ("the walk").
   */
  show(gap: GapRow, site: { lat: number; lon: number }, area = AREA): Pin[] {
    this.clear();
    this.site = L.latLng(site.lat, site.lon);
    const { pins } = gapPins(gap);
    pins.forEach((pin, order) => {
      this.add(pin, order, area);
    });
    this.arrange();
    this.lit = null;
    this.opened = null;
    this.restyle();
    return pins;
  }

  clear(): void {
    const hover = pinFocus().hovered;
    if (hover && this.drawn.has(hover)) setPinHover(null);
    this.group.clearLayers();
    this.drawn.clear();
  }

  get size(): number {
    return this.drawn.size;
  }

  pin(key: string): Pin | null {
    return this.drawn.get(key)?.pin ?? null;
  }

  /** Every pin's place, for framing the map. */
  bounds(): L.LatLngBounds | null {
    const points = [...this.drawn.values()].map(({ marker }) => marker.getLatLng());
    return points.length ? L.latLngBounds(points) : null;
  }

  /** Pans a pin into view when it is outside it, for a list's "show on the map". */
  reveal(key: string, animate: boolean): Pin | null {
    const entry = this.drawn.get(key);
    if (!entry) return null;
    const at = entry.marker.getLatLng();
    const inner = this.map.getBounds().pad(-0.12);
    if (!inner.contains(at)) this.map.panTo(at, { animate });
    return entry.pin;
  }

  focus(key: string): void {
    this.drawn.get(key)?.marker.getElement()?.focus({ preventScroll: true });
  }

  /**
   * Moves the map the least it takes for a pin's badge to come out from under `cover` (its card, over the full-screen
   * map), keeping the badge on the map; nothing moves when the badge is already clear.
   */
  uncover(key: string, cover: DOMRect, animate: boolean): void {
    const badge = this.drawn.get(key)?.root.querySelector(".pin-mark");
    if (!badge) return;
    const box = badge.getBoundingClientRect();
    const room = 16;
    const hidden =
      box.left < cover.right + room && cover.left - room < box.right && box.top < cover.bottom + room && cover.top - room < box.bottom;
    if (!hidden) return;
    const map = this.map.getContainer().getBoundingClientRect();
    const shifts = [
      { x: 0, y: cover.top - room - box.bottom },
      { x: 0, y: cover.bottom + room - box.top },
      { x: cover.left - room - box.right, y: 0 },
      { x: cover.right + room - box.left, y: 0 },
    ].sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    const onMap = ({ x, y }: { x: number; y: number }) =>
      box.left + x >= map.left + room && box.right + x <= map.right - room && box.top + y >= map.top + room && box.bottom + y <= map.bottom - room;
    const shift = shifts.find(onMap) ?? shifts[0];
    // The view moves the other way from what is on it.
    if (shift) this.map.panBy([-shift.x, -shift.y], { animate });
  }

  private add(pin: Pin, order: number, area: string): void {
    const root = document.createElement("div");
    root.className = `pin ${pin.role}`;
    const badge = part(`pin-mark ${pin.role}`, pin.mark);
    root.append(part("pin-leg"), part("pin-dot"), badge);
    root.style.setProperty("--k", String(order));
    const icon = L.divIcon({ className: "pin-icon", iconSize: [0, 0], html: root });
    const marker = L.marker([pin.lat, pin.lon], { icon, keyboard: true, zIndexOffset: LAYER[pin.role], alt: "" });
    // Hover previews and list highlights share pinFocus; click and keyboard activation open the full card.
    marker.on("click", () => {
      this.onSelect(pin, false);
    });
    marker.addTo(this.group);
    const drawn: Drawn = { pin, marker, root };
    const element = marker.getElement();
    if (element) {
      element.setAttribute("aria-label", pinLabel(pin, area));
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        this.onSelect(pin, true);
      });
      const on = () => {
        lightPin(pin.key);
      };
      const off = () => {
        if (pinFocus().lit === pin.key) lightPin(null);
      };
      element.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") { on(); setPinHover(pin.key); }
      });
      element.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "mouse") {
          off();
          if (pinFocus().hovered === pin.key) setPinHover(null);
        }
      });
      element.addEventListener("focus", on);
      element.addEventListener("blur", off);
    }
    this.drawn.set(pin.key, drawn);
  }

  /**
   * Spaces the badges for the map as it is now: none over another, over the site or under a control in its corners,
   * crowded ones a step aside, and every badge whose place is in view wholly inside the map.
   */
  private readonly arrange = (): void => {
    if (!this.drawn.size) return;
    const entries = [...this.drawn.values()];
    const points = entries.map(({ marker }) => this.map.latLngToLayerPoint(marker.getLatLng()));
    const from = this.site ? this.map.latLngToLayerPoint(this.site) : null;
    const origin = this.map.containerPointToLayerPoint([0, 0]);
    const size = this.map.getSize();
    const keepClear = from
      ? SITE_CLEAR.map((box) => ({ left: from.x + box.left, top: from.y + box.top, right: from.x + box.right, bottom: from.y + box.bottom }))
      : [];
    const container = this.map.getContainer();
    const frame = container.getBoundingClientRect();
    for (const control of container.querySelectorAll(".leaflet-control")) {
      const box = control.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      keepClear.push({
        left: origin.x + box.left - frame.left,
        top: origin.y + box.top - frame.top,
        right: origin.x + box.right - frame.left,
        bottom: origin.y + box.bottom - frame.top,
      });
    }
    const view = { left: origin.x + 2, top: origin.y + 2, right: origin.x + size.x - 2, bottom: origin.y + size.y - 2 };
    const offsets = declutter(points, BADGE, keepClear, from, view);
    entries.forEach((entry, k) => {
      const offset = offsets[k] ?? { x: 0, y: 0 };
      const { root } = entry;
      const length = Math.hypot(offset.x, offset.y);
      root.style.setProperty("--dx", `${offset.x}px`);
      root.style.setProperty("--dy", `${offset.y}px`);
      // The line stops at the badge's edge.
      root.style.setProperty("--len", `${Math.max(0, length - 11)}px`);
      root.style.setProperty("--ang", `${Math.atan2(offset.y, offset.x)}rad`);
      root.toggleAttribute("data-moved", length > 0);
    });
  };

  /** Lights the pin hovered or focused here or in a list, and the one whose card is open. */
  private restyle(): void {
    const { lit, open } = pinFocus();
    if (lit === this.lit && open === this.opened) return;
    for (const key of new Set([this.lit, this.opened, lit, open])) {
      const entry = key ? this.drawn.get(key) : undefined;
      if (!entry) continue;
      const on = key === lit || key === open;
      entry.root.toggleAttribute("data-lit", key === lit);
      entry.root.toggleAttribute("data-open", key === open);
      entry.marker.setZIndexOffset(LAYER[entry.pin.role] + (on ? LIT : 0));
    }
    this.lit = lit;
    this.opened = open;
  }
}
