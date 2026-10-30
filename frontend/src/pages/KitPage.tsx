import "../styles/kit.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { kits, type Kit, type KitView } from "../api/kit";
import { BrandMark } from "../components/BrandMark";
import { FoundersTab } from "../components/founders/FoundersTab";
import { CopyChecks, CopyDeck } from "../components/kit/CopyDeck";
import { DossierBody, dossierContents, dossierGist } from "../components/kit/DossierView";
import { KitPoster } from "../components/kit/KitPoster";
import { ReportPoster } from "../components/kit/ReportPoster";
import { OWN_LINK_ID, TrackedLinks, useLanding } from "../components/kit/TrackedLinks";
import { Link } from "../components/Link";
import { Page, PageHead, useDocumentTitle, useFocusOnMount } from "../components/Page";
import { SectionHead } from "../components/SectionHead";
import type { TitleField } from "../components/SiteHeader";
import { panelId, tabId, TabPager, TabPanel, Tabs, type TabItem } from "../components/Tabs";
import { dateText } from "../lib/account";
import { letter } from "../lib/format";
import { ownCampaign } from "../lib/founders";
import { focusHeading } from "../lib/journey";
import { kitError } from "../lib/kit";
import { KIT_PARTS, kitPart, partInHash, type KitPart } from "../lib/kitParts";
import { scrollBehavior } from "../lib/motion";
import { BRIEF_URL, dossierUrl, PLACES_URL } from "../lib/routes";
import { useNow } from "../lib/useNow";
import { useKit, useKitNews } from "../state/kit";
import { useSession } from "../state/session";

const BUILD_STEPS = [
  "The design sheet, if the concept had none yet",
  "Ad copy for each channel, every line checked against the evidence",
  "The window poster, on the streets around the site",
  "Tracked links for every channel",
  "The report for a landlord or a lender",
];

const NEWS = {
  building: "Building the launch kit. This page fills in by itself as soon as it is ready.",
  ready: "The launch kit is ready.",
  failed: "The launch kit could not be built.",
};

/** The ids of the kit's tabs and their panels: "kit-tab-poster", "kit-panel-poster". */
const TABS = "kit";

function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

function Building({ view, stalled, onCheck }: { view: KitView; stalled: string | null; onCheck: () => void }) {
  const now = useNow(1000);
  const elapsed = (now - Date.parse(view.created_at)) / 1000;
  const progress = Number.isFinite(elapsed) ? Math.min(0.78, Math.max(0.05, elapsed / 75)) : 0.2;
  return (
    <section className="pg-sec kit-state" data-state="building" aria-labelledby="kit-building" aria-busy={stalled === null}>
      <div className="kit-walk" aria-hidden="true">
        <BrandMark state="walking" progress={progress} />
      </div>
      <div className="kit-state-text">
        <h2 className="kit-state-title" id="kit-building">
          Building your kit
        </h2>
        <p className="kit-state-lead">
          About a minute. This page fills in by itself as soon as the kit is ready; you can leave and come back with the
          same link.
        </p>
        <ol className="kit-steps">
          {BUILD_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {stalled ? (
          <p className="page-alert kit-state-alert" role="alert">
            {stalled}{" "}
            <button type="button" className="text-button" onClick={onCheck}>
              Check again
            </button>
          </p>
        ) : (
          <p className="kit-state-meta mono">Started {since(view.created_at, now)} · checking every 2 seconds</p>
        )}
      </div>
    </section>
  );
}

function Failed({ view, onRetried }: { view: KitView; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await kits.retry(view.token);
      onRetried();
    } catch (failure) {
      // Started again from another tab (409), or gone (404): the page shows what the kit is now.
      if (failure instanceof ApiError && (failure.status === 409 || failure.status === 404)) {
        onRetried();
        return;
      }
      setError(kitError(failure, "The kit could not be started again. Try again in a moment."));
      setBusy(false);
    }
  }

  return (
    <section className="pg-sec kit-state" data-state="failed" aria-labelledby="kit-failed">
      <p className="kit-state-mark mono" aria-hidden="true">
        Not built
      </p>
      <div className="kit-state-text">
        <h2 className="kit-state-title" id="kit-failed">
          The kit could not be built
        </h2>
        <p className="kit-state-lead">{view.error ?? "Something went wrong while it was being built."}</p>
        <div className="kit-state-links">
          <button
            type="button"
            className="ink-button"
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => {
              // Not disabled while it starts: a disabled button drops the keyboard's focus.
              if (!busy) void retry();
            }}
          >
            {busy ? "Starting again…" : "Build it again"}
          </button>
          <Link className="ghost mono" href={view.survey_url}>
            Back to the design sheet
          </Link>
        </div>
        <p className="kit-state-note" role="status" aria-live="polite">
          {error ?? ""}
        </p>
      </div>
    </section>
  );
}

