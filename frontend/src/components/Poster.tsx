import { Fragment, useRef } from "react";
import type { Concept, LoveItem } from "../api/types";
import { loves, riskText, ruleLines } from "../lib/concepts";
import { cssVars, cx } from "../lib/css";
import { letter, list } from "../lib/format";
import { posterButtonId } from "../lib/sections";
import { POSTER_TITLES, themeOf } from "../lib/wildTheme";
import { CountUp } from "./CountUp";
import { WildTheme } from "./WildTheme";
import { KitShortcut } from "./KitOffer";

interface PosterProps {
  concept: Concept;
  /** Its place in the payload, which its design sheet and the sheet's link use. */
  index: number;
  /** Its rank among the ranked concepts; null for the wild card, which is never ranked. */
  rank: number | null;
  /** Its place on the page, for the order the cards come in. */
  position: number;
  onOpen: (index: number, opener: HTMLElement | null) => void;
  runId?: string | null;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a wild card combines, "coffee shops × jazz clubs", and the evidence that people here love each, or only some. */
function Pair({ items, evidence }: { items: string[]; evidence: LoveItem[] }) {
  return (
    <div className="poster-pair">
      <p className="poster-combines">
        <span className="mono">Combines</span>{" "}
        {items.map((item, k) => (
          <Fragment key={item}>
            {k ? (
              <>
                <span aria-hidden="true"> × </span>
                <span className="sr-only"> and </span>
              </>
            ) : null}
            <b>{item}</b>
          </Fragment>
        ))}
      </p>
      <ul className="poster-loves">
        {evidence.map((love) => (
          <li key={love.item}>
            <b>{capitalized(love.item)}:</b> {love.source}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A concept as a poster; the whole card opens its design sheet, and its button makes that keyboard-operable. The wild
 * card has no score or rank: it is stamped untested, says what it combines and why that is a risk. A themed one
 * combines a kind of place with a theme, and shows the titles people here over-index on that the theme is built on,
 * with their pictures, what happens there and who those titles draw.
 */
export function Poster({ concept, index, rank, position, onOpen, runId }: PosterProps) {
  const button = useRef<HTMLButtonElement>(null);
  const wild = rank === null;
  const theme = wild ? themeOf(concept) : null;
  const top = theme ? "Themed wild card · not ranked" : wild ? "Wild card · not ranked" : `Concept ${letter(index)} · ${concept.genre}`;
  const why = wild ? [] : list(concept.why_here).slice(0, 3);
  const signature = list(concept.signature).slice(0, 4);
  const inspired = list(concept.inspired_by).slice(0, 3).join(" · ");
  const pair = wild ? loves(concept) : [];
  // On a themed card the titles are the theme's evidence: of the two loves, only the kind of place keeps its line.
  const [place] = pair;
  const rules = ruleLines(concept);
  const risk = riskText(concept);
  const caution = wild ? concept.caution?.trim() : null;
  return (
    <article
      className={cx("poster", wild ? "wild" : `p${rank}`, theme && "themed")}
      style={cssVars({ "--i": position })}
      aria-labelledby={`poster-${index}-name`}
      onClick={() => {
        onOpen(index, button.current);
      }}
    >
      <div className="poster-top mono">
        <span>{top}</span>
      </div>
      <div className="poster-head">
        {wild ? (
          <span className="stamp untested mono">Untested</span>
        ) : typeof concept.gap_score === "number" ? (
          <div className="poster-score">
            <CountUp value={concept.gap_score} />
            <small>gap /100</small>
          </div>
        ) : null}
        <h3 className="poster-name" id={`poster-${index}-name`}>
          {concept.name}
        </h3>
      </div>
      {theme ? (
        <>
          {place ? <Pair items={[place.item, theme.label]} evidence={[place]} /> : null}
          <WildTheme theme={theme} titles={POSTER_TITLES} />
        </>
      ) : pair.length === 2 ? (
        <Pair items={pair.map((love) => love.item)} evidence={pair} />
      ) : null}
      {concept.one_liner ? <p className="poster-line">{concept.one_liner}</p> : null}
      {caution ? (
        <p className="poster-note poster-caution">
          <b className="mono">Caution</b>
          {caution}
        </p>
      ) : null}
      {why.length ? (
        <ol className="poster-why">
          {why.map((line, k) => (
            <li key={k}>{line}</li>
          ))}
        </ol>
      ) : null}
      {signature.length ? (
        <div className="poster-sig">
          {signature.map((item, k) => (
            <span key={k}>{item}</span>
          ))}
        </div>
      ) : null}
      {concept.beat_competitors ? (
        <p className="poster-note">
          <b className="mono">Competition</b>
          {concept.beat_competitors}
        </p>
      ) : null}
      {rules.length ? (
        <div className="poster-note poster-rules">
          <b className="mono">Your rules</b>
          <ul>
            {rules.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {risk ? (
        <p className="poster-note">
          <b className="mono">Risk</b>
          {risk}
        </p>
      ) : null}
      {inspired ? <p className="poster-insp mono">Inspired by {inspired}</p> : null}
      <button
        ref={button}
        id={posterButtonId(index)}
        className="poster-open mono"
        type="button"
        aria-label={`Open design sheet: ${concept.name}`}
      >
        <span>Open design sheet</span>
        <span aria-hidden="true">→</span>
      </button>
      {runId ? <KitShortcut runId={runId} index={index} name={concept.name} /> : null}
    </article>
  );
}
