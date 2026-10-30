import { use, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { canRetry, founders, type Campaign, type CampaignProgress, type PayPalConfig } from "../../api/founders";
import { plainError } from "../../lib/account";
import { cx } from "../../lib/css";
import { moneyText } from "../../lib/founders";
import { payPalSdk, type PayPalSession } from "../../lib/paypalSdk";
import { ThemeContext } from "../../state/theme";

/** What a pledge came to, said under the button. */
type Note = { tone: "info" | "error"; text: string } | null;

interface PayPalPledgeProps {
  campaign: Campaign;
  paypal: PayPalConfig;
  /** PayPal holds the pledge: its order id, which withdrawing it needs, and the count with it. */
  onHeld: (orderId: string, progress: CampaignProgress, receipt?: string) => void;
  /** The count moved without a hold. */
  onProgress: (progress: CampaignProgress) => void;
  /** The campaign stopped taking pledges meanwhile: the page reads it again. */
  onClosed: () => void;
}

const CLOSED = "This campaign no longer takes pledges, so nothing was held.";

/**
 * "Pledge with PayPal": PayPal's own button from its JS SDK v6. A click asks the server for the AUTHORIZE order while
 * PayPal opens (a popup, or its modal where popups are blocked); once the supporter approves, the server places the
 * hold. When PayPal declines the way they paid (402 with `retry`), the next click reopens the same order to choose
 * another.
 */
export function PayPalPledge({ campaign, paypal, onHeld, onProgress, onClosed }: PayPalPledgeProps) {
  const theme = use(ThemeContext);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<(HTMLElement & { disabled?: boolean }) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sdk, setSdk] = useState<{ attempt: number; state: "ready" | "failed" } | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [holding, setHolding] = useState(false);
  // The SDK's callbacks are set once; they read the page's latest props from here.
  const latest = useRef({ id: campaign.id, onHeld, onProgress, onClosed });
  useEffect(() => {
    latest.current = { id: campaign.id, onHeld, onProgress, onClosed };
  });
  const { client_id: clientId, environment, currency } = paypal;
  const state = sdk?.attempt === attempt ? sdk.state : "loading";

  useEffect(() => {
    const element = box.current;
    let live = true;
    let session: PayPalSession | null = null;
    // The order whose way to pay PayPal declined: the next click reopens it.
    let retry: string | null = null;
    let receipt: string | undefined;
    // A failure already said here, which PayPal's own error after it must not repeat.
    let explained = false;
    let holdingNow = false;

    async function approve(orderId: string): Promise<void> {
      explained = true;
      holdingNow = true;
      setHolding(true);
      setNote({ tone: "info", text: "Placing the hold with PayPal…" });
      try {
        const result = await founders.authorize(latest.current.id, orderId);
        if (result.status === "authorized") {
          setNote(null);
          latest.current.onHeld(orderId, result.progress, receipt);
        } else {
          latest.current.onProgress(result.progress);
          setNote({ tone: "error", text: "PayPal declined the pledge, so nothing is held. Try again, or pay another way." });
        }
      } catch (error) {
        if (canRetry(error)) {
          retry = orderId;
          setNote({
            tone: "error",
            text: `${plainError(error, "PayPal declined that way to pay.")} Nothing is held: press the PayPal button again to choose another.`,
          });
        } else if (error instanceof ApiError && error.status === 409) {
          setNote({ tone: "error", text: plainError(error, CLOSED) });
          latest.current.onClosed();
        } else {
          setNote({ tone: "error", text: plainError(error, "PayPal could not place the hold, so nothing is held. Try again.") });
        }
      } finally {
        holdingNow = false;
        setHolding(false);
      }
    }

    /** The order PayPal opens: the declined one again, or a new one the server creates as PayPal opens. */
    function order(): Promise<{ orderId: string }> {
      const again = retry;
      retry = null;
      if (again) return Promise.resolve({ orderId: again });
      return founders.pledge(latest.current.id).then(
        (started) => {
          receipt = started.receipt;
          return { orderId: started.order_id };
        },
        (error: unknown) => {
          explained = true;
          if (error instanceof ApiError && error.status === 409) {
            setNote({ tone: "error", text: plainError(error, CLOSED) });
            latest.current.onClosed();
          } else setNote({ tone: "error", text: plainError(error, "The pledge could not be started, so nothing is held. Try again.") });
          throw error;
        },
      );
    }

    function start(): void {
      if (!session || holdingNow) return;
      explained = false;
      setNote(null);
      // Started in the click itself, so the browser lets PayPal open its window.
      session.start({ presentationMode: "auto" }, order()).catch(() => {
        if (!explained && live) setNote({ tone: "error", text: "PayPal could not open, so nothing is held. Try again." });
      });
    }

    const config: PayPalConfig = { enabled: true, client_id: clientId, environment, currency };
    payPalSdk(config)
      .then(async (instance) => {
        try {
          await instance.findEligibleMethods({ currencyCode: currency });
        } catch {
          // Eligibility only narrows the ways to pay: the PayPal button is offered either way.
        }
        if (!live || !element) return;
        session = instance.createPayPalOneTimePaymentSession({
          onApprove: (data) => approve(data.orderId),
          onCancel: () => {
            if (live) setNote({ tone: "info", text: "You left PayPal before approving, so nothing is held." });
          },
          onError: () => {
            if (live && !explained) setNote({ tone: "error", text: "PayPal could not finish, so nothing is held. Try again." });
          },
        });
        const tag = document.createElement("paypal-button");
        tag.addEventListener("click", start);
        element.replaceChildren(tag);
        button.current = tag;
        setSdk({ attempt, state: "ready" });
      })
      .catch(() => {
        if (live) setSdk({ attempt, state: "failed" });
      });

    return () => {
      live = false;
      session?.destroy();
      button.current = null;
      element?.replaceChildren();
    };
  }, [clientId, environment, currency, attempt]);

  // PayPal's colors for the theme: gold on paper, white on blueprint film.
  useEffect(() => {
    button.current?.setAttribute("class", theme === "dark" ? "paypal-white" : "paypal-gold");
  }, [theme, state]);

  useEffect(() => {
    if (button.current) button.current.disabled = holding;
  }, [holding, state]);

  const amount = moneyText(campaign.amount, campaign.currency);
  return (
    <div className="pp-pay" aria-busy={state === "loading" || holding}>
      {state === "loading" ? <div className="sk pp-wait" aria-hidden="true" /> : null}
      {state === "failed" ? (
        <p className="pay-note" data-tone="error" role="alert">
          PayPal could not load. Check your connection, or allow paypal.com if a blocker stops it.{" "}
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
      <div
        ref={box}
        className={cx("pp-buttons", holding && "holding")}
        role="group"
        aria-label={`Pledge ${amount} to ${campaign.name} with PayPal`}
        hidden={state !== "ready"}
      />
      <p className="pay-note" data-tone={note?.tone} role="status" aria-live="polite">
        {note?.text ?? ""}
      </p>
    </div>
  );
}
