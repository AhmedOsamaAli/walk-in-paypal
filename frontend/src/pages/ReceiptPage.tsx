import "../styles/founders.css";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { founders, paypalOf, type PledgeReceipt } from "../api/founders";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Link } from "../components/Link";
import { Page, PageHead, useDocumentTitle, useFocusOnMount } from "../components/Page";
import { SandboxNotice } from "../components/founders/SandboxNotice";
import { plainError } from "../lib/account";
import { dayText, inSandbox, moneyText } from "../lib/founders";
import { campaignUrl } from "../lib/routes";
import { useSession } from "../state/session";

type Load = { phase: "loading" } | { phase: "ready"; receipt: PledgeReceipt } | { phase: "failed"; message: string };

export function ReceiptPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useFocusOnMount();
  const { config } = useSession();
  useDocumentTitle("Your private pledge receipt");

  useEffect(() => {
    const abort = new AbortController();
    founders.receipt(token, abort.signal).then(
      (receipt) => { setLoad({ phase: "ready", receipt }); },
      (failure: unknown) => {
        if (abort.signal.aborted) return;
        const message = failure instanceof ApiError && failure.status === 404
          ? "This receipt was not found. Check that you copied the whole link."
          : plainError(failure, "Your receipt could not be loaded. Try again.");
        setLoad({ phase: "failed", message });
      },
    );
    return () => { abort.abort(); };
  }, [token, attempt]);

  async function withdraw() {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      setLoad({ phase: "ready", receipt: await founders.withdrawReceipt(token) });
    } catch (failure) {
      setError(plainError(failure, "The pledge could not be withdrawn. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const receipt = load.phase === "ready" ? load.receipt : null;
  return (
    <Page>
      <PageHead eyebrow="Founders private receipt" title={receipt?.state ?? "Your pledge receipt"} titleRef={titleRef}
        standfirst="This link is the key to your pledge. Keep it private: anyone with it can follow or withdraw the pledge." />
      <section className="pg-sec receipt-page" aria-busy={load.phase === "loading" || busy} aria-label="Your pledge">
        {load.phase === "loading" ? <p role="status">Reading your receipt...</p> : null}
        {load.phase === "failed" ? <p className="page-alert" role="alert">{load.message}</p> : null}
        {receipt ? (
          <>
            <h2 className="cp-action-title">{receipt.campaign.name || receipt.campaign.title}</h2>
            <p className="cp-terms" role="status">{receipt.explanation}</p>
            <dl className="cp-facts">
              <div><dt className="mono">Your pledge</dt><dd>{moneyText(receipt.amount, receipt.currency)}</dd></div>
              <div><dt className="mono">Neighbors</dt><dd>{receipt.campaign.progress.supporters} of {receipt.campaign.goal}</dd></div>
              <div><dt className="mono">Deadline</dt><dd>{dayText(receipt.campaign.deadline)}</dd></div>
              <div><dt className="mono">Place</dt><dd>{receipt.campaign.place.label}</dd></div>
            </dl>
            <Link className="text-link" href={campaignUrl(receipt.campaign.id)} rel="noreferrer">Open the campaign</Link>
            {receipt.withdrawable ? (
              <button type="button" className="ghost mono" disabled={busy} onClick={() => { setAsking(true); }}>
                {busy ? "Withdrawing..." : "Withdraw my pledge"}
              </button>
            ) : null}
          </>
        ) : null}
        {inSandbox(paypalOf(config)) ? <SandboxNotice /> : null}
        {error ? <p className="pay-note" data-tone="error" role="alert">{error}</p> : null}
        <button type="button" className="text-button" disabled={busy} onClick={() => { setAttempt((value) => value + 1); }}>
          Check again
        </button>
      </section>
      <ConfirmDialog open={asking} title="Withdraw your pledge?" confirm="Withdraw my pledge" cancel="Keep my pledge" danger
        onConfirm={() => { void withdraw(); }} onCancel={() => { setAsking(false); }}>
        <p>PayPal releases any hold on your pledge. Nothing is charged. You can pledge again while the campaign is open.</p>
        {inSandbox(paypalOf(config)) ? <SandboxNotice /> : null}
      </ConfirmDialog>
    </Page>
  );
}
