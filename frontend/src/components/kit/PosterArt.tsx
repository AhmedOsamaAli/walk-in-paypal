import { useEffect, useId, useMemo, useState, type Ref } from "react";
import { posterLine, SANDBOX_NOTICE } from "../../lib/founders";
import { shortLink } from "../../lib/kit";
import { fitLines, layoutPoster, POSTER_FONTS, POSTER_H, POSTER_M, POSTER_W, roughMeasure, type Block, type Measure, type PosterCampaign, type PosterInput } from "../../lib/poster";
import { brandForPoster, DEFAULT_POSTER_APPEARANCE, type PosterAppearance } from "../../lib/posterBrand";
import { qrPath } from "../../lib/qr";
import { openingClaim } from "../../lib/posterProject";
import { posterMapOf } from "../../lib/sitemap";
import { PosterLocator } from "./PosterLocator";
import { PosterMotif } from "./PosterMotif";

export type { PosterInput } from "../../lib/poster";
export interface PosterStatus { ready: boolean; problem: string | null }
let fontsLoaded = false;

function useMeasure(): { measure: Measure; ready: boolean; problem: string | null } {
  const [ready, setReady] = useState(fontsLoaded);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void Promise.all([
      document.fonts.load(`400 40px ${POSTER_FONTS.serif}`),
      document.fonts.load(`italic 400 40px ${POSTER_FONTS.serif}`),
      document.fonts.load(`400 18px ${POSTER_FONTS.sans}`),
      document.fonts.load(`500 11px ${POSTER_FONTS.mono}`),
    ]).then(() => {
      fontsLoaded = true;
      if (live) setReady(true);
    }, () => {
      if (live) setProblem("The poster typefaces could not load. Reload before printing or exporting.");
    });
    return () => { live = false; };
  }, [ready]);
  const measure = useMemo<Measure>(() => {
    const context = ready ? document.createElement("canvas").getContext("2d") : null;
    if (!context) return roughMeasure;
    return (text, face, size, italic = false) => {
      context.font = `${italic ? "italic " : ""}${face === "mono" ? 500 : 400} ${size}px ${POSTER_FONTS[face]}`;
      return context.measureText(text).width;
    };
  }, [ready]);
  return { measure, ready, problem };
}

