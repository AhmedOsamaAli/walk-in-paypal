import "../styles/founders.css";
import { useEffect, useState } from "react";
import { founders, paypalOf, type CampaignCard, type Near } from "../api/founders";
import { ProgressBar } from "../components/founders/ProgressBar";
import { SandboxNotice } from "../components/founders/SandboxNotice";
import { Link } from "../components/Link";
import { Page, PageHead, useDocumentTitle, useFocusOnMount } from "../components/Page";
import { SectionHead } from "../components/SectionHead";
import { plainError } from "../lib/account";
import { cssVars } from "../lib/css";
import { heldText, inSandbox, moneyText, timeLeft } from "../lib/founders";
import { useNow } from "../lib/useNow";
import { EXAMPLES_URL, PLACES_URL } from "../lib/routes";
import { useSession } from "../state/session";

type ListLoad = { state: "loading" } | { state: "shown"; campaigns: CampaignCard[] } | { state: "failed"; message: string };

/** Where the list is read from: the newest first, or the nearest to where the reader is, once they asked. */
type Order = { by: "newest" } | { by: "nearest"; near: Near };

/** Asking the browser where the reader is: only when they press the button. */
type Locate = "idle" | "asking" | "refused";

const NEAR_KM = 25;

/** "2.4 km away", "180 m away". */
function distanceText(km: number): string {
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m away` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km away`;
}

/** One open campaign: what it is, where, how far along, and its link over the whole card. */
function Card({ campaign, now, index }: { campaign: CampaignCard; now: number; index: number }) {
  const left = timeLeft(campaign.deadline, now);
  const funded = campaign.supporters >= campaign.goal;
  const where = [campaign.place.label, campaign.distance_km === null ? null : distanceText(campaign.distance_km)].filter(Boolean);
  return (
    <li style={cssVars({ "--i": index })}>
      <article className="fd-card">
        <p className="fd-card-kicker mono">{where.join(" · ")}</p>
        <h2 className="fd-card-title">
          <Link className="fd-card-link" href={campaign.url}>
            {campaign.title}
          </Link>
        </h2>
        <p className="fd-card-name">{campaign.name}</p>
        <div className="fd-card-progress">
          <p className="fd-card-count">
            <b>{campaign.supporters}</b> of {campaign.goal} neighbors
            <span className="fd-card-held"> · {heldText("open", campaign.total)}</span>
          </p>
          <ProgressBar
            supporters={campaign.supporters}
            goal={campaign.goal}
            funded={funded}
            label={`Neighbors backing ${campaign.name}`}
          />
        </div>
        <p className="fd-card-foot">
          <span className="fd-card-amount mono">Pledge {moneyText(campaign.amount)}</span>
          <span className="fd-card-left mono">{left.closed ? "Closing" : left.text}</span>
        </p>
      </article>
    </li>
  );
}

