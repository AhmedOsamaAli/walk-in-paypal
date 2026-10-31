import { useEffect, useState } from "react";
import { kits } from "../api/kit";
import type { LaunchPlan } from "../api/types";
import { naturalList } from "../lib/format";
import { CHANNEL_NAMES, kitChannels, kitError } from "../lib/kit";
import { useNavigate } from "../lib/navigation";
import { kitUrl } from "../lib/routes";
import { Link } from "./Link";

const COUNTS = ["no", "one", "two", "three", "four", "five"];

interface KitOfferProps {
  runId: string;
  index: number;
  /** The business's name on the sheet. */
  name: string;
  plan: LaunchPlan | null | undefined;
}

/** What the kit holds, said exactly: the copy follows the channels of this concept's launch plan, and the poster. Each
 * item is one element, so the list's number column never takes a run of its text. */
function Contents({ plan }: { plan: LaunchPlan | null | undefined }) {
  const channels = kitChannels(plan);
  const count = COUNTS[channels.length] ?? String(channels.length);
  return (
    <ol className="kit-contents">
      <li>
        <span>
          <b>
            Ad copy for {count} {channels.length === 1 ? "channel" : "channels"}
          </b>
          : {naturalList(channels.map((key) => CHANNEL_NAMES[key]))}, every line checked against the evidence and ready to
          paste.
        </span>
      </li>
      <li>
        <span>
          <b>The window poster</b>, designed around this business and its offer, ready to print. Add your own link for a QR
          code; a small street locator is optional.
        </span>
      </li>
      <li>
        <span>
          <b>Tracked links</b> to your own page, one per channel, so you can see which one brings people in.
        </span>
      </li>
      <li>
        <span>
          <b>A report of up to twelve sections</b> for a landlord or a lender: the case, the competition, the offer, the
          first 90 days and what to ask before you sign. Save it as a PDF.
        </span>
      </li>
    </ol>
  );
}

/** Whether the concept has a kit, once the server has said: its address, or null for none. */
interface Found {
  key: string;
  url: string | null;
}

function useStartKit(runId: string, index: number) {
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function make() {
    setMaking(true);
    setError(null);
    try {
      const made = await kits.make(runId, index);
      navigate(kitUrl(made.token));
    } catch (failure) {
      setMaking(false);
      setError(kitError(failure, "The kit could not be started. Try again in a moment."));
    }
  }
  return { making, error, make };
}

export function KitShortcut({ runId, index, name }: Omit<KitOfferProps, "plan">) {
  const { making, error, make } = useStartKit(runId, index);
  return <div className="kit-shortcut" onClick={(event) => { event.stopPropagation(); }}>
    <button type="button" className="ink-button" aria-label={`Open or make the free launch kit for ${name}`}
      aria-busy={making} aria-disabled={making} onClick={() => { if (!making) void make(); }}>
      {making ? "Opening the kit…" : "Free launch kit"} <span aria-hidden="true">→</span>
    </button>
    <p role="status">{error ?? (making ? "Preparing the business's kit; an existing kit is reused." : "Poster, ad copy and report.")}</p>
  </div>;
}

/** The launch kit for one concept: what is inside, and a button that makes it, or opens the one it already has. */
export function KitOffer({ runId, index, name, plan }: KitOfferProps) {
  const key = `${runId}:${index}`;
  const [found, setFound] = useState<Found | null>(null);
  const { making, error, make } = useStartKit(runId, index);

  useEffect(() => {
    const abort = new AbortController();
    kits.find(runId, index, abort.signal).then(
      ({ kit_url }) => {
        setFound({ key, url: kit_url });
      },
      () => {
        // Not knowing offers to make it: making it again returns the kit it already has.
        if (!abort.signal.aborted) setFound({ key, url: null });
      },
    );
    return () => {
      abort.abort();
    };
  }, [key, runId, index]);

  const known = found?.key === key ? found : null;
  const titleId = `kit-offer-${index}`;

  return (
    <section className="kit-offer" aria-labelledby={titleId}>
      <header className="kit-offer-head">
        <p className="kit-offer-eyebrow mono">Launch kit · {name}</p>
        <h4 className="kit-offer-title" id={titleId}>
          Everything to open with, written from this evidence
        </h4>
      </header>
      <Contents plan={plan} />
      <div className="kit-offer-body" aria-busy={known === null}>
        {known === null ? (
          <div className="sk sk-pill kit-offer-wait" aria-hidden="true" />
        ) : known.url ? (
          <div className="kit-owned">
            <p>This concept has its launch kit.</p>
            <Link className="ink-button" href={known.url}>
              Open the launch kit <span aria-hidden="true">→</span>
            </Link>
          </div>
        ) : (
          <button
            type="button"
            className="ink-button kit-make"
            aria-disabled={making}
            aria-busy={making}
            onClick={() => {
              // Not disabled while it starts: a disabled button drops the keyboard's focus, and the 429 note follows.
              if (!making) void make();
            }}
          >
            {making ? "Starting the kit…" : "Make the launch kit"}
            {making ? null : <span aria-hidden="true">→</span>}
          </button>
        )}
      </div>
      <p className="kit-offer-note" role="status" aria-live="polite">
        {error ?? ""}
      </p>
      <p className="kit-offer-fine mono">
        {/* How long it takes is news only while there is a kit still to make. */}
        {known !== null && known.url === null
          ? "Free · Ready in about a minute · Anyone with the kit's link can open it"
          : "Free · Anyone with the kit's link can open it"}
      </p>
    </section>
  );
}
