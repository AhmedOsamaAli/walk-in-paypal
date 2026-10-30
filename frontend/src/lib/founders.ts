/* Founders in plain words: money, progress, the deadline, the pledge's terms and the poster's line, and the campaign
   form's checks, which mirror the server's limits (app/payments/pledges.py). Pure, so they are tested without a browser. */
import type { CampaignOwner, CampaignProgress, CampaignStatus, CampaignTerms, PayPalConfig } from "../api/founders";
import type { KitView } from "../api/kit";

/** Shown wherever money appears while PayPal runs in its sandbox. */
export const SANDBOX_NOTICE = "Demo payments — no real money.";

/** Only the viewer's own open campaign replaces this kit's launch invitation. */
export function ownCampaign(view: KitView) {
  return view.campaigns?.find((campaign) => campaign.is_owner && campaign.status === "open") ?? null;
}

/**
 * The owner's terms and words as the server allows them. A campaign runs at most 27 days: PayPal holds an
 * authorization for 29, and settling it keeps the last 2.
 */
export const LIMITS = {
  minAmount: 5,
  maxAmount: 200,
  minGoal: 3,
  maxGoal: 500,
  minDays: 1,
  maxDays: 27,
  title: 60,
  pitch: 300,
  perk: 80,
  perks: 4,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Every pledge is a test one unless the server says PayPal is live. */
export function inSandbox(paypal: PayPalConfig | null | undefined): boolean {
  return paypal?.environment !== "live";
}

/** "$25", "$25.50", "$1,200": cents only when there are some. */
export function moneyText(amount: string, currency = "USD"): string {
  const value = Number(amount);
  if (!amount.trim() || !Number.isFinite(value)) return `${amount} ${currency}`.trim();
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

interface Zoned {
  /** The time zone to read the date in; the reader's own unless given. */
  timeZone?: string;
}

/** "Nov 30": a deadline's day, as the sentences about it say it. */
export function dayText(iso: string, { timeZone }: Zoned = {}): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "the deadline";
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** "Mon, Nov 30, 8:00 PM UTC": the deadline in full, its time zone named. */
export function deadlineText(iso: string, { timeZone }: Zoned = {}): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "12 days left", "1 day, 4 hours left", "5 hours left", "Under a minute left"; closed once the deadline has passed. */
export function timeLeft(deadline: string, now: number): { closed: boolean; text: string } {
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { closed: true, text: "Closed" };
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor(ms / MINUTE_MS);
  let text: string;
  if (days >= 2) text = counted(days, "day");
  else if (days === 1) text = hours > 24 ? `1 day, ${counted(hours - 24, "hour")}` : "1 day";
  else if (hours >= 1) text = counted(hours, "hour");
  else if (minutes >= 1) text = counted(minutes, "minute");
  else return { closed: false, text: "Under a minute left" };
  return { closed: false, text: `${text} left` };
}

/** How far along the bar is, from 0 to 1: full once the goal is met, whatever the server rounded. */
export function progressShare(progress: Pick<CampaignProgress, "supporters" | "goal">): number {
  if (progress.goal <= 0) return 0;
  return Math.max(0, Math.min(1, progress.supporters / progress.goal));
}

/** "12 of 40 neighbors". */
export function supportersText(progress: Pick<CampaignProgress, "supporters" | "goal">): string {
  return `${progress.supporters} of ${progress.goal} neighbors`;
}

/** "28 more by Nov 30", or "Goal met". */
export function neededText(progress: Pick<CampaignProgress, "remaining" | "funded">, deadline: string, zone: Zoned = {}): string {
  if (progress.funded) return "Goal met";
  return `${progress.remaining} more by ${dayText(deadline, zone)}`;
}

/**
 * The money behind a campaign, as its state has it, for the campaign's card: held by PayPal while it is open, being
 * collected once it met its goal, collected at the end, released when it missed its goal or was cancelled. `total` is
 * what its held or collected pledges add up to ("75.00").
 */
export function moneyFact(status: CampaignStatus, total: string): { label: string; value: string } {
  switch (status) {
    case "open":
      return { label: "Held by PayPal so far", value: moneyText(total) };
    case "funded":
    case "partial":
      return { label: "Being collected", value: moneyText(total) };
    case "collected":
      return { label: "Collected", value: moneyText(total) };
    case "expired":
    case "cancelled":
      return { label: "Pledges", value: "Released" };
  }
}

/** The same in a few words, for lists: "$75 held", "$75 being collected", "$15 collected", "holds released". */
export function heldText(status: CampaignStatus, total: string): string {
  switch (status) {
    case "open":
      return `${moneyText(total)} held`;
    case "funded":
    case "partial":
      return `${moneyText(total)} being collected`;
    case "collected":
      return `${moneyText(total)} collected`;
    case "expired":
    case "cancelled":
      return "holds released";
  }
}

/** What a screen reader hears when the count changes: "13 of 40 neighbors have joined." */
export function progressNews(progress: Pick<CampaignProgress, "supporters" | "goal" | "funded">): string {
  const joined = `${progress.supporters} of ${progress.goal} neighbors ${progress.supporters === 1 ? "has" : "have"} joined.`;
  return progress.funded ? `${joined} The goal is met.` : joined;
}

/** The pledge in plain words, beside the button: "PayPal holds $25. You are charged only if 40 neighbors join by Nov 30;
 * otherwise the hold is released." */
export function pledgeTerms(amount: string, goal: number, deadline: string, zone: Zoned = {}): string {
  return `PayPal holds ${moneyText(amount)}. You are charged only if ${goal} neighbors join by ${dayText(deadline, zone)}; otherwise the hold is released.`;
}

/** The poster keeps the same hold, collection and release conditions as the pledge decision. */
export function posterLine(amount: string, goal: number, deadline: string, zone: Zoned = {}): string {
  return pledgeTerms(amount, goal, deadline, zone);
}

/** A campaign's state in a word or two, for its pill. */
export function statusText(status: CampaignStatus, accepting = true): string {
  switch (status) {
    case "open":
      return accepting ? "Open" : "Settling";
    case "funded":
      return "Goal met";
    case "partial":
      return "Collecting";
    case "collected":
      return "Collected";
    case "expired":
      return "Missed its goal";
    case "cancelled":
      return "Cancelled";
  }
}

/** Why a campaign takes no more pledges, in a sentence. */
export function closedText(status: CampaignStatus): string {
  switch (status) {
    case "open":
      return "The deadline has passed, and the campaign is being settled.";
    case "funded":
      return "It met its goal. PayPal is collecting every pledge.";
    case "partial":
      return "It met its goal. PayPal is still collecting some of the pledges.";
    case "collected":
      return "It met its goal, and every pledge was collected.";
    case "expired":
      return "It ended short of its goal, so every hold was released: nobody paid.";
    case "cancelled":
      return "The owner cancelled it, so every hold was released: nobody paid.";
  }
}

/** The pledges' statuses, as the owner's counts name them, in the order they are shown. */
const COUNT_NAMES: [string, string][] = [
  ["authorized", "Held"],
  ["captured", "Collected"],
  ["created", "Started, not approved"],
  ["voided", "Released"],
  ["withdrawn", "Withdrawn"],
  ["declined", "Declined"],
  ["expired", "Hold ran out"],
  ["failed", "Could not be collected"],
];

/** The owner's counts as labelled rows, the known statuses first; statuses with no pledges are left out. */
export function countRows(counts: Record<string, number>): { key: string; label: string; count: number }[] {
  const known = new Map(COUNT_NAMES);
  const keys = [...COUNT_NAMES.map(([key]) => key), ...Object.keys(counts).filter((key) => !known.has(key)).sort()];
  return keys
    .map((key) => ({
      key,
      label: known.get(key) ?? `${key.charAt(0).toUpperCase()}${key.slice(1).replace(/_/g, " ")}`,
      count: counts[key] ?? 0,
    }))
    .filter((row) => row.count > 0);
}

/** Where the money stands for the owner: "$950.20 paid to o***@example.com". */
export function payoutText(payout: CampaignOwner["payout"]): string {
  const amount = payout.amount ? moneyText(payout.amount) : null;
  switch (payout.status) {
    case "none":
      return `Sent to ${payout.email} once the pledges are collected, after PayPal's fees.`;
    case "pending":
      return amount ? `${amount} on its way to ${payout.email}.` : `On its way to ${payout.email}.`;
    case "paid":
      return amount ? `${amount} paid to ${payout.email}.` : `Paid to ${payout.email}.`;
    case "failed":
      return `The payout to ${payout.email} did not go through. Check that the address has a PayPal account.`;
  }
}

// ---------- The campaign form: the owner's terms and the words, checked as the server checks them ----------

/** "25", "$25.5" or "25.50" as the API writes amounts, "25.50"; null when it is not an amount with at most two decimals. */
export function normalizeAmount(text: string): string | null {
  const plain = text.trim().replace(/^\$\s*/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(plain)) return null;
  return Number(plain).toFixed(2);
}

export function amountProblem(text: string): string | null {
  const amount = normalizeAmount(text);
  const value = amount === null ? NaN : Number(amount);
  if (!(value >= LIMITS.minAmount && value <= LIMITS.maxAmount)) {
    return `Pick an amount from $${LIMITS.minAmount} to $${LIMITS.maxAmount}, such as 25.`;
  }
  return null;
}

/** The goal in supporters, when it is a whole number. */
export function goalValue(text: string): number | null {
  const plain = text.trim();
  return /^\d{1,4}$/.test(plain) ? Number(plain) : null;
}

export function goalProblem(text: string): string | null {
  const goal = goalValue(text);
  if (goal === null || goal < LIMITS.minGoal || goal > LIMITS.maxGoal) {
    return `Pick a goal from ${LIMITS.minGoal} to ${LIMITS.maxGoal} supporters.`;
  }
  return null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A moment as a date field's value, in local time: "2026-11-16". */
export function dateValue(ms: number): string {
  const day = new Date(ms);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The form's local date and time as an ISO instant in UTC; null when either is missing or no such day exists. */
export function deadlineFrom(date: string, time: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) return null;
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const local = new Date(year, month - 1, dayOfMonth, Number(clock[1]), Number(clock[2]));
  const real = local.getFullYear() === year && local.getMonth() === month - 1 && local.getDate() === dayOfMonth;
  return real && !Number.isNaN(local.getTime()) ? local.toISOString() : null;
}

/** The form's first deadline: three weeks out, at 8 pm local time. */
export function defaultDeadline(now: number): { date: string; time: string } {
  return { date: dateValue(now + 21 * DAY_MS), time: "20:00" };
}

/** The days the date field offers: from tomorrow to 27 days from now. */
export function deadlineRange(now: number): { min: string; max: string } {
  return { min: dateValue(now + LIMITS.minDays * DAY_MS), max: dateValue(now + LIMITS.maxDays * DAY_MS) };
}

/** Why a deadline cannot be used, or null: it must be 1 to 27 days away. */
export function deadlineProblem(iso: string | null, now: number): string | null {
  if (iso === null) return "Pick a date and a time for the deadline.";
  const away = Date.parse(iso) - now;
  if (away < LIMITS.minDays * DAY_MS) return "Pick a deadline at least a day away.";
  if (away > LIMITS.maxDays * DAY_MS) {
    return `Pick a deadline at most ${LIMITS.maxDays} days away: PayPal holds a pledge for 29 days, and the last 2 are kept for collecting it.`;
  }
  return null;
}

export function perkProblem(text: string): string | null {
  return text.trim().length > LIMITS.perk ? `Keep the perk to ${LIMITS.perk} characters.` : null;
}

export function emailProblem(text: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim()) ? null : "Enter the PayPal email that receives the money.";
}

/** What the owner typed, as the form holds it. */
export interface TermsForm {
  amount: string;
  goal: string;
  date: string;
  time: string;
  perk: string;
  email: string;
}

export type TermsField = "amount" | "goal" | "deadline" | "perk" | "email";

/** Each term's problem, or null where it is fine. */
export function termsProblems(form: TermsForm, now: number): Record<TermsField, string | null> {
  return {
    amount: amountProblem(form.amount),
    goal: goalProblem(form.goal),
    deadline: deadlineProblem(deadlineFrom(form.date, form.time), now),
    perk: perkProblem(form.perk),
    email: emailProblem(form.email),
  };
}

/** The terms as the API takes them, once every one of them is fine; else null. */
export function moneyTermsOf(form: TermsForm, now: number): Omit<CampaignTerms, "kit_token"> | null {
  const amount = normalizeAmount(form.amount);
  const goal = goalValue(form.goal);
  const deadline = deadlineFrom(form.date, form.time);
  const problems = termsProblems(form, now);
  if (amount === null || goal === null || deadline === null || Object.values(problems).some((problem) => problem !== null)) {
    return null;
  }
  const perk = form.perk.trim().replace(/\s+/g, " ");
  return { amount, goal, deadline, perk: perk || null };
}

export function termsOf(form: TermsForm, kitToken: string, now: number): CampaignTerms | null {
  const terms = moneyTermsOf(form, now);
  return terms ? { kit_token: kitToken, ...terms } : null;
}

/** The words as the owner edited them. */
export interface Words {
  title: string;
  pitch: string;
  perks: string[];
}

/** Why the edited words cannot be published as they are; the server checks what they say. */
export function wordsProblems(words: Words): string[] {
  const problems: string[] = [];
  const title = words.title.trim();
  const pitch = words.pitch.trim();
  const perks = words.perks.map((perk) => perk.trim()).filter(Boolean);
  if (!title) problems.push("Give the page a title.");
  else if (title.length > LIMITS.title) problems.push(`Keep the title to ${LIMITS.title} characters.`);
  if (!pitch) problems.push("Write the pitch to your neighbors.");
  else if (pitch.length > LIMITS.pitch) problems.push(`Keep the pitch to ${LIMITS.pitch} characters.`);
  if (!perks.length) problems.push("List at least one thing founding supporters get.");
  if (perks.length > LIMITS.perks) problems.push(`Keep to ${LIMITS.perks} perks.`);
  perks.forEach((perk, index) => {
    if (perk.length > LIMITS.perk) problems.push(`Keep perk ${index + 1} to ${LIMITS.perk} characters.`);
  });
  return problems;
}

/** The words as the API takes them: trimmed, the empty perks left out. */
export function cleanWords(words: Words): Words {
  return {
    title: words.title.trim().replace(/\s+/g, " "),
    pitch: words.pitch.trim().replace(/\s+/g, " "),
    perks: words.perks.map((perk) => perk.trim().replace(/\s+/g, " ")).filter(Boolean),
  };
}