/** The open campaigns, the newest first; the nearest first once the reader asks. */
function OpenCampaigns() {
  const now = useNow(60_000);
  const [order, setOrder] = useState<Order>({ by: "newest" });
  const [locate, setLocate] = useState<Locate>("idle");
  const [attempt, setAttempt] = useState(0);
  const key = `${order.by === "nearest" ? `${order.near.lat},${order.near.lon}` : "newest"}:${attempt}`;
  const [load, setLoad] = useState<{ key: string; load: ListLoad }>({ key, load: { state: "loading" } });
  const near = order.by === "nearest" ? order.near : null;

  useEffect(() => {
    const abort = new AbortController();
    founders.list(near, abort.signal).then(
      ({ campaigns }) => {
        setLoad({ key, load: { state: "shown", campaigns } });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setLoad({ key, load: { state: "failed", message: plainError(error, "The campaigns could not be loaded.") } });
      },
    );
    return () => {
      abort.abort();
    };
  }, [key, near]);

  const shown = load.key === key ? load.load : ({ state: "loading" } as const);

  function nearest() {
    if (!("geolocation" in navigator)) {
      setLocate("refused");
      return;
    }
    setLocate("asking");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocate("idle");
        setOrder({ by: "nearest", near: { lat: coords.latitude, lon: coords.longitude, km: NEAR_KM } });
      },
      () => {
        setLocate("refused");
      },
      { maximumAge: 600_000, timeout: 15_000 },
    );
  }

  const campaigns = shown.state === "shown" ? shown.campaigns : [];
  let note: string;
  if (order.by === "nearest") note = `Open campaigns within ${NEAR_KM} km of you, the nearest first.`;
  else if (shown.state === "shown" && campaigns.length) note = `${campaigns.length === 1 ? "One campaign" : `${campaigns.length} campaigns`} taking pledges, the newest first.`;
  else note = "Businesses their neighbors can back now, the newest first.";

  return (
    <section className="pg-sec" aria-labelledby="fd-open" aria-busy={shown.state === "loading"}>
      <SectionHead id="fd-open" no="01" title="Open campaigns" note={note} />
      <div className="fd-order">
        {order.by === "nearest" ? (
          <button
            type="button"
            className="ghost mono"
            onClick={() => {
              setOrder({ by: "newest" });
            }}
          >
            Show the newest instead
          </button>
        ) : (
          <button type="button" className="ghost mono" aria-busy={locate === "asking"} disabled={locate === "asking"} onClick={nearest}>
            {locate === "asking" ? "Finding you…" : "Show the nearest to me"}
          </button>
        )}
        <p className="fd-order-note" role="status">
          {locate === "refused"
            ? "Your browser didn't share where you are, so these are the newest."
            : order.by === "newest"
              ? "Your location is asked for only if you press this, and only to sort the list."
              : ""}
        </p>
      </div>
      {shown.state === "loading" ? (
        <div className="fd-wait" aria-hidden="true">
          <div className="sk" />
          <div className="sk" />
          <div className="sk" />
        </div>
      ) : null}
      {shown.state === "failed" ? (
        <p className="page-alert" role="alert">
          {shown.message}{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      {shown.state === "shown" ? (
        campaigns.length ? (
          <ol className="fd-list">
            {campaigns.map((campaign, index) => (
              <Card key={campaign.id} campaign={campaign} now={now} index={index} />
            ))}
          </ol>
        ) : (
          <div className="places-empty">
            <p>{order.by === "nearest" ? `No open campaigns within ${NEAR_KM} km of you yet.` : "No open campaigns yet."}</p>
            <a className="text-link" href="#fd-start">
              Start one from a launch kit <span aria-hidden="true">→</span>
            </a>
          </div>
        )
      ) : null}
    </section>
  );
}

/** How an owner starts one: any ready launch kit, the finished examples' included. */
function StartOne() {
  const { user } = useSession();
  return (
    <section className="pg-sec fd-start" aria-labelledby="fd-start">
      <SectionHead
        id="fd-start"
        no="02"
        title="Start one from a launch kit"
        note="Any ready launch kit can be the basis: yours from My places, or one of the finished examples."
      />
      <ol className="fd-steps">
        <li>
          <b>Open a launch kit</b>
          <span>Its Founders tab starts a campaign for the business it was made for. Signing in with Google comes first.</span>
        </li>
        <li>
          <b>Set your terms</b>
          <span>The pledge, how many neighbors you need, the deadline (at most 27 days away), a perk if you offer one and your PayPal email.</span>
        </li>
        <li>
          <b>Let AI write the page</b>
          <span>It drafts the words from the survey&apos;s evidence. You edit them, and every line is checked again before it is published.</span>
        </li>
        <li>
          <b>Share it and print the poster</b>
          <span>The kit&apos;s window poster carries a QR code to your campaign, with its terms in plain words.</span>
        </li>
      </ol>
      <div className="fd-start-go">
        <Link className="go" href="/founders/start">Opening your own business? Start without a survey</Link>
        <Link className="go" href={EXAMPLES_URL}>
          <span>Open a launch kit from the examples</span>
          <i aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 12h15M13 6l6 6-6 6" />
            </svg>
          </i>
        </Link>
        {user ? (
          <Link className="text-link" href={PLACES_URL}>
            Or one of your own, in My places <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** Founders: the campaigns neighbors can back now, and how an owner starts one. */
export function FoundersPage() {
  const titleRef = useFocusOnMount();
  const { config } = useSession();
  const paypal = paypalOf(config);
  useDocumentTitle("Founders");
  return (
    <Page className="founders-page">
      <PageHead
        eyebrow="Founders · Back it before it opens"
        title="Back a business before it opens"
        titleRef={titleRef}
        standfirst="Neighbors pledge with PayPal before the lease is signed. PayPal only holds each pledge: if enough people join by the deadline, everyone is charged and the money goes to the owner; if not, every hold is released and nobody pays."
      />
      {!paypal || (paypal.enabled && inSandbox(paypal)) ? (
        <div className="fd-sandbox">
          <SandboxNotice />
        </div>
      ) : null}
      <OpenCampaigns />
      <StartOne />
    </Page>
  );
}
