import "../styles/founders.css";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { canRetry, founders, paypalOf, type Campaign, type CampaignProgress } from "../api/founders";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { PayPalPledge } from "../components/founders/PayPalPledge";
import { ProgressBar } from "../components/founders/ProgressBar";
import { SandboxNotice } from "../components/founders/SandboxNotice";
import { CampaignPosterButton } from "../components/founders/CampaignPosterButton";
import { Link } from "../components/Link";
import { MapsLink } from "../components/MapsLink";
import { Page, useDocumentTitle, useFocusOnMount } from "../components/Page";
import { plainError } from "../lib/account";
import { cx } from "../lib/css";
import {
  closedText,
  countRows,
  dayText,
  deadlineText,
  inSandbox,
  moneyFact,
  moneyText,
  payoutText,
  pledgeTerms,
  progressNews,
  statusText,
  timeLeft,
} from "../lib/founders";
import { absoluteUrl } from "../lib/kit";
import { useNavigate } from "../lib/navigation";
import { campaignUrl, FOUNDERS_URL, type CampaignRoute } from "../lib/routes";
import { useNow } from "../lib/useNow";
import { heldPledge, keepPledge, useCampaign, type HeldPledge } from "../state/founders";
import { session, useSession } from "../state/session";
import { PrivateReceipt } from "../components/founders/PrivateReceipt";

/** A pledge the supporter approved on PayPal's own page, which sent them back here to place the hold. */
type Return = { orderId: string; phase: "holding" } | { orderId: string; phase: "failed"; message: string };

/** What the pledge card says above the button: back from PayPal without approving, or a pledge just withdrawn. */
type Said = "cancelled" | "withdrawn" | null;

const STEPS_ID = "cp-how";

/** The count, the bar, the money behind it, and what is still needed by when. */
function Standing({ campaign, now }: { campaign: Campaign; now: number }) {
  const { progress } = campaign;
  const left = timeLeft(campaign.deadline, now);
  const money = moneyFact(campaign.status, progress.total);
  return (
    <div className={cx("cp-standing", progress.funded && "funded")}>
      <p className="cp-count">
        <b>{progress.supporters}</b>
        <span>
          of {progress.goal} neighbors
          <small className="mono">{progress.funded ? "Goal met" : "have joined"}</small>
        </span>
      </p>
      <ProgressBar
        supporters={progress.supporters}
        goal={progress.goal}
        funded={progress.funded}
        label={`Neighbors backing ${campaign.name}`}
      />
      <dl className="cp-facts">
        <div className="cp-money">
          <dt className="mono">{money.label}</dt>
          <dd>{money.value}</dd>
        </div>
        <div>
          <dt className="mono">{progress.funded ? "Goal" : campaign.accepting ? "Still needed" : "Short by"}</dt>
          <dd>
            {progress.funded ? (
              "Met"
            ) : campaign.accepting ? (
              <>
                {progress.remaining} more <span className="nowrap">by {dayText(campaign.deadline)}</span>
              </>
            ) : (
              `${progress.remaining} ${progress.remaining === 1 ? "neighbor" : "neighbors"}`
            )}
          </dd>
        </div>
        <div>
          <dt className="mono">{left.closed || !campaign.accepting ? "Status" : "Time left"}</dt>
          <dd>{left.closed || !campaign.accepting ? statusText(campaign.status, campaign.accepting) : left.text.replace(/ left$/, "")}</dd>
        </div>
      </dl>
      <p className="cp-deadline mono">Deadline · {deadlineText(campaign.deadline)}</p>
    </div>
  );
}

