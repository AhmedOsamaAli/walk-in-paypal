import "../../styles/founders.css";
import "../../styles/kit.css";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { founders, paypalOf, type Campaign, type KitCampaign } from "../../api/founders";
import { inSandbox } from "../../lib/founders";
import { absoluteUrl, shortLink } from "../../lib/kit";
import { isPlainClick } from "../../lib/navigation";
import {
  brandForPoster, DEFAULT_POSTER_APPEARANCE, isPosterChoice, POSTER_DIRECTIONS, readPosterAppearance, type PosterAppearance,
} from "../../lib/posterBrand";
import { downloadPoster } from "../../lib/posterExport";
import { readPosterLogo } from "../../lib/posterLogo";
import { openingClaim } from "../../lib/posterProject";
import { campaignUrl } from "../../lib/routes";
import { posterMapOf } from "../../lib/sitemap";
import { posterDesign, usePosterAppearance } from "../../state/poster";
import { useSession } from "../../state/session";
import type { Landing } from "./TrackedLinks";
import { PosterArt, type PosterInput, type PosterStatus } from "./PosterArt";

const KEY = "walk-in-poster:";

function stored(scope: string): { appearance: PosterAppearance; notice: string | null } {
  if (typeof window === "undefined") return { appearance: { ...DEFAULT_POSTER_APPEARANCE }, notice: null };
  try { return { appearance: readPosterAppearance(window.localStorage.getItem(KEY + scope)), notice: null }; } catch {
    return { appearance: { ...DEFAULT_POSTER_APPEARANCE }, notice: "This browser could not restore the saved poster design. The project's automatic design is shown." };
  }
}

interface PosterSectionProps {
  poster: PosterInput;
  scope: string;
  link: string | null;
  landing?: Landing;
  campaign: KitCampaign | Campaign | null;
  onAddLink?: () => void;
  mode?: "editor" | "report";
  onStatus?: (status: PosterStatus) => void;
}