function Missing() {
  return (
    <section className="pg-sec kit-state" data-state="missing" aria-label="What to do next">
      <div className="kit-state-text">
        <p className="kit-state-lead">
          The link may be mistyped, or the kit was deleted with its survey. The kits made for your saved surveys are in My
          places.
        </p>
        <div className="kit-state-links">
          <Link className="ink-button" href={BRIEF_URL}>
            Survey a storefront
          </Link>
          <Link className="ghost mono" href={PLACES_URL}>
            My places
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The part on show: the one the address's hash names (a link can open the kit on its report), else the poster. Choosing
 * a part writes it in the hash, in place, so Back still leaves the kit rather than stepping through its tabs.
 */
function usePart(): [KitPart, (part: KitPart) => void] {
  const [part, setPart] = useState<KitPart>(() => partInHash(window.location.hash) ?? "poster");
  useEffect(() => {
    const follow = () => {
      const named = partInHash(window.location.hash);
      if (named) setPart(named);
    };
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
    };
  }, []);
  const choose = useCallback((next: KitPart) => {
    setPart(next);
    window.history.replaceState(window.history.state, "", `#${next}`);
  }, []);
  return [part, choose];
}

/**
 * After a part is chosen: its top under the pinned tabs (`under` is how far the last part's top had gone beneath them,
 * measured as it was chosen, before a tab taking the keyboard's focus scrolls the page), or the owner's link field in
 * view with the cursor in it.
 */
type Then = { to: "top"; y: number; under: number; pinned: boolean } | { to: "field" };

function measured(part: KitPart): Then {
  const bar = document.getElementById(tabId(TABS, part))?.closest<HTMLElement>(".tabs");
  const panel = document.getElementById(panelId(TABS, part));
  if (!bar || !panel) return { to: "top", y: window.scrollY, under: 0, pinned: false };
  const box = bar.getBoundingClientRect();
  return {
    to: "top",
    y: window.scrollY,
    under: Math.max(0, box.bottom - panel.getBoundingClientRect().top),
    // At its sticky offset: held under the top bar while the page scrolls on.
    pinned: box.top <= parseFloat(getComputedStyle(bar).top) + 1,
  };
}

function bringIntoView(then: Then): void {
  if (then.to === "field") {
    const field = document.getElementById(OWN_LINK_ID);
    field?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    field?.focus({ preventScroll: true });
    return;
  }
  // Chosen while the tabs were pinned, a part starts at its top just under them, not where the last part was left.
  if (then.pinned) window.scrollTo({ top: then.y - then.under, behavior: "instant" });
}

function Ready({ view, kit, campaignsError }: { view: KitView; kit: Kit; campaignsError: string | null }) {
  const { website, invalid, landing, setWebsite } = useLanding(view.token, view.survey_url);
  const [part, setPart] = usePart();
  const then = useRef<Then | null>(null);
  /** A part chosen from the foot of the last one: focus moves to the new part's heading once it shows. */
  const focusNext = useRef(false);
  const campaign = ownCampaign(view);
  const contents = dossierContents(kit.dossier);
  const cover = kit.dossier.cover;
  const sections = kit.dossier.sections.length;
  const pieces = Object.keys(kit.copy).length;
  const items: TabItem[] = KIT_PARTS.map(({ id, label, teaser }) => ({
    id,
    label,
    teaser,
    badge:
      id === "copy"
        ? String(pieces)
        : id === "links" && landing.kind === "own"
          ? String(kit.links.length)
          : id === "founders" && campaign
            ? `${campaign.supporters}/${campaign.goal}`
            : null,
  }));

  // Once the chosen part shows.
  useLayoutEffect(() => {
    const after = then.current;
    then.current = null;
    if (after) bringIntoView(after);
    const panel = document.getElementById(panelId(TABS, part));
    if (focusNext.current && panel) focusHeading(panel);
    focusNext.current = false;
  }, [part]);

  function choose(next: KitPart, to: Then["to"] = "top") {
    const after: Then = to === "field" ? { to } : measured(part);
    if (next === part) {
      bringIntoView(after);
      return;
    }
    then.current = after;
    setPart(next);
  }

  const pager = (id: KitPart) => (
    <TabPager
      items={items}
      current={id}
      onSelect={(next) => {
        const chosen = kitPart(next);
        if (!chosen) return;
        focusNext.current = true;
        choose(chosen);
      }}
    />
  );

  return (
    <>
      <Tabs
        label="Your kit"
        items={items}
        selected={part}
        onSelect={(id) => {
          const next = kitPart(id);
          if (next) choose(next);
        }}
        idPrefix={TABS}
        pin="page"
        className="kit-tabs"
      />
      <TabPanel idPrefix={TABS} id="poster" selected={part === "poster"} className="pg-sec">
        <SectionHead
          no="01"
          title="The window poster"
          note={
            campaign
              ? "Print it for the window. Its QR code opens your Founders campaign, and it says the campaign's terms."
              : landing.kind === "own"
                ? "Print it for the window. Its QR code opens your link, tagged as the poster's channel."
                : "Print it for the window. Add your link under Links and it carries a QR code to it."
          }
        />
        <KitPoster
          view={view}
          kit={kit}
          landing={landing}
          campaignsError={campaignsError}
          onAddLink={() => {
            choose("links", "field");
          }}
        />
        {pager("poster")}
      </TabPanel>

      <TabPanel idPrefix={TABS} id="copy" selected={part === "copy"} className="pg-sec">
        <SectionHead
          no="02"
          title="Ad copy"
          note={`${pieces === 1 ? "One piece" : `${pieces} pieces`}, one per channel of the launch plan. Every line was checked against the evidence: no number it does not give, no other business's name, no superlative.`}
        />
        <CopyDeck kit={kit} />
        <CopyChecks kit={kit} />
        {pager("copy")}
      </TabPanel>

      <TabPanel idPrefix={TABS} id="links" selected={part === "links"} className="pg-sec">
        <SectionHead
          no="03"
          title="Tracked links"
          note="One link per channel, tagged so your analytics can tell which channel brought each visit."
        />
        <TrackedLinks links={kit.links} landing={landing} website={website} invalid={invalid} onWebsite={setWebsite} />
        {pager("links")}
      </TabPanel>

      <TabPanel idPrefix={TABS} id="report" selected={part === "report"} className="pg-sec">
        <SectionHead
          no="04"
          title="The report"
          note={`The case for this business in ${sections} sections, for a landlord or a lender. Every section says what it rests on.`}
        />
        <div className="dz-preview">
          <div className="dz-preview-head">
            <Link className="ink-button" href={dossierUrl(view.token)}>
              Open the report <span aria-hidden="true">→</span>
            </Link>
            <p className="dz-preview-note">
              A document to print or save as a PDF
              {cover ? `, prepared ${dateText(cover.prepared_date, { timeZone: "UTC" })}` : ""}: open it, then choose “Save as
              PDF”.
            </p>
          </div>
          {part === "report" ? <ReportPoster preview view={view} kit={kit} landing={landing} campaignsError={campaignsError} /> : null}
          <ol className="dz-toc">
            {contents.map(({ key, no, title }) => (
              <li key={key}>
                <details className="dz-fold">
                  <summary>
                    <span className="dz-no mono">{no}</span>
                    <span className="dz-fold-text">
                      <h3 className="dz-fold-title">{title}</h3>
                      <span className="dz-gist">{dossierGist(kit.dossier, key)}</span>
                    </span>
                    <span className="dz-fold-mark" aria-hidden="true" />
                  </summary>
                  <div className="dz-fold-body dz-doc-body">
                    <DossierBody dossier={kit.dossier} part={key} level={3} />
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </div>
        {pager("report")}
      </TabPanel>

      <TabPanel idPrefix={TABS} id="founders" selected={part === "founders"} className="pg-sec">
        <SectionHead
          no="05"
          title="Founders"
          note={`Let the neighbors back ${kit.concept.name} before the lease is signed. They pledge with PayPal, which only holds the money: everyone is charged only if enough of them join by your deadline.`}
        />
        <FoundersTab
          view={view}
          kit={kit}
          onPoster={() => {
            focusNext.current = true;
            choose("poster");
          }}
        />
        {pager("founders")}
      </TabPanel>
    </>
  );
}

/** The business's name, once the kit or the page about it has one. */
function nameOf(view: KitView | null, kit: Kit | null): string | null {
  if (kit) return kit.concept.name;
  if (view?.name) return view.name;
  return null;
}

/**
 * The title takes the focus when the page opens, so a screen reader starts there. A design sheet closing as this page
 * opens (its launch-kit card led here) hands the focus back to the survey behind it, which is hidden by then: the focus
 * then lands on nothing, and comes back to the title.
 */
function useTitleFocus(): (node: HTMLElement | null) => void {
  const focusOnMount = useFocusOnMount();
  const title = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        title.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return useCallback(
    (node: HTMLElement | null) => {
      title.current = node;
      focusOnMount(node);
    },
    [focusOnMount],
  );
}

/** A launch kit by its link: followed while it is built, then its poster, ad copy, tracked links, report and Founders, a
 * tab each. */
export function KitPage({ token }: { token: string }) {
  const { phase, user } = useSession();
  const { load, restart, campaignsError } = useKit(token, phase === "loading" ? undefined : (user?.id ?? null));
  const titleRef = useTitleFocus();
  const view = load.state === "shown" ? load.view : null;
  const kit = view?.status === "ready" ? view.kit : null;
  const name = nameOf(view, kit);
  const news = useKitNews(view?.status ?? null, NEWS);
  useDocumentTitle(name ? `${name} launch kit` : "Launch kit");

  const cover = kit?.dossier.cover;
  const fields: TitleField[] | undefined = kit
    ? [
        { label: "Site", lines: [cover?.site_label ?? "—"] },
        {
          label: "Catchment",
          lines: [
            kit.poster.area_label ?? `${kit.poster.minutes}-minute walk`,
            ...(cover?.area_km2 != null ? [`${cover.area_km2} km²`] : []),
          ],
        },
        { label: "Built", lines: [dateText(kit.built_at)] },
        { label: "Copy written by", lines: [kit.mode === "agent" ? (kit.model ?? "The agent") : "The evidence rules"] },
      ]
    : undefined;
  const eyebrow = view
    ? // The page bolds the eyebrow's first word: "Launch kit" is one.
      `Launch\u00a0kit · Concept ${letter(view.index)}${kit ? ` · ${kit.concept.genre}` : ""}`
    : "Launch\u00a0kit";
  const title = load.state === "missing" ? "This kit isn't here" : (name ?? "Launch kit");

  return (
    <Page className="kit-page">
      <p className="sr-only" role="status" aria-live="polite">
        {news}
      </p>
      <PageHead
        eyebrow={eyebrow}
        title={title}
        titleRef={titleRef}
        standfirst={kit ? (cover?.tagline ?? kit.poster.tagline ?? undefined) : undefined}
        fields={fields}
        actions={
          view ? (
            <Link className="ghost mono" href={view.survey_url}>
              <span aria-hidden="true">←</span> Back to the design sheet
            </Link>
          ) : undefined
        }
      />
      {load.state === "loading" ? (
        <section className="pg-sec" aria-busy="true" aria-label="Loading the kit">
          <div className="sk sk-line" />
          <div className="sk sk-block" />
        </section>
      ) : null}
      {load.state === "missing" ? <Missing /> : null}
      {load.state === "failed" ? (
        <section className="pg-sec" aria-label="The kit did not load">
          <p className="page-alert" role="alert">
            {load.message}{" "}
            <button type="button" className="text-button" onClick={restart}>
              Try again
            </button>
          </p>
        </section>
      ) : null}
      {view?.status === "building" ? <Building view={view} stalled={load.state === "shown" ? load.stalled : null} onCheck={restart} /> : null}
      {view?.status === "failed" ? <Failed view={view} onRetried={restart} /> : null}
      {view && kit ? <Ready view={view} kit={kit} campaignsError={campaignsError} /> : null}
      {view?.status === "ready" && !kit ? (
        <section className="pg-sec" aria-label="The kit did not load">
          <p className="page-alert" role="alert">
            The kit is ready but came without its contents.{" "}
            <button type="button" className="text-button" onClick={restart}>
              Load it again
            </button>
          </p>
        </section>
      ) : null}
    </Page>
  );
}