/** After the hold: thanks, the terms again, and the way to withdraw while the campaign is open. */
function Held({ campaign, pledge, onWithdrawn }: { campaign: Campaign; pledge: HeldPledge; onWithdrawn: (progress: CampaignProgress) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { config } = useSession();
  const amount = moneyText(campaign.amount, campaign.currency);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      const { progress } = await founders.withdraw(campaign.id, pledge.orderId);
      onWithdrawn(progress);
    } catch (failure) {
      setError(plainError(failure, "The pledge could not be withdrawn. Try again in a moment."));
      setBusy(false);
    }
  }

  return (
    <div className="cp-held">
      <p className="cp-held-kicker mono">Your pledge is held</p>
      <p className="cp-held-title">Thank you for backing {campaign.name}.</p>
      <p className="cp-held-text">
        PayPal holds your {amount}. You are charged only if {campaign.goal} neighbors join by {dayText(campaign.deadline)};
        otherwise the hold is released and you pay nothing.
      </p>
      {pledge.receipt ? <PrivateReceipt token={pledge.receipt} /> : null}
      {campaign.accepting ? (
        <div className="cp-held-out">
          <p>Changed your mind? You can withdraw from this browser while the campaign is open.</p>
          <button
            type="button"
            className="ghost mono"
            disabled={busy}
            onClick={() => {
              setAsking(true);
            }}
          >
            {busy ? "Withdrawing…" : "Withdraw my pledge"}
          </button>
        </div>
      ) : null}
      <p className="pay-note" data-tone="error" role="status">
        {error ?? ""}
      </p>
      <ConfirmDialog
        open={asking}
        title="Withdraw your pledge?"
        confirm="Withdraw my pledge"
        cancel="Keep my pledge"
        danger
        onConfirm={() => {
          setAsking(false);
          void withdraw();
        }}
        onCancel={() => {
          setAsking(false);
        }}
      >
        <p>PayPal releases the hold on your {amount}, so nothing is charged. You can pledge again while the campaign is open.</p>
        {inSandbox(paypalOf(config)) ? <SandboxNotice /> : null}
      </ConfirmDialog>
    </div>
  );
}

interface PledgeCardProps {
  campaign: Campaign;
  now: number;
  held: HeldPledge | null;
  back: Return | null;
  said: Said;
  news: string;
  onHeld: (orderId: string, progress: CampaignProgress, receipt?: string) => void;
  onWithdrawn: (progress: CampaignProgress) => void;
  onProgress: (progress: CampaignProgress) => void;
  onClosed: () => void;
}

/** The card beside the story: the count, then the one thing to do here, with the terms in plain words. */
function PledgeCard({ campaign, now, held, back, said, news, onHeld, onWithdrawn, onProgress, onClosed }: PledgeCardProps) {
  const { phase, config } = useSession();
  const paypal = paypalOf(config);
  const amount = moneyText(campaign.amount, campaign.currency);
  const terms = pledgeTerms(campaign.amount, campaign.goal, campaign.deadline);

  let action;
  if (held && campaign.accepting) action = <Held campaign={campaign} pledge={held} onWithdrawn={onWithdrawn} />;
  else if (back?.phase === "holding") {
    action = (
      <p className="cp-holding mono" role="status">
        Placing your hold with PayPal…
      </p>
    );
  } else if (!campaign.accepting) {
    action = (
      <div className="cp-closed">
        <p className="cp-closed-title">Pledges are closed</p>
        <p>{closedText(campaign.status)}</p>
        {held ? <p className="cp-closed-yours">You backed it from this browser.</p> : null}
      </div>
    );
  } else if (campaign.is_owner) {
    action = (
      <div className="cp-preview">
        <p className="cp-action-title">Neighbors pledge {amount} here with PayPal</p>
        <p className="cp-terms">{terms}</p>
      </div>
    );
  } else {
    let pay;
    if (phase === "loading") pay = <div className="sk pp-wait" aria-hidden="true" />;
    else if (!config) {
      pay = (
        <p className="pay-note" data-tone="error">
          Walk-in&apos;s settings could not be loaded, so PayPal can&apos;t start.{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              void session.load();
            }}
          >
            Try again
          </button>
        </p>
      );
    } else if (!paypal?.enabled) {
      pay = <p className="cp-off">Pledging is off on this server: PayPal isn&apos;t set up here. Nothing can be pledged yet.</p>;
    } else {
      pay = <PayPalPledge campaign={campaign} paypal={paypal} onHeld={onHeld} onProgress={onProgress} onClosed={onClosed} />;
    }
    action = (
      <div className="cp-pledge">
        {said === "cancelled" ? <p className="cp-said">You left PayPal before approving, so nothing was held.</p> : null}
        {said === "withdrawn" ? (
          <p className="cp-said">Your pledge is withdrawn: PayPal released the hold, so nothing is charged.</p>
        ) : null}
        {back?.phase === "failed" ? (
          <p className="cp-said" data-tone="error">
            {back.message}
          </p>
        ) : null}
        <p className="cp-action-title" id="cp-pledge-title">
          Pledge {amount} with PayPal
        </p>
        <p className="cp-terms">{terms}</p>
        {pay}
      </div>
    );
  }

  return (
    <section className="cp-card" aria-label={`Back ${campaign.name}`}>
      <Standing campaign={campaign} now={now} />
      {/* The owner's part above already says it. */}
      {!campaign.is_owner && (!paypal || (paypal.enabled && inSandbox(paypal))) ? <SandboxNotice className="cp-sandbox" /> : null}
      {action}
      <p className="sr-only" role="status" aria-live="polite">
        {news}
      </p>
    </section>
  );
}

