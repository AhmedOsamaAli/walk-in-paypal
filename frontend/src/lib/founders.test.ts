import { describe, expect, it } from "vitest";
import {
  amountProblem,
  cleanWords,
  closedText,
  countRows,
  dateValue,
  dayText,
  deadlineFrom,
  deadlineProblem,
  deadlineRange,
  deadlineText,
  defaultDeadline,
  emailProblem,
  goalProblem,
  heldText,
  inSandbox,
  LIMITS,
  moneyFact,
  moneyText,
  neededText,
  normalizeAmount,
  payoutText,
  perkProblem,
  pledgeTerms,
  posterLine,
  progressNews,
  progressShare,
  statusText,
  supportersText,
  termsOf,
  termsProblems,
  timeLeft,
  wordsProblems,
  type TermsForm,
} from "./founders";

const UTC = { timeZone: "UTC" };
const NOV_30 = "2026-11-30T20:00:00Z";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T10:00:00Z");

describe("money", () => {
  it("shows the cents only when there are some", () => {
    expect(moneyText("25.00")).toBe("$25");
    expect(moneyText("25.50")).toBe("$25.50");
    expect(moneyText("5")).toBe("$5");
    expect(moneyText("1200.00")).toBe("$1,200");
  });

  it("keeps what is not an amount as it was", () => {
    expect(moneyText("")).toBe("USD");
    expect(moneyText("abc")).toBe("abc USD");
  });

  it("is a test pledge unless PayPal is live", () => {
    expect(inSandbox({ enabled: true, client_id: "x", environment: "sandbox", currency: "USD" })).toBe(true);
    expect(inSandbox({ enabled: true, client_id: "x", environment: "live", currency: "USD" })).toBe(false);
    expect(inSandbox(null)).toBe(true);
  });
});

describe("the deadline in words", () => {
  it("names the day the sentences give, in the reader's time zone", () => {
    expect(dayText(NOV_30, UTC)).toBe("Nov 30");
    expect(dayText("2026-11-30T23:30:00Z", { timeZone: "Asia/Tokyo" })).toBe("Dec 1");
    expect(dayText("not a date")).toBe("the deadline");
  });

  it("gives the deadline in full, its time zone named", () => {
    expect(deadlineText(NOV_30, UTC)).toMatch(/^Mon, Nov 30, 8:00\sPM UTC$/);
    expect(deadlineText("nope")).toBe("");
  });

  it("counts down in days, then hours and minutes, and closes at the deadline", () => {
    const deadline = new Date(NOW + 12 * DAY + 3_600_000).toISOString();
    expect(timeLeft(deadline, NOW)).toEqual({ closed: false, text: "12 days left" });
    expect(timeLeft(new Date(NOW + DAY + 4 * 3_600_000).toISOString(), NOW).text).toBe("1 day, 4 hours left");
    expect(timeLeft(new Date(NOW + DAY + 60_000).toISOString(), NOW).text).toBe("1 day left");
    expect(timeLeft(new Date(NOW + 5 * 3_600_000).toISOString(), NOW).text).toBe("5 hours left");
    expect(timeLeft(new Date(NOW + 3_600_000).toISOString(), NOW).text).toBe("1 hour left");
    expect(timeLeft(new Date(NOW + 90_000).toISOString(), NOW).text).toBe("1 minute left");
    expect(timeLeft(new Date(NOW + 20_000).toISOString(), NOW)).toEqual({ closed: false, text: "Under a minute left" });
    expect(timeLeft(new Date(NOW).toISOString(), NOW)).toEqual({ closed: true, text: "Closed" });
    expect(timeLeft("not a date", NOW).closed).toBe(true);
  });
});

describe("progress in words", () => {
  const progress = { supporters: 12, goal: 40, remaining: 28, percent: 30, total: "300.00", funded: false };

  it("says how many have joined and how many more are needed by when", () => {
    expect(supportersText(progress)).toBe("12 of 40 neighbors");
    expect(neededText(progress, NOV_30, UTC)).toBe("28 more by Nov 30");
    expect(neededText({ remaining: 0, funded: true }, NOV_30, UTC)).toBe("Goal met");
  });

  it("fills the bar from the count, never past full", () => {
    expect(progressShare(progress)).toBe(0.3);
    expect(progressShare({ supporters: 45, goal: 40 })).toBe(1);
    expect(progressShare({ supporters: 0, goal: 40 })).toBe(0);
    expect(progressShare({ supporters: 3, goal: 0 })).toBe(0);
  });

  it("tells a screen reader the new count, and when the goal is met", () => {
    expect(progressNews(progress)).toBe("12 of 40 neighbors have joined.");
    expect(progressNews({ supporters: 1, goal: 40, funded: false })).toBe("1 of 40 neighbors has joined.");
    expect(progressNews({ supporters: 40, goal: 40, funded: true })).toBe("40 of 40 neighbors have joined. The goal is met.");
  });

  it("says what the pledges come to as the campaign stands: held, being collected, collected or released", () => {
    expect(moneyFact("open", "75.00")).toEqual({ label: "Held by PayPal so far", value: "$75" });
    expect(moneyFact("open", "0.00")).toEqual({ label: "Held by PayPal so far", value: "$0" });
    expect(moneyFact("funded", "1025.00")).toEqual({ label: "Being collected", value: "$1,025" });
    expect(moneyFact("partial", "62.50")).toEqual({ label: "Being collected", value: "$62.50" });
    expect(moneyFact("collected", "15.00")).toEqual({ label: "Collected", value: "$15" });
    expect(moneyFact("expired", "0.00")).toEqual({ label: "Pledges", value: "Released" });
    expect(moneyFact("cancelled", "25.00")).toEqual({ label: "Pledges", value: "Released" });
    expect(heldText("open", "75.00")).toBe("$75 held");
    expect(heldText("funded", "75.00")).toBe("$75 being collected");
    expect(heldText("collected", "15.00")).toBe("$15 collected");
    expect(heldText("cancelled", "0.00")).toBe("holds released");
  });
});

