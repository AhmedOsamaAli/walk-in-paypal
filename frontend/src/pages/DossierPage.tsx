import "../styles/kit.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Kit, KitView } from "../api/kit";
import { DOSSIER_TITLES, DossierBody, dossierArea, dossierContents, dossierGist } from "../components/kit/DossierView";
import { SiteMap } from "../components/kit/SiteMap";
import { ReportPoster } from "../components/kit/ReportPoster";
import type { PosterStatus } from "../components/kit/PosterArt";
import { useLanding } from "../components/kit/TrackedLinks";
import { Link } from "../components/Link";
import { useDocumentTitle, useFocusOnMount } from "../components/Page";
import { dateText } from "../lib/account";
import { fmtLat, fmtLon } from "../lib/format";
import { reportPageCss } from "../lib/kit";
import { reachText } from "../lib/launch";
import { BRIEF_URL, kitUrl, PLACES_URL } from "../lib/routes";
import { coverMapOf } from "../lib/sitemap";
import { useKit, useKitNews } from "../state/kit";
import { useSession } from "../state/session";

const NEWS = {
  building: "The report is still being written. This page shows it as soon as the kit is ready.",
  ready: "The report is ready.",
  failed: "The kit could not be built, so there is no report yet.",
};
const UTC = { timeZone: "UTC" };

