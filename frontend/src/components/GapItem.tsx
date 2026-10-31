import { useMemo, type ReactNode } from "react";
import type { FavoritePlace, GapRow, OsmPlace, PlaceCard } from "../api/types";
import { cssVars, cx } from "../lib/css";
import { standingText } from "../lib/format";
import {
  insideShort,
  favoritesOutsidePercent,
  leadLine,
  OSM_COPYRIGHT,
  OSM_CREDIT,
  osmConfirmed,
  osmDetail,
  osmExtra,
  osmLink,
  osmUnchecked,
  readingLabel,
  readingTone,
} from "../lib/gap";
import { lightPin, pinFocus, showPin, usePinFocus } from "../map/pinFocus";
import { AREA, awayText, gapPins, LISTED, medianFarKm, type ListMark } from "../map/pins";
import { CountUp } from "./CountUp";
import { PinMark } from "./PlaceCard";
import { PlaceLink } from "./PlaceLink";

const MAX_PIPS = 24;

/** Whether a pin is lit: hovered or focused here or on the map, or its card is open. */
type Lit = (key: string) => boolean;

/** The pin a list item lights while it is hovered or focused, or nothing for a place with no location. */
function pointsAt(mark: ListMark | null) {
  if (!mark) return {};
  const on = () => {
    lightPin(mark.key);
  };
  // Leaving one item for a pin or another item may come after entering it: only this item's own light goes out.
  const off = () => {
    if (pinFocus().lit === mark.key) lightPin(null);
  };
  return { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off };
}

/** The place's number or letter, as on the map; pressing it shows the place there and opens its card. */
function MarkButton({ mark, name }: { mark: ListMark; name: string }) {
  return (
    <button
      type="button"
      className="mark-btn"
      aria-label={`${mark.mark}: show ${name} on the map`}
      title="Show on the map"
      onClick={(event) => {
        // A click the keyboard made has no pointer presses to count.
        showPin(mark.key, event.detail === 0);
      }}
    >
      <PinMark mark={mark.mark} role={mark.role} />
    </button>
  );
}

/** A list item with its place's mark in the margin. */
function Placed({ mark, lit, name, children }: { mark: ListMark | null; lit: Lit; name: string; children: ReactNode }) {
  return (
    <li className={cx("placed", mark && lit(mark.key) && "lit")} {...pointsAt(mark)}>
      {mark ? <MarkButton mark={mark} name={name} /> : <span className="mark-none" title="Not on the map: Qloo has no location for it" />}
      <span className="mini-body">{children}</span>
    </li>
  );
}

function Competitor({ place, mark, lit }: { place: PlaceCard; mark: ListMark | null; lit: Lit }) {
  const known = (place.known_for ?? []).slice(0, 2).join(", ");
  const complaints = (place.complaints ?? []).slice(0, 2).join(", ");
  const meta = [place.rating ? `★ ${place.rating.toFixed(1)}` : "", standingText(place.standing), known ? `known for ${known}` : ""]
    .filter(Boolean)
    .join(" · ");
  const name = place.name ?? "";
  return (
    <Placed mark={mark} lit={lit} name={name}>
      <span className="n">
        <PlaceLink name={name} url={place.url} kind={place.link} />
      </span>
      {meta ? <span className="s">{meta}</span> : null}
      {complaints ? (
        <span className="s">
          <span className="hl">{complaints}</span>
        </span>
      ) : null}
    </Placed>
  );
}

function Favorite({ place, mark, lit, area }: { place: FavoritePlace; mark: ListMark | null; lit: Lit; area: string }) {
  const where = place.within_walk ? `inside ${area}` : awayText(place.distance_m ?? null);
  const name = place.name ?? "";
  return (
    <Placed mark={mark} lit={lit} name={name}>
      <span className="n">
        <PlaceLink name={name} url={place.url} kind={place.link} />
      </span>
      {place.rating ? <span className="s">★ {place.rating.toFixed(1)}</span> : null}
      {where ? <span className="km">{where}</span> : null}
    </Placed>
  );
}