describe("the pledge's terms and the poster's line", () => {
  it("say in plain words what PayPal holds and when anyone is charged", () => {
    expect(pledgeTerms("25.00", 40, NOV_30, UTC)).toBe(
      "PayPal holds $25. You are charged only if 40 neighbors join by Nov 30; otherwise the hold is released.",
    );
    expect(pledgeTerms("12.50", 3, NOV_30, UTC)).toBe(
      "PayPal holds $12.50. You are charged only if 3 neighbors join by Nov 30; otherwise the hold is released.",
    );
  });

  it("puts the campaign's own terms on the poster", () => {
    expect(posterLine("25.00", 40, NOV_30, UTC)).toBe(
      "PayPal holds $25. You are charged only if 40 neighbors join by Nov 30; otherwise the hold is released.",
    );
    expect(posterLine("200.00", 500, "2026-12-01T09:00:00Z", UTC)).toBe(
      "PayPal holds $200. You are charged only if 500 neighbors join by Dec 1; otherwise the hold is released.",
    );
  });
});

describe("a campaign's state", () => {
  it("names each state in a word or two", () => {
    expect(statusText("open")).toBe("Open");
    expect(statusText("open", false)).toBe("Settling");
    expect(statusText("funded")).toBe("Goal met");
    expect(statusText("partial")).toBe("Collecting");
    expect(statusText("collected")).toBe("Collected");
    expect(statusText("expired")).toBe("Missed its goal");
    expect(statusText("cancelled")).toBe("Cancelled");
  });

  it("says why a closed campaign takes no pledges, and that nobody paid when it fell short", () => {
    expect(closedText("expired")).toContain("nobody paid");
    expect(closedText("cancelled")).toContain("nobody paid");
    expect(closedText("collected")).toContain("every pledge was collected");
  });

  it("lists the owner's counts, the known ones first and the empty ones left out", () => {
    expect(countRows({ voided: 2, authorized: 12, created: 0, refunded: 1 })).toEqual([
      { key: "authorized", label: "Held", count: 12 },
      { key: "voided", label: "Released", count: 2 },
      { key: "refunded", label: "Refunded", count: 1 },
    ]);
    expect(countRows({})).toEqual([]);
  });

  it("says where the payout stands", () => {
    const email = "o***@example.com";
    expect(payoutText({ status: "none", amount: null, email })).toBe(
      "Sent to o***@example.com once the pledges are collected, after PayPal's fees.",
    );
    expect(payoutText({ status: "pending", amount: "960.75", email })).toBe("$960.75 on its way to o***@example.com.");
    expect(payoutText({ status: "paid", amount: "960.75", email })).toBe("$960.75 paid to o***@example.com.");
    expect(payoutText({ status: "failed", amount: "960.75", email })).toContain("did not go through");
  });
});

