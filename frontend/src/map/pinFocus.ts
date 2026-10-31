/* Which pin the owner is pointing at, in the open category's lists or on the map, and which one's card is open: the
   lists (GapItem.tsx) and the map (controller.ts, SurveyMap.tsx) light the same place whichever side the pointer or
   the keyboard is on. Keys are the pins' keys (pins.ts). */
import { useSyncExternalStore } from "react";

export interface PinFocus {
  /** Hovered or focused, in a list or on the map. */
  lit: string | null;
  /** Mouse over a map badge only; keyboard focus must not open a hover card. */
  hovered: string | null;
  /** The pin whose card is open on the map. */
  open: string | null;
  /** The last pin a list asked the map to show; `asks` counts the requests, so asking again shows it again. */
  shown: string | null;
  asks: number;
  /** The last request came from the keyboard: the card takes focus, and gives it back to the list as it closes. */
  byKeyboard: boolean;
}

let state: PinFocus = { lit: null, hovered: null, open: null, shown: null, asks: 0, byKeyboard: false };
const listeners = new Set<() => void>();

function update(next: Partial<PinFocus>): void {
  const merged = { ...state, ...next };
  if (
    merged.lit === state.lit &&
    merged.hovered === state.hovered &&
    merged.open === state.open &&
    merged.shown === state.shown &&
    merged.asks === state.asks &&
    merged.byKeyboard === state.byKeyboard
  ) {
    return;
  }
  state = merged;
  for (const listener of listeners) listener();
}

export function lightPin(key: string | null): void {
  update({ lit: key });
}

export function setPinHover(key: string | null): void {
  update({ hovered: key });
}

export function openPin(key: string | null): void {
  update({ open: key });
}

/** A list's request to show a place on the map and open its card. */
export function showPin(key: string, byKeyboard = false): void {
  update({ shown: key, asks: state.asks + 1, byKeyboard });
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pinFocus(): PinFocus {
  return state;
}

export function usePinFocus(): PinFocus {
  return useSyncExternalStore(subscribePins, pinFocus, pinFocus);
}