/** Qloo's places inside the walk as squares, then the ones only OpenStreetMap shows as hollow squares. */
function Pips({ gap }: { gap: GapRow }) {
  const shown = Math.min(gap.nearby_count, MAX_PIPS);
  const extra = Math.min(osmExtra(gap).length, Math.max(0, MAX_PIPS - shown));
  if (!shown && !extra) return <span className="mono muted">none</span>;
  return (
    <>
      {Array.from({ length: shown }, (_, k) => (
        <i key={k} />
      ))}
      {Array.from({ length: extra }, (_, k) => (
        <i key={`osm-${k}`} className="osm" />
      ))}
      {gap.nearby_count > MAX_PIPS || gap.nearby_capped ? <i className="more">+</i> : null}
    </>
  );
}

function OsmLink({ place }: { place: OsmPlace }) {
  const detail = osmDetail(place);
  return (
    <a
      className="place-link"
      href={osmLink(place.url) ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={`${place.name} on OpenStreetMap${detail ? ` · ${detail}` : ""}`}
    >
      {place.name}
      <span aria-hidden="true">↗</span>
      <span className="sr-only"> (opens OpenStreetMap)</span>
    </a>
  );
}

/** What OpenStreetMap shows inside the area that Qloo does not list, or why the gap was not cross-checked. */
function OsmCrossCheck({ gap, marks, lit, area }: { gap: GapRow; marks: (ListMark | null)[]; lit: Lit; area: string }) {
  const osm = gap.osm;
  if (!osm) return null;
  const unchecked = osmUnchecked(osm);
  if (unchecked) return <p className="osm-check unchecked mono">{unchecked}</p>;
  const extra = osmExtra(gap);
  return (
    <div className="osm-check">
      {extra.length ? (
        <p className="osm-also">
          <span className="mono">OpenStreetMap also shows</span>{" "}
          {extra.map((place, k) => {
            const mark = marks[k] ?? null;
            return (
              <span key={place.url}>
                {k ? (k === extra.length - 1 ? " and " : ", ") : null}
                <span className={cx("osm-placed", mark && lit(mark.key) && "lit")} {...pointsAt(mark)}>
                  {mark ? <MarkButton mark={mark} name={place.name} /> : null}
                  <OsmLink place={place} />
                </span>
              </span>
            );
          })}
          <span className="osm-why">. Qloo doesn&apos;t list {extra.length === 1 ? "it" : "them"} here, so the score counts {extra.length === 1 ? "it" : "them"} as supply.</span>
        </p>
      ) : (
        <p className="osm-also mono">{osmConfirmed(osm, area)}</p>
      )}
      <p className="osm-credit mono">
        Map data{" "}
        <a href={OSM_COPYRIGHT} target="_blank" rel="noopener noreferrer">
          {OSM_CREDIT}
        </a>
        , ODbL
      </p>
    </div>
  );
}

function Dots({ gap }: { gap: GapRow }) {
  if (gap.favorites_kind !== "local") return <span className="dots-note">Same as the city&apos;s famous spots</span>;
  return (
    <>
      {Array.from({ length: gap.favorites_total }, (_, k) => (
        <i key={k} className={k < gap.favorites_far ? "on" : undefined} />
      ))}
    </>
  );
}

interface GapItemProps {
  gap: GapRow;
  index: number;
  open: boolean;
  onToggle: (index: number) => void;
  /** The area inside a sentence, as the survey measured it: "the walk", or "the drive" for a drive or a road distance. */
  area?: string;
}

export function GapItem({ gap, index, open, onToggle, area = AREA }: GapItemProps) {
  const local = gap.favorites_kind === "local";
  const outsidePercent = favoritesOutsidePercent(gap);
  const id = `gap-${index}`;
  const rankHere = gap.demand_rank >= 51 ? "50+" : String(gap.demand_rank);
  const around =
    gap.ref_rank == null ? "" : gap.ref_rank >= 51 ? " · 50+ around" : ` · #${gap.ref_rank.toFixed(0)} around`;
  const expected = gap.expected_nearby != null ? ` · ~${gap.expected_nearby.toFixed(1)} typical` : "";
  // The server's numbers, as the legend says them: how many of the loved places lie outside the area, of how many, and
  // the median trip to those outside; the list under it names six at most.
  const km = medianFarKm(gap);
  const outside = local
    ? ` · ${gap.favorites_far} of ${gap.favorites_total} outside${km === null ? "" : ` · median ${km.toFixed(1)} km`}`
    : "";
  const favoritesTitle = local
    ? `Places people here love more than the city does${outside}`
    : "What people here love (the city's famous spots)";
  const competitors = (gap.competitors ?? []).slice(0, LISTED);
  const favorites = (gap.favorites ?? []).slice(0, LISTED);
  const why = gap.why ?? [];
  const blocked = gap.ruled_out ? `Ruled out: ${gap.ruled_out}` : gap.fit && !gap.fit.fits ? `Doesn't fit: ${gap.fit.reason ?? "the unit"}` : null;
  const badge = readingLabel(gap.reading);
  const onOsm = osmExtra(gap).length;
  const pins = useMemo(() => gapPins(gap), [gap]);
  const focus = usePinFocus();
  // Only the open row's places are on the map.
  const lit: Lit = (key) => open && (key === focus.lit || key === focus.open);

  return (
    <li
      className={cx("gap", index === 0 && "first", gap.evidence !== "ok" && "thin", open && "open", blocked && "out")}
      style={cssVars({ "--i": index })}
    >
      <button
        className="gap-row"
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        aria-label={`${gap.genre}, gap score ${gap.gap_score} out of 100${badge ? `, ${badge}` : ""}`}
        aria-describedby={`${id}-why`}
        onClick={() => {
          onToggle(index);
        }}
      >
        <span className="gap-score-value"><CountUp className="gap-score" value={gap.gap_score} /><small>/100</small></span>
        <span>
          <span className="gap-name">{gap.genre}</span>
          <span className="gap-meta">
            {badge ? <small className={cx("mono reading", readingTone(badge))}>{badge}</small> : null}
            <small className="mono">
              #{rankHere} here{around}
            </small>
            {gap.source === "agent" ? <small className="mono flag tested">tested live by agent</small> : null}
            {gap.source === "owner" ? <small className="mono flag tested">your request</small> : null}
          </span>
          {blocked ? <span className="gap-out mono">{blocked}</span> : null}
          <span className="gap-why serif" id={`${id}-why`}>
            {leadLine(gap)}
          </span>
          <span className="gap-bars">
            <span className="meter">
              <span className="mono" title={onOsm ? `${gap.nearby_count} on Qloo, ${onOsm} more only on OpenStreetMap` : undefined}>
                {insideShort(area)} · {gap.nearby_count}
                {gap.nearby_capped ? "+" : ""}
                {onOsm ? ` + ${onOsm} OSM` : ""}
                {expected}
              </span>
              <span className="pips">
                <Pips gap={gap} />
              </span>
            </span>
            <span className="meter">
              <span className="mono">
                {local ? `Favorites outside · ${gap.favorites_far}/${gap.favorites_total}${outsidePercent === null ? "" : ` · ${outsidePercent}%`}` : "Favorites of people here"}
              </span>
              <span className="dots">
                <Dots gap={gap} />
              </span>
            </span>
          </span>
        </span>
        <span className="gap-toggle" aria-hidden="true">
          +
        </span>
      </button>
      <div className="gap-detail-wrap" id={`${id}-detail`} inert={!open}>
        <div className="gap-detail">
          <div className="gap-detail-inner">
            {why.length ? (
              <div className="gap-evidence">
                <h4 className="label mono">The evidence</h4>
                <ul className="why-list">
                  {why.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <h4 className="label mono">Competitors inside {area}</h4>
              <ul className="mini">
                {competitors.length ? (
                  competitors.map((place, k) => (
                    <Competitor key={`${place.name ?? ""}-${k}`} place={place} mark={pins.competitors[k] ?? null} lit={lit} />
                  ))
                ) : (
                  <li className="muted">Qloo lists no direct competitor inside {area}.</li>
                )}
              </ul>
              <OsmCrossCheck gap={gap} marks={pins.osm} lit={lit} area={area} />
            </div>
            <div>
              <h4 className="label mono">{favoritesTitle}</h4>
              {outsidePercent !== null ? <p className="gap-sample-note">{outsidePercent}% of the {gap.favorites_total} located favorites in this Qloo sample are outside {area}.
                {" "}This is a share of sampled places, not residents or a business-success probability.</p> : null}
              <ul className="mini">
                {favorites.length ? (
                  favorites.map((place, k) => (
                    <Favorite
                      key={`${place.name ?? ""}-${k}`}
                      place={place}
                      mark={pins.favorites[k] ?? null}
                      lit={lit}
                      area={area}
                    />
                  ))
                ) : (
                  <li className="muted">No favorites found.</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
