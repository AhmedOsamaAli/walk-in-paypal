import "../styles/founders.css";
import { useRef, useState, type SyntheticEvent } from "react";
import { api } from "../api/client";
import { BUSINESS_KINDS, paypalOf, type BusinessDescription, type BusinessKind } from "../api/founders";
import type { GeocodeResult } from "../api/types";
import { Page, PageHead, useDocumentTitle, useFocusOnMount } from "../components/Page";
import { SignInOptions } from "../components/SignIn";
import { CampaignForm } from "../components/founders/CampaignForm";
import { plainError } from "../lib/account";
import { inSandbox } from "../lib/founders";
import { useSession } from "../state/session";

export function StartCampaignPage() {
  const { phase, user, config } = useSession();
  const titleRef = useFocusOnMount();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BusinessKind>("cafe");
  const [description, setDescription] = useState("");
  const [why, setWhy] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GeocodeResult[]>([]);
  const [selected, setSelected] = useState<GeocodeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [business, setBusiness] = useState<BusinessDescription | null>(null);
  const search = useRef(0);
  useDocumentTitle("Start a Founders campaign");
  const paypal = paypalOf(config);

  async function findAddress() {
    const request = ++search.current;
    setError(null);
    setBusy(true);
    try {
      const results = await api.geocode(query.trim());
      if (search.current !== request) return;
      setMatches(results);
      if (!results.length) setError("No matching address was found. Try the street, city and country.");
    } catch (failure) {
      if (search.current === request) setError(plainError(failure, "The address search could not finish. Try again."));
    } finally {
      if (search.current === request) setBusy(false);
    }
  }

  function continueToTerms(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.label) {
      setError("Find and select the business's address first.");
      return;
    }
    setError(null);
    setBusiness({
      name: name.trim(), kind, description: description.trim(), why_here: why.trim(),
      address: selected.label, lat: selected.lat, lon: selected.lon,
    });
  }

  return (
    <Page>
      <PageHead eyebrow="Founders your business" title="Opening something? Let the neighbors back it."
        titleRef={titleRef} standfirst="Start with your own business, not a survey. Describe it, set the terms and share a campaign your neighbors can back with PayPal." />
      <section className="pg-sec start-campaign" aria-label="Start your campaign">
        {phase === "loading" ? <p role="status">Checking your sign-in...</p> : !user ? (
          <div className="prompt-card">
            <h2 className="cp-action-title">Sign in to be the campaign's owner</h2>
            <p>You choose the terms and publish. Backing a campaign never needs a Walk-in account.</p>
            <SignInOptions />
          </div>
        ) : paypal?.enabled === false ? (
          <p className="cp-off">Campaigns cannot take pledges here because PayPal is not configured.</p>
        ) : business ? (
          <>
            <div className="cp-said">
              <b>{business.name}</b> · {business.address}
              <p>{business.description}</p>
              <p>Your description is not survey-verified evidence. AI may help write it, but cannot prove local demand.</p>
              <button type="button" className="text-button" onClick={() => { setBusiness(null); }}>
                Change the business details and start a fresh draft
              </button>
            </div>
            <CampaignForm business={business} name={business.name} email={user.email} sandbox={inSandbox(paypal)} />
          </>
        ) : (
          <form onSubmit={continueToTerms} className="business-form">
            <div className="cf-field">
              <label className="mono label" htmlFor="business-name">Business name</label>
              <input id="business-name" className="field-input" value={name} onChange={(e) => { setName(e.target.value); }} required minLength={2} maxLength={60} />
            </div>
            <div className="cf-field">
              <label className="mono label" htmlFor="business-kind">Business kind</label>
              <select id="business-kind" className="field-input" value={kind} onChange={(e) => {
                const found = BUSINESS_KINDS.find((value) => value === e.target.value);
                if (found) setKind(found);
              }}>
                {BUSINESS_KINDS.map((value) => <option key={value} value={value}>{value[0]?.toUpperCase()}{value.slice(1)}</option>)}
              </select>
            </div>
            <div className="cf-field cf-wide">
              <label className="mono label" htmlFor="business-description">What are you opening?</label>
              <textarea id="business-description" className="field-input cf-textarea" rows={3} value={description}
                onChange={(e) => { setDescription(e.target.value); }} required minLength={8} maxLength={500} />
            </div>
            <div className="cf-field cf-wide">
              <label className="mono label" htmlFor="business-why">Why here? (optional, in your own words)</label>
              <textarea id="business-why" className="field-input cf-textarea" rows={2} value={why}
                onChange={(e) => { setWhy(e.target.value); }} maxLength={300} />
            </div>
            <div className="cf-field cf-wide">
              <label className="mono label" htmlFor="business-address">Business address</label>
              <input id="business-address" className="field-input" value={query} minLength={3} maxLength={250} required
                onChange={(e) => { ++search.current; setQuery(e.target.value); setSelected(null); setMatches([]); setBusy(false); }} />
              <button type="button" className="ghost mono" disabled={busy || query.trim().length < 3}
                onClick={() => { void findAddress(); }}>{busy ? "Finding..." : "Find address"}</button>
              {matches.length ? <ul className="business-addresses" aria-label="Matching addresses">
                {matches.map((match, index) => <li key={`${match.lat}:${match.lon}:${index}`}>
                  <button type="button" className="text-button" aria-pressed={selected === match} onClick={() => { setSelected(match); }}>
                    {selected === match ? "Selected: " : ""}{match.label}
                  </button>
                </li>)}
              </ul> : null}
            </div>
            {error ? <p className="page-alert cf-wide" role="alert">{error}</p> : null}
            <button type="submit" className="go cf-wide">Set the campaign terms</button>
          </form>
        )}
      </section>
    </Page>
  );
}