describe("the campaign form, as the server checks it", () => {
  it("reads an amount with at most two decimals", () => {
    expect(normalizeAmount("25")).toBe("25.00");
    expect(normalizeAmount(" $25.5 ")).toBe("25.50");
    expect(normalizeAmount("25.555")).toBeNull();
    expect(normalizeAmount("25,00")).toBeNull();
    expect(normalizeAmount("-5")).toBeNull();
    expect(normalizeAmount("")).toBeNull();
  });

  it("allows a pledge from $5 to $200", () => {
    expect(amountProblem("5")).toBeNull();
    expect(amountProblem("200.00")).toBeNull();
    expect(amountProblem("4.99")).toContain("$5 to $200");
    expect(amountProblem("200.01")).toContain("$5 to $200");
    expect(amountProblem("twenty")).toContain("$5 to $200");
  });

  it("allows a goal of 3 to 500 supporters, in whole numbers", () => {
    expect(goalProblem("3")).toBeNull();
    expect(goalProblem("500")).toBeNull();
    expect(goalProblem("2")).toContain("3 to 500");
    expect(goalProblem("501")).toContain("3 to 500");
    expect(goalProblem("40.5")).toContain("3 to 500");
    expect(goalProblem("")).toContain("3 to 500");
  });

  it("reads the local date and time as an instant, and refuses days that do not exist", () => {
    const iso = deadlineFrom("2026-11-16", "20:00");
    expect(iso).not.toBeNull();
    expect(new Date(iso ?? "").getHours()).toBe(20);
    expect(deadlineFrom("2026-02-30", "20:00")).toBeNull();
    expect(deadlineFrom("2026-11-16", "")).toBeNull();
    expect(deadlineFrom("", "20:00")).toBeNull();
  });

  it("allows a deadline 1 to 27 days away: PayPal holds a pledge for 29", () => {
    expect(deadlineProblem(new Date(NOW + 21 * DAY).toISOString(), NOW)).toBeNull();
    expect(deadlineProblem(new Date(NOW + DAY).toISOString(), NOW)).toBeNull();
    expect(deadlineProblem(new Date(NOW + LIMITS.maxDays * DAY).toISOString(), NOW)).toBeNull();
    expect(deadlineProblem(new Date(NOW + DAY - 60_000).toISOString(), NOW)).toContain("at least a day");
    expect(deadlineProblem(new Date(NOW + 27 * DAY + 60_000).toISOString(), NOW)).toContain("at most 27 days");
    expect(deadlineProblem(null, NOW)).toContain("Pick a date and a time");
  });

  it("starts three weeks out at 8 pm, and offers tomorrow to 27 days from now", () => {
    const first = defaultDeadline(NOW);
    expect(first.time).toBe("20:00");
    expect(first.date).toBe(dateValue(NOW + 21 * DAY));
    expect(deadlineRange(NOW)).toEqual({ min: dateValue(NOW + DAY), max: dateValue(NOW + 27 * DAY) });
  });

  it("keeps the perk short, and asks for a PayPal email", () => {
    expect(perkProblem("")).toBeNull();
    expect(perkProblem("10% off every visit in the first year")).toBeNull();
    expect(perkProblem("x".repeat(LIMITS.perk + 1))).toContain(`${LIMITS.perk} characters`);
    expect(emailProblem("owner@example.com")).toBeNull();
    expect(emailProblem(" owner@example.com ")).toBeNull();
    expect(emailProblem("owner@example")).not.toBeNull();
    expect(emailProblem("")).not.toBeNull();
  });

  it("sends the terms only once every one of them is fine", () => {
    const date = new Date(NOW + 21 * DAY);
    const form: TermsForm = {
      amount: "25",
      goal: "40",
      date: dateValue(date.getTime()),
      time: "20:00",
      perk: "  10% off   every visit ",
      email: "owner@example.com",
    };
    expect(Object.values(termsProblems(form, NOW)).every((problem) => problem === null)).toBe(true);
    expect(termsOf(form, "tok_1", NOW)).toEqual({
      kit_token: "tok_1",
      amount: "25.00",
      goal: 40,
      deadline: deadlineFrom(form.date, form.time),
      perk: "10% off every visit",
    });
    expect(termsOf({ ...form, perk: " " }, "tok_1", NOW)?.perk).toBeNull();
    expect(termsOf({ ...form, goal: "2" }, "tok_1", NOW)).toBeNull();
    expect(termsOf({ ...form, email: "nope" }, "tok_1", NOW)).toBeNull();
    expect(termsProblems({ ...form, amount: "500" }, NOW).amount).toContain("$5 to $200");
  });

  it("checks the edited words' lengths, and leaves what they say to the server", () => {
    const words = { title: "Back Golden Hour", pitch: "Bread before eight.", perks: ["Your name on the wall", ""] };
    expect(wordsProblems(words)).toEqual([]);
    expect(wordsProblems({ ...words, title: " " })).toEqual(["Give the page a title."]);
    expect(wordsProblems({ ...words, title: "x".repeat(61) })).toEqual(["Keep the title to 60 characters."]);
    expect(wordsProblems({ ...words, pitch: "x".repeat(301) })).toEqual(["Keep the pitch to 300 characters."]);
    expect(wordsProblems({ ...words, perks: [" "] })).toEqual(["List at least one thing founding supporters get."]);
    expect(wordsProblems({ ...words, perks: ["a", "b", "c", "d", "e"] })).toEqual(["Keep to 4 perks."]);
    expect(wordsProblems({ ...words, perks: ["ok", "x".repeat(81)] })).toEqual(["Keep perk 2 to 80 characters."]);
    expect(cleanWords({ title: "  Back   it ", pitch: " Bread\n before eight. ", perks: [" a ", "", " b"] })).toEqual({
      title: "Back it",
      pitch: "Bread before eight.",
      perks: ["a", "b"],
    });
  });
});