/** The owner's part: the counts, sharing, closing or cancelling, and where the money stands. */
function OwnerPanel({ campaign, onCampaign }: { campaign: Campaign; onCampaign: (campaign: Campaign) => void }) {
  const { config } = useSession();
  const [asking, setAsking] = useState<"close" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const box = useRef<HTMLElement>(null);
  const owner = campaign.owner;
  const rows = owner ? countRows(owner.counts) : [];
  const share = absoluteUrl(campaignUrl(campaign.id));
  const { progress } = campaign;
  const open = campaign.status === "open";
  const amount = moneyText(campaign.amount, campaign.currency);
  // Once funded, or past the deadline, it can be settled now; short of the goal while it runs, only cancelled.
  const settle = open && (progress.funded || !campaign.accepting);
  const cancel = open && campaign.accepting && !progress.funded;

  async function act(action: "close" | "cancel") {
    setBusy(true);
    setNote({ tone: "info", text: action === "close" ? "Closing and settling with PayPal…" : "Cancelling and releasing every hold…" });
    try {
      const next = action === "close" ? await founders.close(campaign.id) : await founders.cancel(campaign.id);
      onCampaign(next);
      setNote({
        tone: "info",
        text: action === "close" ? "Closed. The settlement is below." : "Cancelled. Every hold is released: nobody pays.",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) void session.refresh();
      setNote({ tone: "error", text: plainError(error, "That did not go through. Try again in a moment.") });
    } finally {
      setBusy(false);
    }
  }

  let headline: string;
  if (!open) headline = statusText(campaign.status);
  else if (progress.funded) headline = "The goal is met";
  else if (!campaign.accepting) headline = "The deadline has passed";
  else headline = "Share it, and watch it fill";

  return (
    <section className="cp-owner" aria-labelledby="cp-owner-title">
      <div className="cp-owner-head">
        <p className="cp-owner-kicker mono">Your campaign</p>
        <h2 className="cp-owner-title" id="cp-owner-title">
          {headline}
        </h2>
      </div>
      <div className="cp-owner-grid">
        <div className="cp-owner-col">
          <p className="cp-owner-label mono">Pledges</p>
          {rows.length ? (
            <dl className="cp-counts">
              {rows.map((row) => (
                <div key={row.key} data-key={row.key}>
                  <dt className="mono">{row.label}</dt>
                  <dd>{row.count}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="cp-owner-empty">No pledges yet. Share the page, and print the poster from your launch kit.</p>
          )}
          <p className="cp-owner-label mono">Share this page</p>
          <p className="cp-share">
            <code ref={box}>{share}</code>
            <CopyButton text={share} what="the campaign's link" target={box} />
          </p>
          {campaign.kit_url ? <Link className="text-link cp-owner-kit" href={`${campaign.kit_url}#poster`}>
            The window poster, with its QR code to this page <span aria-hidden="true">→</span>
          </Link> : null}
        </div>
        <div className="cp-owner-col">
          {owner?.report?.length ? (
            <>
              <p className="cp-owner-label mono">Settlement</p>
              <ul className="cp-report">
                {owner.report.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          {owner ? (
            <>
              <p className="cp-owner-label mono">Payout</p>
              <p className="cp-payout" data-status={owner.payout.status}>
                {payoutText(owner.payout)}
              </p>
            </>
          ) : null}
          {settle || cancel ? (
            <div className="cp-owner-actions">
              {settle ? (
                <button
                  type="button"
                  className="ink-button"
                  disabled={busy}
                  onClick={() => {
                    setAsking("close");
                  }}
                >
                  {progress.funded ? "Close and collect" : "Settle now"}
                </button>
              ) : null}
              {cancel ? (
                <button
                  type="button"
                  className="ghost mono danger"
                  disabled={busy}
                  onClick={() => {
                    setAsking("cancel");
                  }}
                >
                  Cancel and release every hold
                </button>
              ) : null}
            </div>
          ) : null}
          {cancel ? (
            <p className="cp-owner-fine">
              Close and collect comes once {campaign.goal} neighbors have joined. Until then, cancelling releases every hold
              and nobody pays.
            </p>
          ) : null}
          <p className="cp-owner-status" data-tone={note?.tone} role="status">
            {note?.text ?? ""}
          </p>
          {inSandbox(paypalOf(config)) ? <SandboxNotice /> : null}
        </div>
      </div>
      <ConfirmDialog
        open={asking !== null}
        title={asking === "cancel" ? "Cancel the campaign?" : progress.funded ? "Close and collect now?" : "Settle it now?"}
        confirm={asking === "cancel" ? "Cancel and release every hold" : progress.funded ? "Close and collect" : "Settle now"}
        cancel="Keep it open"
        danger={asking === "cancel"}
        onConfirm={() => {
          const action = asking;
          setAsking(null);
          if (action) void act(action);
        }}
        onCancel={() => {
          setAsking(null);
        }}
      >
        <p>
          {asking === "cancel"
            ? "Every hold is released and nobody pays. This can't be undone."
            : progress.funded
              ? `PayPal collects every held pledge now: ${progress.supporters} neighbors at ${amount} each. The total, after PayPal's fees, goes to ${owner?.payout.email ?? "your PayPal email"}. This can't be undone.`
              : `The goal wasn't met (${progress.supporters} of ${progress.goal}), so every hold is released and nobody pays. This can't be undone.`}
        </p>
        {inSandbox(paypalOf(config)) ? <SandboxNotice /> : null}
      </ConfirmDialog>
    </section>
  );
}

/** The story beside the card: the pitch, why this and why here, the perks, how it works and the plan. */
function Story({ campaign }: { campaign: Campaign }) {
  const amount = moneyText(campaign.amount, campaign.currency);
  const day = dayText(campaign.deadline);
  return (
    <div className="cp-story">
      <p className="cp-pitch serif">{campaign.pitch}</p>
      {campaign.evidence.length ? (
        <section className="cp-sec" aria-labelledby="cp-why">
          <h2 className="cp-h" id="cp-why">
            {campaign.source === "owner" ? "Why here, in the owner's words" : "Why this, why here"}
          </h2>
          <ol className="cp-evidence">
            {campaign.evidence.map((line) => (
              <li key={line}>
                <span>{line}</span>
              </li>
            ))}
          </ol>
          {campaign.source === "owner" ? (
            <p className="cp-source">Provided by the owner. Not verified by a Walk-in survey.</p>
          ) : campaign.survey_url ? <p className="cp-source">
            From Walk-in&apos;s survey of the {campaign.place.area} around the door, with Qloo&apos;s taste data.{" "}
            <Link className="text-link" href={campaign.survey_url}>
              See the survey <span aria-hidden="true">→</span>
            </Link>
          </p> : null}
        </section>
      ) : null}
      {campaign.perks.length ? (
        <section className="cp-sec" aria-labelledby="cp-perks">
          <h2 className="cp-h" id="cp-perks">
            What founding supporters get
          </h2>
          <ul className="cp-perks">
            {campaign.perks.map((perk) => (
              <li key={perk}>{perk}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="cp-sec" aria-labelledby={STEPS_ID}>
        <h2 className="cp-h" id={STEPS_ID}>
          How it works
        </h2>
        <ol className="cp-steps">
          <li>
            <b>Pledge {amount}</b>
            <span>PayPal holds it. Nothing is charged yet.</span>
          </li>
          <li>
            <b>
              {campaign.goal} neighbors by <span className="nowrap">{day}</span>
            </b>
            <span>Everyone is charged, and the money goes to the owner to open it.</span>
          </li>
          <li>
            <b>Short of {campaign.goal}?</b>
            <span>Every hold is released. Nobody pays.</span>
          </li>
        </ol>
        {campaign.how_it_works ? <p className="cp-how">{campaign.how_it_works}</p> : null}
      </section>
      <section className="cp-sec" aria-labelledby="cp-plan">
        <h2 className="cp-h" id="cp-plan">
          The plan
        </h2>
        <p className="cp-genre mono">{campaign.concept.genre}</p>
        <p className="cp-summary">{campaign.concept.summary}</p>
        <p className="cp-plan-links">
          {campaign.kit_url ? <Link className="text-link" href={campaign.kit_url}>
            The launch kit <span aria-hidden="true">→</span>
          </Link> : null}
          {campaign.survey_url ? <Link className="text-link" href={campaign.survey_url}>
            The survey <span aria-hidden="true">→</span>
          </Link> : null}
          <MapsLink lat={campaign.place.lat} lon={campaign.place.lon} />
        </p>
      </section>
    </div>
  );
}

function Unavailable({ load, onRetry }: { load: { state: "loading" } | { state: "missing" } | { state: "failed"; message: string }; onRetry: () => void }) {
  const titleRef = useFocusOnMount();
  return (
    <Page className="campaign-page">
      <header className="page-head">
        <p className="eyebrow mono">
          <b>Founders</b> Back it before it opens
        </p>
        <h1 className="page-title" ref={titleRef} tabIndex={-1}>
          {load.state === "missing" ? "This campaign isn't here" : "Founders"}
        </h1>
      </header>
      <section className="pg-sec" aria-busy={load.state === "loading"} aria-label="The campaign">
        {load.state === "loading" ? (
          <>
            <div className="sk sk-line" />
            <div className="sk sk-block" />
          </>
        ) : load.state === "missing" ? (
          <p className="kit-state-lead">
            The link may be mistyped, or the campaign was removed.{" "}
            <Link className="text-link" href={FOUNDERS_URL}>
              See the open campaigns <span aria-hidden="true">→</span>
            </Link>
          </p>
        ) : (
          <p className="page-alert" role="alert">
            {load.message}{" "}
            <button type="button" className="text-button" onClick={onRetry}>
              Try again
            </button>
          </p>
        )}
      </section>
    </Page>
  );
}

/** A Founders campaign: the business, the place, why here, the count, and "Pledge with PayPal"; its owner's part too. */
export function CampaignPage({ route }: { route: CampaignRoute }) {
  const { phase, user } = useSession();
  const navigate = useNavigate();
  const { load, reload, replace, setProgress } = useCampaign(route.id, phase === "loading" ? undefined : (user?.id ?? null));
  const campaign = load.state === "shown" ? load.campaign : null;
  const titleRef = useFocusOnMount();
  const now = useNow(30_000);
  const [held, setHeld] = useState<HeldPledge | null>(() => heldPledge(route.id));
  const [back, setBack] = useState<Return | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [handled, setHandled] = useState<{ pledge: string | null; cancelled: boolean }>({ pledge: null, cancelled: false });
  const [news, setNews] = useState("");
  const [seen, setSeen] = useState<{ id: string; supporters: number } | null>(null);
  useDocumentTitle(campaign ? campaign.title : "Founders");

  // Back from PayPal's own page (the link an AI assistant handed over): the approved order to hold, or nothing held.
  if (route.pledge && route.pledge !== handled.pledge) {
    setHandled({ ...handled, pledge: route.pledge });
    setBack({ orderId: route.pledge, phase: "holding" });
    setSaid(null);
  }
  if (route.cancelled && !handled.cancelled) {
    setHandled({ ...handled, cancelled: true });
    setSaid("cancelled");
  }

  // A change in the count, said aloud; not the count the page opened with.
  if (campaign && (seen?.id !== campaign.id || seen.supporters !== campaign.progress.supporters)) {
    if (seen?.id === campaign.id) setNews(progressNews(campaign.progress));
    setSeen({ id: campaign.id, supporters: campaign.progress.supporters });
  }

  const id = route.id;
  const holding = back?.phase === "holding" ? back.orderId : null;
  // The hold is placed once per return from PayPal, whoever signs in meanwhile.
  const after = useRef({ setProgress, reload });
  useEffect(() => {
    after.current = { setProgress, reload };
  });
  useEffect(() => {
    if (!holding) return;
    let live = true;
    founders.authorize(id, holding).then(
      ({ status, progress }) => {
        if (!live) return;
        after.current.setProgress(progress);
        if (status === "authorized") {
          const pledge = { orderId: holding, at: new Date().toISOString() };
          keepPledge(id, pledge);
          setHeld(pledge);
          setBack(null);
        } else setBack({ orderId: holding, phase: "failed", message: "PayPal declined the pledge, so nothing is held. You can try again here." });
      },
      (error: unknown) => {
        if (!live) return;
        let message: string;
        if (canRetry(error)) message = "PayPal declined that way to pay, so nothing is held. Pledge again here and choose another.";
        else if (error instanceof ApiError && error.status === 409) {
          message = plainError(error, "This campaign no longer takes pledges, so nothing was held.");
          after.current.reload();
        } else if (error instanceof ApiError && error.status === 404) {
          message = "PayPal sent back a pledge this campaign doesn't have, so nothing is held. You can pledge here.";
        } else message = plainError(error, "PayPal could not place the hold, so nothing is held. Try again here.");
        setBack({ orderId: holding, phase: "failed", message });
      },
    );
    return () => {
      live = false;
    };
  }, [id, holding]);

  // Once said, PayPal's query leaves the address, so a reload or a shared link does not repeat it.
  const settled = back?.phase !== "holding" && (route.pledge !== null || route.cancelled);
  useEffect(() => {
    if (settled) navigate(campaignUrl(id), { replace: true });
  }, [settled, id, navigate]);

  if (!campaign) return <Unavailable load={load.state === "shown" ? { state: "loading" } : load} onRetry={reload} />;

  return (
    <Page className="campaign-page">
      <header className="cp-head">
        <p className="eyebrow mono">
          <b>Founders</b> · {campaign.concept.genre}
        </p>
        <h1 className="cp-title" ref={titleRef} tabIndex={-1}>
          {campaign.title}
        </h1>
        <p className="cp-business">
          <span className="cp-name">{campaign.name}</span>
          <span className="cp-where">
            {campaign.place.label}
            <span className="cp-area mono">{campaign.place.area}</span>
          </span>
        </p>
      </header>
      {campaign.is_owner ? <OwnerPanel campaign={campaign} onCampaign={replace} /> : null}
      {campaign.is_owner ? <CampaignPosterButton campaign={campaign} /> : null}
      <div className="cp-body">
        <aside className="cp-side">
          <PledgeCard
            campaign={campaign}
            now={now}
            held={held}
            back={back}
            said={said}
            news={news}
            onHeld={(orderId, progress, receipt) => {
              const pledge = { orderId, at: new Date().toISOString(), ...(receipt ? { receipt } : {}) };
              keepPledge(id, pledge);
              setHeld(pledge);
              setSaid(null);
              setBack(null);
              setProgress(progress);
            }}
            onWithdrawn={(progress) => {
              keepPledge(id, null);
              setHeld(null);
              setSaid("withdrawn");
              setProgress(progress);
            }}
            onProgress={setProgress}
            onClosed={reload}
          />
        </aside>
        <Story campaign={campaign} />
      </div>
    </Page>
  );
}