/** One editor, print copy and export path for a launch kit or any business's Founders campaign. */
export function PosterSection({ poster, scope, link, landing, campaign, onAddLink, mode = "editor", onStatus }: PosterSectionProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [initial] = useState(() => stored(scope));
  const appearance = usePosterAppearance(scope);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const [error, setError] = useState<string | null>(null);
  const [ownsLogo, setOwnsLogo] = useState(Boolean(initial.appearance.logo));
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [status, setStatus] = useState<PosterStatus>({ ready: false, problem: null });
  const [read, setRead] = useState<{ id: string; campaign: Campaign | null; error: string | null } | null>(null);
  const { config } = useSession();
  const paypal = paypalOf(config);
  const id = campaign?.id ?? null;
  const supplied = campaign && "perks" in campaign ? campaign : null;
  const details = supplied ?? (read?.id === id ? read.campaign : null);
  const own = landing?.kind === "own" ? landing : null;
  const code = id ? absoluteUrl(campaignUrl(id)) : own || !landing ? link : null;
  const loaded = id === null || (details !== null && paypal !== null);
  const failed = read?.id === id ? read.error : null;
  const brand = brandForPoster(poster, appearance);
  const mapAvailable = poster.site !== undefined && posterMapOf(poster)?.streets != null;

  useEffect(() => {
    onStatus?.({ ready: loaded && status.ready, problem: failed ?? status.problem });
  }, [loaded, status.ready, status.problem, failed, onStatus]);

  useEffect(() => {
    if (!id || supplied) return;
    const abort = new AbortController();
    founders.campaign(id, abort.signal).then(
      (record) => { setRead({ id, campaign: record, error: null }); },
      () => {
        if (!abort.signal.aborted) setRead({ id, campaign: null, error: "The campaign's actual perks could not be loaded. Reopen this poster to try again; it will not invent them." });
      },
    );
    return () => { abort.abort(); };
  }, [id, supplied]);

  function save(next: PosterAppearance) {
    setError(null);
    if (posterDesign.save(scope, next)) {
      setNotice("Design saved on this device. The logo is embedded in downloads, not uploaded to a server.");
    } else {
      setNotice("This browser cannot save the design. You can still print or download it during this visit.");
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const logo = await readPosterLogo(file);
      save({ ...appearance, logo: logo.data, logoBackground: logo.background, ...(logo.accent ? { accent: logo.accent } : {}) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The logo could not be read.");
    } finally { setBusy(false); }
  }

  async function exportAs(format: "svg" | "png") {
    if (!svg.current) { setError("The poster is not ready to export yet."); return; }
    setBusy(true);
    setError(null);
    try { await downloadPoster(svg.current, poster.name, format); } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The poster could not be downloaded.");
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!printing) return;
    document.documentElement.dataset.print = "poster";
    let live = true;
    const done = () => { setPrinting(false); };
    window.addEventListener("afterprint", done);
    void document.fonts.ready.then(() => {
      if (live) window.print();
    }).catch(() => {
      if (live) { setPrinting(false); setError("The poster could not be prepared for printing. Try downloading it instead."); }
    });
    return () => {
      live = false;
      window.removeEventListener("afterprint", done);
      delete document.documentElement.dataset.print;
    };
  }, [printing]);

  const art = loaded ? <PosterArt poster={poster} link={code} campaign={details} sandbox={inSandbox(paypal)}
    appearance={appearance} svgRef={svg} onStatus={setStatus} /> : null;
  const disabled = !loaded || !status.ready || busy;
  if (mode === "report") return (
    <figure className="poster-report-frame" data-report-poster data-report-ready={loaded && status.ready}>
      {art ?? <p className="poster-ask" role={failed ? "alert" : "status"}>{failed ?? "Loading the campaign's real perks and payment terms..."}</p>}
      {notice ? <figcaption className="poster-tip" role="status">{notice}</figcaption> : null}
      {status.problem ? <figcaption className="page-alert" role="alert">{status.problem}</figcaption> : null}
    </figure>
  );
  return (
    <div className="poster-section">
      <figure className="poster-frame">
        {art ?? <p className="poster-ask" role={failed ? "alert" : "status"}>{failed ?? "Loading the campaign's real perks and payment terms..."}</p>}
      </figure>
      <div className="poster-side">
        <p className="poster-side-lead">
          Artwork around <b>{poster.name}</b>&apos;s identity and offer.
          {id ? " The first participation perk leads; the other real perks and pledge terms follow." :
            " The business and its offer lead; the QR code takes customers to your page."}
        </p>
        <fieldset className="poster-design-controls">
          <legend className="mono">Make it yours</legend>
          {details ? <label>Lead with this participation perk
            <select className="field-input" value={appearance.leadPerk ?? ""} onChange={(event) => {
              const next = event.target.value;
              if (!next) {
                const { leadPerk: removed, ...rest } = appearance;
                if (removed) save(rest);
              } else if (details.perks.includes(next)) save({ ...appearance, leadPerk: next });
              else setError("Choose one of this campaign's actual participation perks.");
            }}>
              <option value="">Use the campaign's first perk</option>
              {details.perks.map((perk, i) => <option key={`${i}:${perk}`} value={perk}>{perk}</option>)}
            </select>
          </label> : null}
          {!id && poster.messages?.length ? <label>Headline from this project's checked copy
            <select className="field-input" value={appearance.message ?? ""} onChange={(event) => {
              const next = event.target.value;
              if (!next) {
                const { message: removed, ...rest } = appearance;
                if (removed) save(rest);
              } else if (poster.messages?.includes(next)) save({ ...appearance, message: next });
              else setError("Choose one of this project's checked messages.");
            }}>
              <option value="">Use the project-specific offer</option>
              {poster.messages.filter((message) => appearance.stage === "open" || !openingClaim(message))
                .map((message) => <option key={message} value={message}>{message}</option>)}
            </select>
          </label> : null}
          {!id ? <label className="poster-check"><input type="checkbox" checked={appearance.stage === "open"}
            onChange={(event) => { save({ ...appearance, stage: event.target.checked ? "open" : "planned" }); }} />
            The business is already open: use “now open” wording</label> : null}
          {!id ? <small>Otherwise the poster says coming soon and labels the hours as planned. This changes poster wording only, not campaign or payment status.</small> : null}
          <label>Art direction
            <select className="field-input" value={appearance.choice} onChange={(event) => {
              if (isPosterChoice(event.target.value)) save({ ...appearance, choice: event.target.value });
              else setError("Choose one of the available art directions.");
            }}>
              <option value="auto">From this project's identity</option>
              {POSTER_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction.charAt(0).toUpperCase()}{direction.slice(1)}</option>)}
            </select>
          </label>
          <label>Brand accent
            <input type="color" value={appearance.accent ?? brand.accent}
              onChange={(event) => { save({ ...appearance, accent: event.target.value }); }} />
          </label>
          <label className="poster-check"><input type="checkbox" checked={ownsLogo} onChange={(event) => {
            setOwnsLogo(event.target.checked);
            if (!event.target.checked) {
              const { logo: removed, logoBackground: background, ...rest } = appearance;
              if (removed) save(rest);
              else if (background) save(rest);
            }
          }} />I own this logo or have permission to use it</label>
          <label>Add your logo
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!ownsLogo || busy}
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
          </label>
          <small>PNG, JPEG or WebP, up to 512 KB. Its main color can become the accent; text contrast stays readable.</small>
          <label className="poster-check"><input type="checkbox" checked={appearance.locator} disabled={!mapAvailable}
            onChange={(event) => { save({ ...appearance, locator: event.target.checked }); }} />Add a small street locator for off-site promotion</label>
          <small>{mapAvailable ? "The proposed door and real streets only: no catchment statistics or competitor arrows." :
            "No street map is available for this poster. Its location text still prints; no map is invented."}</small>
          <button type="button" className="text-button" onClick={() => { setOwnsLogo(false); save({ ...DEFAULT_POSTER_APPEARANCE }); }}>Reset artwork and logo</button>
        </fieldset>
        {code ? <p className="poster-link"><span className="mono">QR destination</span><br />{shortLink(code)}</p> : (
          <div className="poster-ask" role="note">
            <p><b>No QR code yet.</b> Add your public website, social page, map listing or a campaign link first. Without one the poster prints without a code.</p>
            {onAddLink ? <a className="ghost mono" href="#links" onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onAddLink();
            }}>Add your link</a> : null}
          </div>
        )}
        {status.problem ? <p className="page-alert" role="alert">{status.problem}</p> : null}
        {error ? <p className="page-alert" role="alert">{error}</p> : null}
        {notice ? <p className="poster-tip" role="status">{notice}</p> : null}
        <div className="poster-actions">
          <button type="button" className="ink-button" disabled={disabled} onClick={() => { setPrinting(true); }}>Print the poster</button>
          <button type="button" className="ghost mono" disabled={disabled} onClick={() => { void exportAs("svg"); }}>Download SVG</button>
          <button type="button" className="ghost mono" disabled={disabled} onClick={() => { void exportAs("png"); }}>Download PNG</button>
        </div>
        <p className="poster-tip">Print one A4 or US Letter page, portrait, or choose Save as PDF. SVG and PNG downloads include the typefaces and logo. Test the QR code before putting the poster up.</p>
        {poster.claim?.proof ? <details className="poster-tip"><summary>Evidence behind the checked copy</summary><p>{poster.claim.proof}</p></details> : null}
      </div>
      {printing && loaded ? createPortal(
        <div className="print-only print-poster" aria-hidden="true">
          <PosterArt poster={poster} link={code} campaign={details} sandbox={inSandbox(paypal)} appearance={appearance} />
        </div>, document.body,
      ) : null}
    </div>
  );
}