export function posterLinkProblem(link: string | null): string | null {
  if (link === null) return null;
  let url: URL;
  try { url = new URL(link); } catch { return "The poster link must be a complete web address."; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "Use a public web link without sign-in credentials.";
  if (/^\/(?:r\/[A-Za-z0-9_-]{32}|api\/receipts\/)/.test(url.pathname)) return "A private pledge receipt must never be printed on a poster.";
  if (/(^|\.)paypal\.com$/.test(url.hostname) && /checkoutnow|approve/.test(url.pathname)) return "Use the public campaign link, not one person's PayPal approval link.";
  return null;
}

function Words({ value, x = POSTER_M, anchor = "start", face = "sans", color }: {
  value: Block | null; x?: number; anchor?: "start" | "middle"; face?: "serif" | "sans" | "mono"; color: string;
}) {
  return value?.lines.map((line, i) => <text key={`${i}:${line}`} x={x} y={value.y[i]} textAnchor={anchor}
    fontFamily={POSTER_FONTS[face]} fontSize={value.size} fill={color}>{line}</text>) ?? null;
}

interface PosterArtProps {
  poster: PosterInput;
  link: string | null;
  campaign?: PosterCampaign | null;
  sandbox?: boolean;
  appearance?: PosterAppearance;
  svgRef?: Ref<SVGSVGElement>;
  onStatus?: (status: PosterStatus) => void;
}

/** One renderer: project-led artwork and checked launch copy, or the same identity with actual Founders perks. */
export function PosterArt({ poster, link, campaign = null, sandbox = false,
  appearance = DEFAULT_POSTER_APPEARANCE, svgRef, onStatus }: PosterArtProps) {
  const measured = useMeasure();
  const id = useId().replace(/[^\w-]/g, "");
  const { measure } = measured;
  const brand = brandForPoster(poster, appearance);
  const map = posterMapOf(poster);
  const streets = map?.streets ?? null;
  const withMap = appearance.locator && streets !== null && poster.site !== undefined;
  const actualPerks = campaign?.perks ?? [];
  const selectedPerk = appearance.leadPerk;
  const chosen = selectedPerk !== undefined && actualPerks.includes(selectedPerk);
  const perks = chosen ? [selectedPerk, ...actualPerks.filter((perk) => perk !== selectedPerk)] : actualPerks;
  const back = campaign ? campaign.accepting ? posterLine(campaign.amount, campaign.goal, campaign.deadline) :
    `This campaign is no longer taking pledges. Original terms: ${posterLine(campaign.amount, campaign.goal, campaign.deadline)} Scan for its current status.` : null;
  const stage = appearance.stage ?? "planned";
  const messages = poster.messages ?? (poster.headline ? [poster.headline] : []);
  const chosenMessage = appearance.message;
  const heading = campaign ? perks[0] ?? null : chosenMessage ?? poster.headline;
  const messageProblem = !campaign && chosenMessage && !messages.includes(chosenMessage) ?
    "Choose a headline from this project's checked copy." : null;
  const prematureOpening = !campaign && stage === "planned" && heading && openingClaim(heading) ?
    "This message says the business is already open. Choose opening-soon wording unless that is true." : null;
  const location = poster.location_label ?? poster.neighborhoods?.join(" · ") ?? null;
  const layout = layoutPoster({
    name: brand.face === "sans" ? poster.name.toUpperCase() : poster.name,
    tagline: poster.tagline, headline: heading,
    subline: campaign ? null : poster.subline, hours: campaign ? null : poster.hours,
    proof: null, back, perks: perks.slice(1), location, sandbox,
  }, measure, { qr: link !== null, locator: withMap, face: brand.face });
  const linkProblem = posterLinkProblem(link);
  const missingPerks = campaign && !perks.length ? "Campaign perks are missing. Load the real perks before exporting." : null;
  const changedPerk = campaign && selectedPerk !== undefined && !chosen ? "The chosen headline perk is not in this campaign. Choose one of its actual perks." : null;
  const problem = measured.problem ?? linkProblem ?? missingPerks ?? changedPerk ?? messageProblem ?? prematureOpening ?? layout.problem;
  useEffect(() => { onStatus?.({ ready: measured.ready && !problem, problem }); }, [onStatus, measured.ready, problem]);
  const code = useMemo(() => link && !posterLinkProblem(link) ? qrPath(link) : null, [link]);
  const align = brand.centered ? "middle" : "start";
  const textX = brand.centered ? POSTER_W / 2 : POSTER_M;
  const label = [poster.name, heading, ...perks.slice(1), back].filter(Boolean).join(". ");
  const linkWidth = layout.qr ? layout.qr.x - POSTER_M - 22 : POSTER_W - 2 * POSTER_M;
  const readableLink = link ? fitLines(shortLink(link), linkWidth,
    (line) => measure(line, "mono", 8.5), 2) : [];
  return (
    <svg ref={svgRef} className="poster-art" data-direction={brand.direction} data-scenario={campaign ? "founders" : "launch"}
      data-poster-ready={measured.ready && !problem} data-poster-problem={problem ?? ""}
      viewBox={`0 0 ${POSTER_W} ${POSTER_H}`} xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby={`${id}-title`}>
      <title id={`${id}-title`}>{`Marketing poster: ${label}`}</title>
      <defs>
        <clipPath id={`${id}-art`}><rect width={layout.art.width} height={layout.art.height} rx={brand.centered ? 60 : 4} /></clipPath>
        <clipPath id={`${id}-locator`}><rect width={layout.map?.width ?? 0} height={layout.map?.height ?? 0} rx="4" /></clipPath>
      </defs>
      <rect width={POSTER_W} height={POSTER_H} fill={brand.paper} />
      {brand.direction === "kinetic" ? <rect x="0" y="0" width="12" height={POSTER_H} fill={brand.ink} /> : null}
      {brand.direction === "coastal" ? <rect x="16" y="16" width={POSTER_W - 32} height={POSTER_H - 32} rx="22" fill="none" stroke={brand.ink} strokeWidth="1.5" /> : null}
      {brand.direction === "editorial" || brand.direction === "workshop" ? <path d={`M${POSTER_M} 58H${POSTER_W - POSTER_M}`} stroke={brand.ink} strokeWidth="1.2" /> : null}
      {appearance.logo ? <g>
        <rect x={POSTER_M - 4} y="14" width="112" height="46" rx="4" fill={appearance.logoBackground ?? "#ffffff"} />
        <image href={appearance.logo} x={POSTER_M} y="18" width="104" height="38" preserveAspectRatio="xMinYMid meet" />
      </g> : null}
      <text x={appearance.logo ? POSTER_W - POSTER_M : textX} y="42" textAnchor={appearance.logo ? "end" : align}
        fontFamily={POSTER_FONTS.mono} fontSize={campaign ? "9" : "10"} letterSpacing="1.4" fill={brand.ink}>
        {campaign ? campaign.accepting ? "BECOME A FOUNDING SUPPORTER" : "THE FOUNDING CAMPAIGN" :
          stage === "open" ? "NOW OPEN" : "COMING SOON TO YOUR NEIGHBORHOOD"}
      </text>
      <Words value={layout.name} x={textX} anchor={align} face={brand.face} color={brand.ink} />
      <Words value={layout.tagline} x={textX} anchor={align} face="serif" color={brand.ink} />
      {layout.headlineLabelY !== null ? <text x={POSTER_M} y={layout.headlineLabelY} fontFamily={POSTER_FONTS.mono}
        fontSize="9" letterSpacing="1.4" fill={brand.ink}>{campaign?.accepting ? "AS A FOUNDER, YOU GET" : "THE CAMPAIGN'S ORIGINAL PERKS"}</text> : null}
      {layout.headline ? <rect x={POSTER_M - 6} y={(layout.headline.y[0] ?? 0) - layout.headline.size * .83}
        width={POSTER_W - POSTER_M * 2 + 12} height={(layout.headline.y.at(-1) ?? 0) - (layout.headline.y[0] ?? 0) + layout.headline.size * 1.15}
        rx={brand.centered ? 14 : 2} fill={brand.accent} /> : null}
      <Words value={layout.headline} face={brand.face} color={brand.accentInk} />
      <Words value={layout.subline} color={brand.ink} />
      <PosterMotif box={layout.art} brand={brand} clipId={`${id}-art`} />
      {layout.perksLabelY !== null ? <text x={POSTER_M} y={layout.perksLabelY} fontFamily={POSTER_FONTS.mono}
        fontSize="9" letterSpacing="1.4" fill={brand.ink}>PLUS, AS A FOUNDER</text> : null}
      {layout.perks.map((perk, i) => <g key={i}>
        <circle cx={POSTER_M + 5} cy={(perk.y[0] ?? 0) - 5} r="3" fill={brand.ink} />
        <Words value={perk} x={POSTER_M + 22} color={brand.ink} />
      </g>)}
      {layout.map && streets && poster.site ? <PosterLocator streets={streets} site={poster.site} box={layout.map} brand={brand} clipId={`${id}-locator`} planned={Boolean(campaign) || stage !== "open"} /> : null}
      <Words value={layout.location} color={brand.ink} />
      <path d={`M${POSTER_M} ${layout.bandTop}H${POSTER_W - POSTER_M}`} stroke={brand.ink} strokeWidth="1.3" />
      <text x={POSTER_M} y={layout.bandTop + 26} fontFamily={POSTER_FONTS.mono} fontSize="9.5" letterSpacing="1.2" fill={brand.ink}>
        {campaign ? "THE PLEDGE" : poster.hours ? stage === "open" ? "HOURS" : "PLANNED HOURS" : "GET THE DETAILS"}
      </text>
      <Words value={layout.back ?? layout.hours} color={brand.ink} />
      {layout.qr && code ? <g transform={`translate(${layout.qr.x} ${layout.qr.y})`} data-poster-qr-frame="true">
        <rect x="-7" y="-3" width={layout.qr.size + 16} height={layout.qr.size + 16} rx="13" fill={brand.ink} opacity=".11" />
        <rect x="-10" y="-9" width={layout.qr.size + 20} height={layout.qr.size + 20} rx={brand.direction === "kinetic" ? "3" : "12"}
          fill={brand.paper} stroke={brand.ink} strokeWidth="1.25" />
        <path d={`M-10 21V-9H21M${layout.qr.size - 21} ${layout.qr.size + 11}H${layout.qr.size + 10}V${layout.qr.size - 19}`}
          fill="none" stroke={brand.accent} strokeWidth="4" />
        <rect width={layout.qr.size} height={layout.qr.size} rx="4" fill="#ffffff" />
        <path data-qr-quiet-modules="5" d={code.path}
          transform={`translate(${layout.qr.size * 5 / (code.size + 10)} ${layout.qr.size * 5 / (code.size + 10)}) scale(${layout.qr.size / (code.size + 10)})`}
          fill="#111111" shapeRendering="crispEdges" />
        <text x={layout.qr.size / 2} y="-16" textAnchor="middle" fontFamily={POSTER_FONTS.mono} fontSize="8.5" fill={brand.ink}>
          {campaign ? campaign.accepting ? "SCAN TO JOIN" : "SCAN FOR STATUS" : "SCAN FOR DETAILS"}
        </text>
      </g> : null}
      {campaign && sandbox ? <text x={POSTER_M} y={POSTER_H - 48} fontFamily={POSTER_FONTS.sans}
        fontSize="9" fill={brand.ink}>{SANDBOX_NOTICE}</text> : null}
      {readableLink.map((line, i) => <text key={i} x={POSTER_M} y={POSTER_H - 30 + i * 10} fontFamily={POSTER_FONTS.mono} fontSize="8.5" fill={brand.ink}>{line}</text>)}
      <text x={POSTER_W - POSTER_M} y={POSTER_H - 10} textAnchor="end" fontFamily={POSTER_FONTS.sans} fontSize="6.8" fill={brand.ink}>Made with Walk-in</text>
    </svg>
  );
}
