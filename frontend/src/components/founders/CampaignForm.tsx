import { useId, useState, type ReactNode, type SyntheticEvent } from "react";
import { ApiError } from "../../api/client";
import { conflictUrl, founders, problemsOf, type BusinessDescription } from "../../api/founders";
import { plainError } from "../../lib/account";
import { cx } from "../../lib/css";
import {
  cleanWords,
  deadlineRange,
  defaultDeadline,
  LIMITS,
  moneyTermsOf,
  pledgeTerms,
  termsProblems,
  wordsProblems,
  type TermsField,
  type TermsForm,
  type Words,
} from "../../lib/founders";
import { useNavigate } from "../../lib/navigation";
import { useNow } from "../../lib/useNow";
import { session } from "../../state/session";
import { Link } from "../Link";
import { SandboxNotice } from "./SandboxNotice";

interface Draft extends Words {
  howItWorks: string;
  /** The terms it was written for, to say when they changed since. */
  terms: string;
}

interface CampaignFormBase {
  /** The business, as the kit names it. */
  name: string;
  /** The signed-in owner's email, the payout email's first guess. */
  email: string;
  sandbox: boolean;
}
type CampaignFormProps = CampaignFormBase & (
  | { token: string; business?: never }
  | { business: BusinessDescription; token?: never }
);

function Counter({ text, max }: { text: string; max: number }) {
  const length = text.trim().length;
  return (
    <span className={cx("cf-counter mono", length > max && "over")} aria-hidden="true">
      {length}/{max}
    </span>
  );
}

interface FieldProps {
  id: string;
  label: string;
  /** "optional", set after the label. */
  aside?: string;
  hint: string;
  problem: string | null;
  className?: string;
  children: (describedBy: string, invalid: boolean) => ReactNode;
}

/** A labelled term with its hint, which turns into the problem once there is one to show. */
function Field({ id, label, aside, hint, problem, className, children }: FieldProps) {
  return (
    <div className={cx("cf-field", className)}>
      <label className="mono label" htmlFor={id}>
        {label}
        {aside ? <span className="muted">{aside}</span> : null}
      </label>
      {children(`${id}-hint`, problem !== null)}
      <span className={cx("cf-hint", problem && "bad")} id={`${id}-hint`}>
        {problem ?? hint}
      </span>
    </div>
  );
}

/**
 * Starting a campaign: the owner's money terms (theirs alone), then words AI drafts from the kit's evidence, which the
 * owner edits, then publishing; the server checks the terms and every edited line again.
 */