/** The paper the report prints on, as a <style> in the head for as long as the report shows. */
function usePaper(css: string | null): void {
  useEffect(() => {
    if (!css) return;
    const style = document.createElement("style");
    style.id = "report-paper";
    style.textContent = css;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, [css]);
}

/** Opens the print dialog once the typefaces have loaded, so the PDF is set in them rather than in a fallback. */
function printReport(): void {
  void document.fonts.ready.then(() => {
    window.print();
  });
}

function Toolbar({ token, title, printable, ready }: { token: string; title: string; printable: boolean; ready: boolean }) {
  return (
    <div className="dz-toolbar no-print">
      <Link className="ghost mono" href={kitUrl(token)}>
        <span aria-hidden="true">←</span> Back to the kit
      </Link>
      <p className="dz-toolbar-title mono">{title}</p>
      {printable ? (
        <div className="dz-toolbar-print">
          <p className="dz-toolbar-hint" id="dz-print-hint">
            {ready ? "Opens the print dialog: choose “Save as PDF”, on A4 or Letter." :
              "Preparing the customized poster, its typefaces and any campaign terms before printing."}
          </p>
          <button type="button" className="ink-button" aria-describedby="dz-print-hint" disabled={!ready} onClick={printReport}>
            Save as PDF
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Document({ view, kit, campaignsError, onPosterStatus, titleRef }: {
  view: KitView; kit: Kit; campaignsError: string | null; onPosterStatus: (status: PosterStatus) => void;
  titleRef: (node: HTMLElement | null) => void;
}) {
  const { dossier } = kit;
  const cover = dossier.cover;
  const contents = dossierContents(dossier);
  const area = dossierArea(dossier);
  const map = useMemo(() => coverMapOf(cover), [cover]);
  const { landing } = useLanding(view.token, view.survey_url);
  const catchment = cover
    ? [
        area,
        cover.walk_source,
        cover.area_km2 != null ? `${cover.area_km2} km²` : null,
        cover.reach_m ? `reaching ${reachText(cover.reach_m)}` : null,
      ]
    : [];
  return (
    <article className="dz-doc" aria-labelledby="dz-title">
      <header className="dz-cover">
        <div className="dz-cover-page">
          <p className="dz-kicker mono">
            <b>Walk-in report</b>
            {cover ? ` · ${cover.genre}` : ""}
          </p>
          <h1 className="dz-name" id="dz-title" ref={titleRef} tabIndex={-1}>
            {cover?.concept ?? kit.concept.name}
          </h1>
          {cover?.tagline ? <p className="dz-tagline">{cover.tagline}</p> : null}
          {cover ? (
            <>
              <figure className="dz-map">
                <SiteMap
                  map={map}
                  ring={cover.ring}
                  site={[cover.lat, cover.lon]}
                  area={area}
                />
              </figure>
              <div className="dz-cover-grid">
                <dl className="dz-facts">
                  <div>
                    <dt className="mono">Site</dt>
                    <dd>
                      {cover.site_label}
                      <small className="mono">
                        {fmtLat(cover.lat)} · {fmtLon(cover.lon)}
                      </small>
                    </dd>
                  </div>
                  <div>
                    <dt className="mono">Catchment</dt>
                    <dd>{catchment.filter(Boolean).join(", ")}</dd>
                  </div>
                </dl>
                <dl className="dz-facts">
                  {cover.neighborhoods.length ? (
                    <div>
                      <dt className="mono">Neighborhoods</dt>
                      <dd>{cover.neighborhoods.join(", ")}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="mono">Evidence</dt>
                    <dd>Surveyed {dateText(cover.evidence_date, UTC)}</dd>
                  </div>
                  <div>
                    <dt className="mono">Prepared</dt>
                    <dd>{dateText(cover.prepared_date, UTC)}, with Walk-in</dd>
                  </div>
                </dl>
              </div>
            </>
          ) : null}
          {cover?.sources.length ? (
            <div className="dz-sources">
              <h2 className="dz-kicker mono">Sources</h2>
              <ul>
                {cover.sources.map((source) => (
                  <li key={source.name}>
                    <b>{source.name}</b>: {source.used_for}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {cover?.basis ? (
            <p className="dz-basis">
              <span className="mono">Basis</span> {cover.basis}
            </p>
          ) : null}
        </div>
        <nav className="dz-contents" aria-label="Contents">
          <h2 className="dz-kicker mono">Contents</h2>
          <ol>
            {contents.map(({ key, no, title }) => (
              <li key={key}>
                <a href={`#dz-${key}`}>
                  <span className="dz-no mono">{no}</span>
                  <span className="dz-contents-title">{title}</span>
                  <small>{dossierGist(dossier, key)}</small>
                </a>
              </li>
            ))}
            <li>
              <a href="#dz-poster">
                <span className="dz-no mono">P</span>
                <span className="dz-contents-title">The customized poster</span>
                <small>The current artwork, on its own printable page</small>
              </a>
            </li>
          </ol>
        </nav>
      </header>
      {contents.map(({ key, no }) => (
        <section className="dz-sec" id={`dz-${key}`} key={key} aria-labelledby={`dz-${key}-title`} data-section={key}>
          <header className="dz-head">
            <span className="dz-no mono">{no}</span>
            <h2 className="dz-title" id={`dz-${key}-title`}>
              {DOSSIER_TITLES[key]}
            </h2>
          </header>
          <div className="dz-doc-body">
            <DossierBody dossier={dossier} part={key} level={2} map={map} />
          </div>
        </section>
      ))}
      <ReportPoster view={view} kit={kit} landing={landing} campaignsError={campaignsError} onStatus={onPosterStatus} />
      <footer className="dz-end mono">
        {kit.concept.name} · Walk-in report
        {cover ? ` · Prepared ${dateText(cover.prepared_date, UTC)} from evidence surveyed ${dateText(cover.evidence_date, UTC)}` : ""}{" "}
        · Taste data by Qloo
      </footer>
    </article>
  );
}

interface WaitingProps {
  token: string;
  message: string;
  /** Whether the kit exists, so its page is worth opening. */
  found: boolean;
  titleRef: (node: HTMLElement | null) => void;
  onRetry?: () => void;
}

function Waiting({ token, message, found, titleRef, onRetry }: WaitingProps) {
  return (
    <div className="dz-wait">
      <h1 className="dz-kicker mono" ref={titleRef} tabIndex={-1}>
        Walk-in report
      </h1>
      <p className="dz-wait-text">{message}</p>
      <div className="dz-wait-links">
        {onRetry ? (
          <button type="button" className="ink-button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {found ? (
          <Link className={onRetry ? "ghost mono" : "ink-button"} href={kitUrl(token)}>
            Open the kit
          </Link>
        ) : (
          <>
            <Link className="ink-button" href={BRIEF_URL}>
              Survey a storefront
            </Link>
            <Link className="ghost mono" href={PLACES_URL}>
              My places
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/** The kit's report as a document: read on screen, printed, or saved as a PDF with the page's print styles. */
export function DossierPage({ token }: { token: string }) {
  const { phase, user } = useSession();
  const { load, restart, campaignsError } = useKit(token, phase === "loading" ? undefined : (user?.id ?? null));
  const [posterStatus, setPosterStatus] = useState<{ token: string; ready: boolean } | null>(null);
  const onPosterStatus = useCallback((status: PosterStatus) => { setPosterStatus({ token, ready: status.ready }); }, [token]);
  const titleRef = useFocusOnMount();
  const view = load.state === "shown" ? load.view : null;
  const kit = view?.status === "ready" ? view.kit : null;
  const news = useKitNews(view?.status ?? null, NEWS);
  const prepared = kit?.dossier.cover ? dateText(kit.dossier.cover.prepared_date, UTC) : null;
  usePaper(
    kit ? reportPageCss(kit.concept.name, `Prepared with Walk-in${prepared ? ` on ${prepared}` : ""} · Taste data by Qloo`) : null,
  );
  useDocumentTitle(kit ? `${kit.concept.name} report` : "Report");

  let body;
  if (kit && view) body = <Document view={view} kit={kit} campaignsError={campaignsError} onPosterStatus={onPosterStatus} titleRef={titleRef} />;
  else if (load.state === "loading") body = <div className="dz-wait sk" aria-busy="true" aria-label="Loading the report" />;
  else if (load.state === "missing") {
    body = (
      <Waiting
        token={token}
        found={false}
        titleRef={titleRef}
        message="This report's link isn't valid, or its kit was deleted with its survey."
      />
    );
  } else if (load.state === "failed") {
    body = <Waiting token={token} found titleRef={titleRef} message={load.message} onRetry={restart} />;
  } else {
    const message =
      view?.status === "building"
        ? (load.stalled ?? NEWS.building)
        : view?.status === "ready"
          ? "The kit is ready but came without its report. Load it again."
          : `${view?.error ?? "The kit could not be built."} Open the kit to build it again.`;
    body = (
      <Waiting
        token={token}
        found
        titleRef={titleRef}
        message={message}
        onRetry={view?.status === "ready" || load.stalled ? restart : undefined}
      />
    );
  }

  return (
    <main className="page dossier-page" id="main">
      <p className="sr-only" role="status" aria-live="polite">
        {news}
      </p>
      <Toolbar token={token} title={kit ? `${kit.concept.name} · Walk-in report` : "Walk-in report"} printable={kit !== null}
        ready={posterStatus?.token === token && posterStatus.ready} />
      {body}
    </main>
  );
}
