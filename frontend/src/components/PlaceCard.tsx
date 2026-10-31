import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/css";
import { naturalList, safeLink, standingText } from "../lib/format";
import { OSM_COPYRIGHT, OSM_CREDIT, osmLink } from "../lib/gap";
import { AREA, roleText, type Pin, type PinRole } from "../map/pins";
import "../styles/pins.css";

/** A place's number or letter, drawn like its pin: a square inside the walk, a circle for the places people love. */
export function PinMark({ mark, role, className }: { mark: string; role: PinRole; className?: string }) {
  return (
    <span className={cx("pin-mark", role, className)} aria-hidden="true">
      {mark}
    </span>
  );
}

/** Why the place is on the map, from Qloo's taste data, where the role line does not already say it. */
function sourceText(pin: Pin): string | null {
  return pin.role === "loved" ? "Qloo: loved here more than in the rest of the city" : null;
}

interface PlaceCardProps {
  pin: Pin;
  /** The survey's area inside a sentence: "the walk". */
  area?: string;
  /** Opened from the keyboard: focus moves into the card, and Esc or Close returns it to the pin. */
  focus: boolean;
  onClose: () => void;
  compact?: boolean;
  onExpand?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

/** A compact hover preview, or the full card after explicit activation; external links always require a click. */
export function PlaceCard({ pin, area = AREA, focus, onClose, compact = false, onExpand, onPointerEnter, onPointerLeave }: PlaceCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const title = useId();
  const place = pin.place;

  useEffect(() => {
    if (focus) root.current?.focus({ preventScroll: true });
  }, [pin.key, focus]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    // The full-screen map shrinks on Escape unless something on it handled the key first.
    event.preventDefault();
    onClose();
  }

  const rated = [place?.rating ? `★ ${place.rating.toFixed(1)}` : "", standingText(place?.standing)].filter(Boolean).join(" · ");
  const known = (place?.known_for ?? []).slice(0, 3);
  const complaints = pin.role === "inside" ? (place?.complaints ?? []).slice(0, 3) : [];
  const site = place ? safeLink(place.url) : null;
  const osm = pin.osm ? osmLink(pin.osm.url) : null;
  const source = sourceText(pin);

  return (
    <div
      ref={root}
      className={cx("place-card", pin.role, compact && "preview")}
      role="dialog"
      aria-labelledby={title}
      tabIndex={-1}
      onKeyDown={keyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="pc-head">
        <PinMark mark={pin.mark} role={pin.role} />
        <div className="pc-title">
          <h3 id={title} className="pc-name">
            {pin.name}
          </h3>
          <p className="pc-role mono">{roleText(pin, area)}</p>
        </div>
        <button type="button" className="pc-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {rated ? <p className="pc-rated mono">{rated}</p> : null}
      {!compact && known.length ? <p className="pc-known">Known for {naturalList(known)}.</p> : null}
      {!compact && complaints.length ? (
        <p className="pc-said">
          <span className="pc-said-lead">Reviews complain about</span> <span className="hl">{naturalList(complaints)}</span>.
        </p>
      ) : null}
      {!compact && pin.osm ? (
        <p className="pc-known">
          Qloo doesn&apos;t list it here, so nothing is known of its ratings or reviews
          {pin.osm.tag ? <span className="pc-tag mono"> · {pin.osm.tag}</span> : null}.
        </p>
      ) : null}
      {site ? (
        <a className="pc-link" href={site} target="_blank" rel="noopener noreferrer">
          {place?.link === "menu" ? "Open its menu" : "Open its website"}
          <span aria-hidden="true">↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
      {osm ? (
        <a className="pc-link" href={osm} target="_blank" rel="noopener noreferrer">
          Open it on OpenStreetMap
          <span aria-hidden="true">↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
      {source ? <p className="pc-source mono">{source}</p> : null}
      {compact && onExpand ? <button className="pc-details" type="button" onClick={onExpand}>View details</button> : null}
      {pin.osm ? (
        <p className="pc-source mono">
          Map data{" "}
          <a href={OSM_COPYRIGHT} target="_blank" rel="noopener noreferrer">
            {OSM_CREDIT}
          </a>
        </p>
      ) : null}
    </div>
  );
}