export function CampaignForm({ token, business, name, email, sandbox }: CampaignFormProps) {
  const navigate = useNavigate();
  const ids = useId();
  const now = useNow(60_000);
  const [first] = useState(() => defaultDeadline(Date.now()));
  const range = deadlineRange(now);
  const [form, setForm] = useState<TermsForm>({
    amount: "25",
    goal: "40",
    date: first.date,
    time: first.time,
    perk: "",
    email,
  });
  const [touched, setTouched] = useState<Partial<Record<TermsField, boolean>>>({});
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"drafting" | "publishing" | null>(null);
  const [problems, setProblems] = useState<{ when: "draft" | "publish"; lines: string[] } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const termProblems = termsProblems(form, now);
  const shown = (field: TermsField) => (tried || touched[field] ? termProblems[field] : null);
  const terms = moneyTermsOf(form, now);
  const termsKey = JSON.stringify(terms ? [terms.amount, terms.goal, terms.deadline, terms.perk, business ?? token] : null);
  const stale = draft !== null && draft.terms !== termsKey;

  function patch(field: keyof TermsForm, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  function touch(field: TermsField) {
    setTouched((previous) => (previous[field] ? previous : { ...previous, [field]: true }));
  }

  function fail(error: unknown, when: "draft" | "publish", fallback: string) {
    if (error instanceof ApiError && error.status === 401) void session.refresh();
    const url = conflictUrl(error);
    if (url) {
      setConflict(url);
      setProblems(null);
      return;
    }
    const listed = error instanceof ApiError && error.status === 422 ? problemsOf(error) : [];
    setProblems({ when, lines: listed.length ? listed : [plainError(error, fallback)] });
  }

  async function writeDraft(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setConflict(null);
    const asked = terms;
    if (!asked) {
      setProblems({ when: "draft", lines: Object.values(termProblems).filter((line): line is string => line !== null) });
      return;
    }
    setBusy("drafting");
    setProblems(null);
    try {
      const written = business ? await founders.draftBusiness({ ...asked, ...business }) :
        await founders.draft({ ...asked, kit_token: token });
      if (written.problems.length) setProblems({ when: "draft", lines: written.problems });
      else {
        setDraft({
          title: written.title,
          pitch: written.pitch,
          perks: written.perks.slice(0, LIMITS.perks),
          howItWorks: written.how_it_works,
          terms: termsKey,
        });
      }
    } catch (error) {
      fail(error, "draft", "The draft could not be written. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!draft) return;
    setTried(true);
    setConflict(null);
    const words = cleanWords(draft);
    const wrong = [...Object.values(termProblems).filter((line): line is string => line !== null), ...wordsProblems(words)];
    if (!terms || wrong.length) {
      setProblems({ when: "publish", lines: wrong });
      return;
    }
    setBusy("publishing");
    setProblems(null);
    try {
      const payload = { ...terms, payout_email: form.email.trim(), ...words };
      const { url } = business ? await founders.publishBusiness({ ...payload, ...business }) :
        await founders.publish({ ...payload, kit_token: token });
      navigate(url);
    } catch (error) {
      fail(error, "publish", "The campaign could not be published. Try again.");
      setBusy(null);
    }
  }

  function patchDraft(next: Partial<Draft>) {
    setDraft((previous) => (previous ? { ...previous, ...next } : previous));
  }

  const preview = terms ? pledgeTerms(terms.amount, terms.goal, terms.deadline) : null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="campaign-form">
      <form className="cf-terms" onSubmit={(event) => void writeDraft(event)} noValidate aria-labelledby={`${ids}-terms`}>
        <h3 className="cf-step" id={`${ids}-terms`}>
          <span className="mono">Step 1</span> Your terms
        </h3>
        <fieldset className="cf-grid" disabled={busy !== null}>
          <legend className="sr-only">The money terms, which only you set</legend>
          <Field
            id={`${ids}-amount`}
            label="Each neighbor pledges"
            hint={`$${LIMITS.minAmount} to $${LIMITS.maxAmount}, the same for everyone.`}
            problem={shown("amount")}
          >
            {(describedBy, invalid) => (
              <span className="cf-money">
                <span className="cf-currency mono" aria-hidden="true">
                  $
                </span>
                <input
                  id={`${ids}-amount`}
                  className="field-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.amount}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    patch("amount", event.target.value);
                  }}
                  onBlur={() => {
                    touch("amount");
                  }}
                />
              </span>
            )}
          </Field>
          <Field
            id={`${ids}-goal`}
            label="Neighbors needed"
            hint={`${LIMITS.minGoal} to ${LIMITS.maxGoal}. Nobody is charged unless this many join.`}
            problem={shown("goal")}
          >
            {(describedBy, invalid) => (
              <input
                id={`${ids}-goal`}
                className="field-input"
                type="number"
                min={LIMITS.minGoal}
                max={LIMITS.maxGoal}
                step={1}
                inputMode="numeric"
                value={form.goal}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(event) => {
                  patch("goal", event.target.value);
                }}
                onBlur={() => {
                  touch("goal");
                }}
              />
            )}
          </Field>
          <Field
            id={`${ids}-date`}
            label="Deadline"
            hint={`${LIMITS.minDays} to ${LIMITS.maxDays} days away, in your time zone (${zone}). PayPal holds a pledge for 29 days.`}
            problem={shown("deadline")}
            className="cf-deadline"
          >
            {(describedBy, invalid) => (
              <span className="cf-when">
                <input
                  id={`${ids}-date`}
                  className="field-input"
                  type="date"
                  min={range.min}
                  max={range.max}
                  value={form.date}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    patch("date", event.target.value);
                  }}
                  onBlur={() => {
                    touch("deadline");
                  }}
                />
                <input
                  className="field-input"
                  type="time"
                  aria-label="Deadline time"
                  value={form.time}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    patch("time", event.target.value);
                  }}
                  onBlur={() => {
                    touch("deadline");
                  }}
                />
              </span>
            )}
          </Field>
          <Field
            id={`${ids}-email`}
            label="PayPal email for the money"
            hint="PayPal sends the money here once the pledges are collected, after its fees. Only you see it."
            problem={shown("email")}
          >
            {(describedBy, invalid) => (
              <input
                id={`${ids}-email`}
                className="field-input"
                type="email"
                autoComplete="email"
                value={form.email}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(event) => {
                  patch("email", event.target.value);
                }}
                onBlur={() => {
                  touch("email");
                }}
              />
            )}
          </Field>
          <Field
            id={`${ids}-perk`}
            label="Founding-supporter perk"
            aside="optional"
            hint="Put on the page word for word, such as “10% off every visit in the first year”. Leave it empty if you offer none."
            problem={shown("perk")}
            className="cf-wide"
          >
            {(describedBy, invalid) => (
              <input
                id={`${ids}-perk`}
                className="field-input"
                type="text"
                maxLength={LIMITS.perk + 20}
                placeholder="10% off every visit in the first year"
                value={form.perk}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                onChange={(event) => {
                  patch("perk", event.target.value);
                }}
                onBlur={() => {
                  touch("perk");
                }}
              />
            )}
          </Field>
        </fieldset>
        {sandbox ? <SandboxNotice /> : null}
        <div className="cf-actions">
          {draft ? (
            <button className="ghost mono" type="submit" disabled={busy !== null}>
              {busy === "drafting" ? "Drafting…" : "Draft again with AI"}
            </button>
          ) : (
            <button className="go" type="submit" disabled={busy !== null}>
              <span>{busy === "drafting" ? "Drafting…" : "Draft with AI"}</span>
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 12h15M13 6l6 6-6 6" />
                </svg>
              </i>
            </button>
          )}
          <p className="cf-note">
            AI writes a title, a pitch and perks from {name}&apos;s {business ? "description" : "evidence"}. It never sets a number: your terms go in
            unchanged, and you edit the words before anything is published.
          </p>
        </div>
      </form>

      <div className="cf-feedback" role="status" aria-live="polite">
        {busy === "drafting" ? <p className="cf-busy mono">Writing the page from the evidence</p> : null}
        {busy === "publishing" ? <p className="cf-busy mono">Publishing</p> : null}
      </div>
      {problems?.lines.length ? (
        <div className="cf-problems" role="alert">
          <p className="mono">{problems.when === "draft" ? "Not drafted" : "Not published yet"}</p>
          <ul>
            {problems.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {conflict ? (
        <p className="cf-problems" role="alert">
          You already have an open campaign for this kit.{" "}
          <Link className="text-link" href={conflict}>
            Open it <span aria-hidden="true">→</span>
          </Link>
        </p>
      ) : null}

      {draft ? (
        <section className="cf-draft" aria-labelledby={`${ids}-draft`}>
          <h3 className="cf-step" id={`${ids}-draft`}>
            <span className="mono">Step 2</span> The page, drafted for you to edit
          </h3>
          {stale ? (
            <p className="cf-stale">You changed the terms after this draft: draft again, or check the words still match them.</p>
          ) : null}
          <div className="cf-field cf-wide">
            <span className="cf-label-row">
              <label className="mono label" htmlFor={`${ids}-title`}>
                Title
              </label>
              <Counter text={draft.title} max={LIMITS.title} />
            </span>
            <input
              id={`${ids}-title`}
              className="field-input cf-title-input"
              type="text"
              value={draft.title}
              onChange={(event) => {
                patchDraft({ title: event.target.value });
              }}
            />
          </div>
          <div className="cf-field cf-wide">
            <span className="cf-label-row">
              <label className="mono label" htmlFor={`${ids}-pitch`}>
                Pitch to your neighbors
              </label>
              <Counter text={draft.pitch} max={LIMITS.pitch} />
            </span>
            <textarea
              id={`${ids}-pitch`}
              className="field-input cf-textarea"
              rows={4}
              value={draft.pitch}
              onChange={(event) => {
                patchDraft({ pitch: event.target.value });
              }}
            />
          </div>
          <fieldset className="cf-perks">
            <legend className="mono label">What founding supporters get</legend>
            <ol>
              {draft.perks.map((perk, index) => (
                // The perks are edited in place: their place in the list is what names them.
                <li key={index}>
                  <input
                    className="field-input"
                    type="text"
                    aria-label={`Perk ${index + 1}`}
                    value={perk}
                    onChange={(event) => {
                      patchDraft({ perks: draft.perks.map((old, at) => (at === index ? event.target.value : old)) });
                    }}
                  />
                  <Counter text={perk} max={LIMITS.perk} />
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove perk ${index + 1}`}
                    onClick={() => {
                      patchDraft({ perks: draft.perks.filter((_, at) => at !== index) });
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>
            {draft.perks.length < LIMITS.perks ? (
              <button
                type="button"
                className="ghost mono"
                onClick={() => {
                  patchDraft({ perks: [...draft.perks, ""] });
                }}
              >
                Add a perk
              </button>
            ) : null}
          </fieldset>
          <div className="cf-how">
            <p className="mono label">How it works · the server&apos;s own words</p>
            <p>{draft.howItWorks}</p>
          </div>
          {preview ? (
            <div className="cf-preview">
              <p className="mono label">Beside the PayPal button, neighbors read</p>
              <p>{preview}</p>
            </div>
          ) : null}
          <div className="cf-actions">
            <button className="go" type="button" disabled={busy !== null} onClick={() => void publish()}>
              <span>{busy === "publishing" ? "Publishing…" : "Publish the campaign"}</span>
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 12h15M13 6l6 6-6 6" />
                </svg>
              </i>
            </button>
            <p className="cf-note">The page goes live at its own link, ready to share; the kit&apos;s poster then points to it.</p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
