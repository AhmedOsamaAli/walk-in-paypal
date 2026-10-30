"""Founding-supporter pledges: neighbors pledge a fixed amount to a business planned for an empty storefront. PayPal
only holds each pledge (an AUTHORIZE order); the money is collected if enough neighbors pledge by the deadline and
released if not.

Pure campaign logic over small dataclasses, with no storage: checks for a new campaign, its progress, the decision its
close makes (decide_funding), what to do with each pledge now (decide), doing it through PayPal (settle), and the
campaign's pitch drafted by the AI. The owner always chooses the amount, the goal, the deadline and the perk line; the AI
only writes words, checked like every model answer in the app, and the owner's edited words are checked the same way.

Settle a campaign as soon as it closes: PayPal holds a pledge for 29 days, and the longest campaign keeps the last 2 of
them for collecting. Store the funded decision before the first capture, so a settlement cut short resumes as it began.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
from collections import Counter
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Any

from ..answers import AnswerCache, fingerprint
from ..llm import LLM
from ..survey.concepts import COMMON_NAME_WORDS
from ..survey.evidence import NATIONAL, PROPER_WORDS, is_walk
from ..survey.kit import SUPERLATIVE, WALKING, mid_sentence
from .paypal import (
    AUTHORIZATION_PERIOD,
    HONOR_PERIOD,
    ZERO_DECIMAL,
    PayPalClient,
    PayPalError,
    capture_from,
    decimal_amount,
    money,
    net_amount,
    parse_time,
    request_key,
    summarize_authorization,
)

log = logging.getLogger("walkin")

# What the owner may choose. PayPal holds a pledge for 29 days (AUTHORIZATION_PERIOD) from the moment it is placed, so a
# pledge made at the launch of the longest campaign must still be held when the campaign closes and settle() collects
# it, a retry after an outage included: the deadline keeps SETTLEMENT_MARGIN of the 29 days for that.
SETTLEMENT_MARGIN = timedelta(days=2)
LONGEST_CAMPAIGN = AUTHORIZATION_PERIOD - SETTLEMENT_MARGIN  # 27 days
MIN_AMOUNT, MAX_AMOUNT = Decimal("5.00"), Decimal("200.00")
MIN_GOAL, MAX_GOAL = 3, 500
MIN_DAYS, MAX_DAYS = 1, LONGEST_CAMPAIGN.days


class CampaignStatus(StrEnum):
    OPEN = "open"  # taking pledges, or closed and not settled yet
    FUNDED = "funded"  # closed with its goal met: collecting has begun, or is about to
    COLLECTED = "collected"  # funded, and every pledge was collected
    PARTIAL = "partial"  # funded, but some pledges could not be collected (or not yet)
    EXPIRED = "expired"  # the deadline passed short of the goal: every hold released
    CANCELLED = "cancelled"  # the owner closed it short of the goal: every hold released


class PledgeStatus(StrEnum):
    CREATED = "created"  # the order exists; the supporter has not approved it yet
    AUTHORIZED = "authorized"  # PayPal holds the money: it counts toward the goal
    DECLINED = "declined"  # PayPal would not hold it; it never counted
    CAPTURED = "captured"  # collected
    VOIDED = "voided"  # released: the campaign fell short or was cancelled
    WITHDRAWN = "withdrawn"  # released at the supporter's request while the campaign was open
    EXPIRED = "expired"  # the hold ran out before it was collected or released
    FAILED = "failed"  # the campaign was funded, but this pledge could not be collected
    REFUNDED = "refunded"  # collected, then refunded or reversed at PayPal


# A settled campaign changes no more; a funded or partial one keeps collecting what it still can.
FINAL = frozenset({CampaignStatus.COLLECTED, CampaignStatus.EXPIRED, CampaignStatus.CANCELLED})
COLLECTING = frozenset({CampaignStatus.FUNDED, CampaignStatus.PARTIAL})
# Pledges whose hold counts toward the goal at the close if it was in place then: still held, collected since, or
# refused when settlement tried to collect it.
HELD_AT_CLOSE = frozenset({PledgeStatus.AUTHORIZED, PledgeStatus.CAPTURED, PledgeStatus.FAILED})
# A PayPal authorization's status, as a pledge.
FROM_AUTHORIZATION = {
    "CREATED": PledgeStatus.AUTHORIZED,
    "PENDING": PledgeStatus.CREATED,  # under review: it counts once PayPal confirms the hold
    "DENIED": PledgeStatus.DECLINED,
    "VOIDED": PledgeStatus.VOIDED,
    "CAPTURED": PledgeStatus.CAPTURED,
    "PARTIALLY_CAPTURED": PledgeStatus.CAPTURED,
}
CAPTURED_ISSUES = ("AUTHORIZATION_ALREADY_CAPTURED", "PREVIOUSLY_CAPTURED")
VOIDED_ISSUES = ("AUTHORIZATION_VOIDED", "PREVIOUSLY_VOIDED")
# PayPal's codes in plain words, for the owner's report.
ISSUE_TEXT = {
    "INSTRUMENT_DECLINED": "the card or bank declined the payment",
    "PAYER_CANNOT_PAY": "the supporter's PayPal account cannot pay",
    "PAYER_ACCOUNT_RESTRICTED": "the supporter's PayPal account is restricted",
    "PAYER_ACCOUNT_LOCKED_OR_CLOSED": "the supporter's PayPal account is locked or closed",
    "TRANSACTION_REFUSED": "PayPal refused the payment",
    "AUTHORIZATION_DENIED": "PayPal denied the hold",
    "AUTHORIZATION_EXPIRED": "the hold had run out",
    "AUTHORIZATION_VOIDED": "the hold had been cancelled",
    "DECLINED": "PayPal declined the capture",
    "FAILED": "the capture failed",
    "NO_AUTHORIZATION": "PayPal never held it",
}


@dataclass(frozen=True)
class Campaign:
    """A pledge campaign as its owner set it. Times are timezone-aware."""

    id: str
    amount: str  # each supporter's pledge, such as "25.00"
    goal: int  # supporters needed
    deadline: datetime
    currency: str = "USD"
    status: str = CampaignStatus.OPEN
    closed_at: datetime | None = None  # when the owner closed it before the deadline
    # The decision its close made (decide_funding): True collects every hold, False releases them all; None until then.
    # Store it before settle() acts on it, and pass it back every time.
    funded: bool | None = None


@dataclass(frozen=True)
class Pledge:
    """One supporter's pledge and the PayPal objects behind it."""

    id: str
    amount: str
    currency: str = "USD"
    status: str = PledgeStatus.CREATED
    order_id: str | None = None
    payer_id: str | None = None
    authorization_id: str | None = None  # the original hold: voids always go to it
    authorized_at: datetime | None = None
    expires_at: datetime | None = None  # when PayPal lets the hold go
    reauthorization_id: str | None = None  # the renewed hold PayPal allows once, captured instead of the original
    reauthorized_at: datetime | None = None
    capture_id: str | None = None
    capture_status: str | None = None  # the capture at PayPal: COMPLETED, or PENDING while PayPal reviews it
    net_amount: str | None = None  # what the capture leaves after PayPal's fee (seller_receivable_breakdown)
    error: str | None = None  # why the last settlement could not finish it


class CampaignError(ValueError):
    """A new campaign's terms are not allowed; `problems` says why, in plain words."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__(" ".join(problems))
        self.problems = problems


def validate_campaign(
    amount: object, goal: object, deadline: object, now: datetime, currency: object = "USD",
) -> list[str]:
    """What is wrong with a new campaign's terms, in plain words; an empty list when nothing is."""
    problems = []
    code = currency.upper() if isinstance(currency, str) else ""
    try:
        value: Decimal | None = decimal_amount(amount)
    except (TypeError, ValueError):
        value = None
    if value is None or not value.is_finite() or not MIN_AMOUNT <= value <= MAX_AMOUNT:
        problems.append(f"The pledge must be from {MIN_AMOUNT} to {MAX_AMOUNT}.")
    elif value != value.quantize(Decimal(1) if code in ZERO_DECIMAL else Decimal("0.01")):
        problems.append(f"The pledge has more decimals than {code or 'the currency'} allows.")
    if isinstance(goal, bool) or not isinstance(goal, int) or not MIN_GOAL <= goal <= MAX_GOAL:
        problems.append(f"The goal must be {MIN_GOAL} to {MAX_GOAL} supporters.")
    if not re.fullmatch(r"[A-Z]{3}", code):
        problems.append("The currency must be a three-letter code, such as USD.")
    if not isinstance(deadline, datetime) or deadline.tzinfo is None:
        problems.append("The deadline needs a date, a time and a time zone.")
    elif not timedelta(days=MIN_DAYS) <= deadline - now <= LONGEST_CAMPAIGN:
        problems.append(
            f"The deadline must be {MIN_DAYS} to {MAX_DAYS} days away: PayPal holds a pledge for "
            f"{AUTHORIZATION_PERIOD.days} days, and the last {SETTLEMENT_MARGIN.days} are kept for collecting it."
        )
    return problems


def new_campaign(
    campaign_id: str, amount: str | Decimal, goal: int, deadline: datetime, now: datetime, currency: str = "USD",
) -> Campaign:
    """A campaign on the owner's terms, open from now; CampaignError when the terms are not allowed."""
    problems = validate_campaign(amount, goal, deadline, now, currency)
    if problems:
        raise CampaignError(problems)
    code = currency.upper()
    return Campaign(id=campaign_id, amount=money(amount, code), goal=goal, deadline=deadline, currency=code)


def pledge_from_order(pledge_id: str, order: Mapping[str, Any]) -> Pledge:
    """A pledge as PayPal reports its order (the answer of authorize_order, or get_order later). Check the order with
    paypal.authorized_in_full against the campaign's amount, currency and custom_id before counting it."""
    facts = summarize_authorization(order)
    return Pledge(
        id=pledge_id,
        amount=facts["amount"] or "",
        currency=facts["currency"] or "",
        status=FROM_AUTHORIZATION.get(facts["authorization_status"] or "", PledgeStatus.CREATED),
        order_id=facts["order_id"],
        payer_id=facts["payer_id"],
        authorization_id=facts["authorization_id"],
        authorized_at=parse_time(facts["created_at"]),
        expires_at=parse_time(facts["expiration_time"]),
    )


def closing_time(campaign: Campaign) -> datetime:
    """When the campaign stops taking pledges: the owner's early close, else the deadline."""
    if campaign.closed_at is not None and campaign.closed_at < campaign.deadline:
        return campaign.closed_at
    return campaign.deadline


def accepting(campaign: Campaign, now: datetime) -> bool:
    """Whether the campaign still takes pledges."""
    return campaign.status == CampaignStatus.OPEN and now < closing_time(campaign)


def hold_expires(pledge: Pledge) -> datetime | None:
    """When PayPal lets the pledge's hold go: its own expiry, else 29 days after the hold was placed."""
    if pledge.expires_at is not None:
        return pledge.expires_at
    return pledge.authorized_at + AUTHORIZATION_PERIOD if pledge.authorized_at is not None else None


def lapsed(pledge: Pledge, moment: datetime) -> bool:
    """Whether the pledge's hold has run out by `moment`."""
    expires = hold_expires(pledge)
    return expires is not None and moment >= expires


def needs_reauthorization(pledge: Pledge, now: datetime) -> bool:
    """Whether to renew a hold before capturing it: it is past its 3-day honor period, still within its 29 days, and
    was never renewed (PayPal allows one renewal, from day 4 to day 29). An unknown age counts as past the honor
    period: PayPal refuses a renewal that comes too soon, and the hold is then captured as it is."""
    if pledge.reauthorization_id is not None or lapsed(pledge, now):
        return False
    return pledge.authorized_at is None or now >= pledge.authorized_at + HONOR_PERIOD


def progress(campaign: Campaign, pledges: Iterable[Pledge], now: datetime | None = None) -> dict:
    """How far a campaign has come: pledges by status, supporters, the money held or collected and whether the goal is
    met. Supporters are distinct PayPal payers, so a second pledge from one person does not count twice. With `now`,
    this is the progress at that moment: holds that ran out by then count as expired, and later pledges not at all."""
    counts: Counter[str] = Counter()
    held: list[Pledge] = []
    for pledge in pledges:
        status = pledge.status
        if status == PledgeStatus.AUTHORIZED and now is not None:
            if pledge.authorized_at is not None and pledge.authorized_at > now:
                continue
            if lapsed(pledge, now):
                status = PledgeStatus.EXPIRED
        counts[str(status)] += 1
        if status in (PledgeStatus.AUTHORIZED, PledgeStatus.CAPTURED) and pledge.currency == campaign.currency:
            held.append(pledge)
    supporters = _supporters(held)
    total = sum((_amount(pledge.amount) for pledge in held), Decimal(0))
    return {
        "counts": {status.value: counts[status.value] for status in PledgeStatus},
        "pledges": len(held),
        "supporters": supporters,
        "goal": campaign.goal,
        "remaining": max(0, campaign.goal - supporters),
        "percent": min(100, supporters * 100 // campaign.goal) if campaign.goal > 0 else 0,
        "total": _money_text(total, campaign.currency),
        "currency": campaign.currency,
        "funded": supporters >= campaign.goal,
    }


@dataclass(frozen=True)
class Action:
    """What a settlement does to one pledge: capture it, void it, or mark its hold expired (no PayPal call)."""

    kind: str  # "capture", "void" or "expire"
    pledge_id: str
    reauthorize: bool = False  # renew the hold first: it is past PayPal's 3-day honor period
    reason: str = ""


def decide(campaign: Campaign, pledges: Iterable[Pledge], now: datetime) -> list[Action]:
    """What to do with each held pledge now.

    While the campaign is open and before its deadline, nothing happens but marking holds that ran out. Once the owner
    closes it or the deadline passes, a campaign funded at that moment captures every hold (renewing those past their
    honor period first) and one short of its goal voids them all; holds that ran out before the close are marked
    expired, and PayPal has the last word on any that ran out since. Funded means the decision the campaign stores
    (decide_funding), else the holds that were valid at the close (funded_at_close): money collected outside settlement
    is no leave to collect the rest, and is flagged for refund when the campaign fell short. A funded campaign keeps
    collecting, holds placed after the close are released, and a settled campaign releases any hold left over.
    """
    pledges = list(pledges)
    held = [pledge for pledge in pledges if pledge.status == PledgeStatus.AUTHORIZED]
    if campaign.status in FINAL:
        return [Action("void", pledge.id, reason="The campaign is settled; a hold left over is released.") for pledge in held]
    close = closing_time(campaign)
    if campaign.status == CampaignStatus.OPEN and now < close:
        return [Action("expire", pledge.id, reason="Its hold ran out.") for pledge in held if lapsed(pledge, now)]
    collecting = _collecting(campaign, pledges)
    actions = []
    for pledge in held:
        if lapsed(pledge, close):
            actions.append(Action("expire", pledge.id, reason="Its hold ran out before the campaign closed."))
        elif pledge.authorized_at is not None and pledge.authorized_at > close:
            actions.append(Action("void", pledge.id, reason="It came after the campaign closed."))
        elif collecting:
            actions.append(Action("capture", pledge.id, needs_reauthorization(pledge, now), "The campaign reached its goal."))
        else:
            actions.append(Action("void", pledge.id, reason="The campaign closed short of its goal."))
    return actions


def funded_at_close(campaign: Campaign, pledges: Iterable[Pledge]) -> bool:
    """Whether the campaign had met its goal when it closed, counting only the holds that were valid then: placed by
    the close and not run out at it, whatever became of them since (still held, collected, or refused at collection).
    Released and declined pledges never count, nor does money collected from a hold that was not valid at the close."""
    close = closing_time(campaign)
    valid = [
        pledge for pledge in pledges
        if pledge.status in HELD_AT_CLOSE and pledge.currency == campaign.currency
        and not _late(pledge, close) and not lapsed(pledge, close)
    ]
    return _supporters(valid) >= campaign.goal


def decide_funding(campaign: Campaign, pledges: Iterable[Pledge], now: datetime) -> Campaign:
    """The campaign with the decision its close makes, taken once: from the moment it stops taking pledges, `funded` is
    True (and its status FUNDED) when it met its goal then (funded_at_close), False when it did not. The campaign comes
    back unchanged while it is still taking pledges, or once the decision is taken.

    For the HTTP routes: call this when a campaign has closed and store what it returns (`funded`, and the status)
    BEFORE calling settle(), or pass settle() a `record` function that stores it. settle() then acts on the stored
    decision every time, so a settlement cut short by a crash resumes collecting, and later changes to the pledges
    (a capture made outside settlement, a hold PayPal voids) never turn a funded campaign into one that releases the
    holds it has not collected yet, or the reverse. A campaign stored without a decision reads it from its status:
    funded, partial and collected ones were funded; expired and cancelled ones were not.
    """
    if campaign.funded is not None:
        return campaign
    if campaign.status in COLLECTING or campaign.status == CampaignStatus.COLLECTED:
        return replace(campaign, funded=True)
    if campaign.status in (CampaignStatus.EXPIRED, CampaignStatus.CANCELLED):
        return replace(campaign, funded=False)
    if campaign.status != CampaignStatus.OPEN or now < closing_time(campaign):
        return campaign
    if funded_at_close(campaign, pledges):
        return replace(campaign, funded=True, status=CampaignStatus.FUNDED)
    return replace(campaign, funded=False)


def _collecting(campaign: Campaign, pledges: list[Pledge]) -> bool:
    """Whether a closed campaign collects: the decision it stores, else whether it was funded when it closed."""
    if campaign.funded is not None:
        return campaign.funded
    return campaign.status in COLLECTING or funded_at_close(campaign, pledges)


def _supporters(pledges: Iterable[Pledge]) -> int:
    """Distinct PayPal payers: a second pledge from one person does not count twice."""
    return len({pledge.payer_id or f"pledge:{pledge.id}" for pledge in pledges})


def _late(pledge: Pledge, close: datetime) -> bool:
    return pledge.authorized_at is not None and pledge.authorized_at > close


def _amount(value: object) -> Decimal:
    try:
        amount = decimal_amount(value)
    except (TypeError, ValueError):
        return Decimal(0)
    return amount if amount.is_finite() else Decimal(0)


def _money_text(amount: Decimal, currency: str) -> str:
    return str(amount.quantize(Decimal(1) if currency.upper() in ZERO_DECIMAL else Decimal("0.01")))


# Settlement


@dataclass(frozen=True)
class Outcome:
    """What became of one pledge in a settlement."""

    pledge_id: str
    action: str  # "capture", "void" or "expire"
    status: str  # the pledge's status now
    authorization_id: str | None = None  # the hold captured or voided (the renewed one after a reauthorization)
    capture_id: str | None = None
    capture_status: str | None = None  # COMPLETED, or PENDING while PayPal reviews the payment
    net_amount: str | None = None  # the capture's net, after PayPal's fee, once PayPal gives it
    reauthorized: bool = False
    error: str | None = None  # PayPal's issue code, or a short reason
    temporary: bool = False  # PayPal or the network failed: the next settlement tries again


@dataclass(frozen=True)
class Settlement:
    """What a settlement did. Nothing is stored here: store the campaign and the pledges it returns."""

    campaign: Campaign  # with its new status
    pledges: list[Pledge]  # every pledge, as it is now
    outcomes: list[Outcome]  # one for each action taken
    reasons: list[str]  # what did not go to plan, in plain words; empty when everything did
    progress: dict


async def settle(
    campaign: Campaign, pledges: Iterable[Pledge], client: PayPalClient, now: datetime, *, concurrency: int = 4,
    record: Callable[[Campaign], Awaitable[Any]] | None = None,
) -> Settlement:
    """Carries out decide() with PayPal and reports what became of each pledge and of the campaign.

    Run it as soon as the campaign closes, and again while it is not settled: the longest campaign leaves
    SETTLEMENT_MARGIN between its deadline and the moment its first holds run out. A closed campaign without its
    funded decision gets it here (decide_funding), and the returned campaign carries it; `record`, when given, is
    awaited with that campaign before PayPal is called at all, so the caller stores the decision before the first
    capture (if it raises, nothing is collected). Requests carry stable PayPal-Request-Ids, so settling again after a
    crash or a timeout never acts twice, and PayPal's "already captured" and "already voided" answers count as done. A
    pledge that failed for a passing reason (network, rate limit, PayPal outage) stays authorized, and the next
    settlement tries it again. Run one settlement per campaign at a time.
    """
    pledges = list(pledges)
    by_id = {pledge.id: pledge for pledge in pledges}
    decided = decide_funding(campaign, pledges, now)
    if decided is not campaign and record is not None:
        await record(decided)
    campaign = decided
    collecting = _collecting(campaign, pledges)
    gate = asyncio.Semaphore(max(1, concurrency))

    async def run(action: Action) -> Outcome:
        pledge = by_id[action.pledge_id]
        async with gate:
            try:
                return await _carry_out(action, pledge, client)
            except Exception as exc:  # one broken pledge must not stop the others
                log.warning("Settling pledge %s failed", pledge.id, exc_info=True)
                return Outcome(pledge.id, action.kind, pledge.status, error=type(exc).__name__, temporary=True)

    outcomes = list(await asyncio.gather(*(run(action) for action in decide(campaign, pledges, now))))
    changed = {outcome.pledge_id: _apply(by_id[outcome.pledge_id], outcome, now) for outcome in outcomes}
    after = [changed.get(pledge.id, pledge) for pledge in pledges]
    settled = replace(campaign, status=_status_after(campaign, after, collecting, now))
    return Settlement(settled, after, outcomes, _reasons(settled, after, outcomes), progress(settled, after, now))


async def _carry_out(action: Action, pledge: Pledge, client: PayPalClient) -> Outcome:
    if action.kind == "expire":
        return Outcome(pledge.id, "expire", PledgeStatus.EXPIRED, authorization_id=pledge.authorization_id)
    if action.kind == "void":
        return await _void(pledge, client)
    return await _capture(pledge, action.reauthorize, client)


async def _capture(pledge: Pledge, reauthorize: bool, client: PayPalClient) -> Outcome:
    """Collects one hold, renewing it first when it is past its honor period. If PayPal will not renew it (too soon,
    not for this payment method, declined), the hold is captured as it is."""
    original = pledge.authorization_id
    if not original:
        return Outcome(pledge.id, "capture", PledgeStatus.FAILED, error="NO_AUTHORIZATION")
    target, renewed = pledge.reauthorization_id or original, False

    def outcome(status: str, **fields: Any) -> Outcome:
        return Outcome(pledge.id, "capture", status, authorization_id=target, reauthorized=renewed, **fields)

    if reauthorize and pledge.reauthorization_id is None:
        try:
            answer = await client.reauthorize_authorization(
                original, request_key("reauthorize", original), pledge.amount, currency=pledge.currency
            )
        except PayPalError as exc:
            if exc.has(*CAPTURED_ISSUES, *VOIDED_ISSUES, "AUTHORIZATION_EXPIRED", "AUTHORIZATION_DENIED"):
                return await _refused(exc, pledge, client, outcome)
            if _temporary(exc):
                return outcome(PledgeStatus.AUTHORIZED, error=_code(exc), temporary=True)
            log.info("PayPal did not renew hold %s (%s); capturing it as it is", original, _code(exc))
        else:
            if isinstance(answer.get("id"), str) and answer["id"]:
                target, renewed = answer["id"], True
    try:
        capture = await client.capture_authorization(
            target, request_key("capture", target), pledge.amount, currency=pledge.currency
        )
    except PayPalError as exc:
        if _temporary(exc):
            return outcome(PledgeStatus.AUTHORIZED, error=_code(exc), temporary=True)
        return await _refused(exc, pledge, client, outcome)
    state = capture.get("status")
    if state in ("DECLINED", "FAILED"):
        return outcome(PledgeStatus.FAILED, capture_id=capture.get("id"), capture_status=state, error=state)
    net = net_amount(capture)
    return outcome(
        PledgeStatus.CAPTURED, capture_id=capture.get("id"), capture_status=state,
        net_amount=net[0] if net and net[1] == pledge.currency else None,
    )


async def _refused(
    exc: PayPalError, pledge: Pledge, client: PayPalClient, outcome: Callable[..., Outcome],
) -> Outcome:
    """A capture PayPal turned down: already captured counts as done, anything else fails the pledge."""
    if exc.has(*CAPTURED_ISSUES):
        return outcome(PledgeStatus.CAPTURED, capture_id=await _find_capture(pledge, client))
    return outcome(PledgeStatus.FAILED, error=_code(exc))


async def _void(pledge: Pledge, client: PayPalClient) -> Outcome:
    """Releases one hold. The void goes to the original authorization: PayPal cannot void a reauthorization."""
    original = pledge.authorization_id
    if not original:
        return Outcome(pledge.id, "void", PledgeStatus.VOIDED, error="NO_AUTHORIZATION")
    try:
        await client.void_authorization(original, request_key("void", original))
    except PayPalError as exc:
        if exc.has(*VOIDED_ISSUES):
            return Outcome(pledge.id, "void", PledgeStatus.VOIDED, authorization_id=original)
        if exc.has("AUTHORIZATION_EXPIRED"):
            return Outcome(pledge.id, "void", PledgeStatus.EXPIRED, authorization_id=original)
        if exc.has(*CAPTURED_ISSUES):
            return Outcome(
                pledge.id, "void", PledgeStatus.CAPTURED, authorization_id=original,
                capture_id=await _find_capture(pledge, client), error="PREVIOUSLY_CAPTURED",
            )
        # The hold stays on record, so the next settlement tries to release it again.
        return Outcome(
            pledge.id, "void", PledgeStatus.AUTHORIZED, authorization_id=original, error=_code(exc),
            temporary=_temporary(exc),
        )
    return Outcome(pledge.id, "void", PledgeStatus.VOIDED, authorization_id=original)


async def _find_capture(pledge: Pledge, client: PayPalClient) -> str | None:
    """The capture PayPal already made of this pledge's hold, read from its order (best effort)."""
    if not pledge.order_id:
        return None
    try:
        order = await client.get_order(pledge.order_id)
    except (PayPalError, ValueError):
        return None
    return capture_from(order, {pledge.authorization_id, pledge.reauthorization_id} - {None})


def _temporary(exc: PayPalError) -> bool:
    """Failures that are no fault of the supporter's: the network, PayPal, rate limits, or the app's own credentials."""
    return exc.retryable or exc.status in (401, 403)


def _code(exc: PayPalError) -> str:
    return exc.issues[0] if exc.issues else exc.name


def _apply(pledge: Pledge, outcome: Outcome, now: datetime) -> Pledge:
    changes: dict[str, Any] = {"status": outcome.status, "error": outcome.error}
    if outcome.capture_id:
        changes["capture_id"] = outcome.capture_id
    if outcome.capture_status:
        changes["capture_status"] = outcome.capture_status
    if outcome.net_amount is not None:
        changes["net_amount"] = outcome.net_amount
    if outcome.reauthorized and outcome.authorization_id:
        changes["reauthorization_id"] = outcome.authorization_id
        changes["reauthorized_at"] = now
    return replace(pledge, **changes)


def _status_after(campaign: Campaign, pledges: list[Pledge], collecting: bool, now: datetime) -> str:
    if campaign.status in FINAL:
        return campaign.status
    close = closing_time(campaign)
    if campaign.status == CampaignStatus.OPEN and now < close:
        return CampaignStatus.OPEN
    if collecting:
        unfinished = any(
            pledge.status == PledgeStatus.FAILED or (pledge.status == PledgeStatus.AUTHORIZED and not _late(pledge, close))
            for pledge in pledges
        )
        return CampaignStatus.PARTIAL if unfinished else CampaignStatus.COLLECTED
    early = campaign.closed_at is not None and campaign.closed_at < campaign.deadline
    return CampaignStatus.CANCELLED if early else CampaignStatus.EXPIRED


def _reasons(campaign: Campaign, pledges: list[Pledge], outcomes: list[Outcome]) -> list[str]:
    """What did not go to plan, in plain words for the owner."""
    if campaign.status == CampaignStatus.OPEN:
        return []
    close = closing_time(campaign)
    lines: list[str] = []
    if campaign.status in (CampaignStatus.COLLECTED, *COLLECTING):
        failed = Counter(pledge.error or "FAILED" for pledge in pledges if pledge.status == PledgeStatus.FAILED)
        for code, count in sorted(failed.items()):
            lines.append(f"{_count(count, 'pledge')} could not be collected: {_issue(code)}.")
        waiting = [p for p in pledges if p.status == PledgeStatus.AUTHORIZED and not _late(p, close)]
        if waiting:
            lines.append(
                f"{_count(len(waiting), 'pledge')} {_is(len(waiting))} not collected yet ({_errors(waiting)}); "
                "the next settlement tries again."
            )
        pending = sum(1 for outcome in outcomes if outcome.capture_status == "PENDING")
        if pending:
            lines.append(
                f"{_count(pending, 'payment')} {_is(pending)} pending at PayPal, which completes or denies "
                f"{'it' if pending == 1 else 'them'} later."
            )
        unreleased = [p for p in pledges if p.status == PledgeStatus.AUTHORIZED and _late(p, close)]
    else:
        collected = [p for p in pledges if p.status == PledgeStatus.CAPTURED]
        if collected:
            one = len(collected) == 1
            lines.append(
                f"{_count(len(collected), 'pledge')} {'was' if one else 'were'} collected although the campaign fell "
                f"short of its goal: refund {'it' if one else 'them'} ({', '.join(p.capture_id or p.id for p in collected)})."
            )
        unreleased = [p for p in pledges if p.status == PledgeStatus.AUTHORIZED]
    if unreleased:
        lines.append(
            f"{_count(len(unreleased), 'hold')} {_is(len(unreleased))} not released yet ({_errors(unreleased)}); "
            "the next settlement tries again."
        )
    return lines


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"


def _is(number: int) -> str:
    return "is" if number == 1 else "are"


def _errors(pledges: list[Pledge]) -> str:
    return ", ".join(sorted({pledge.error or "no answer yet" for pledge in pledges}))


def _issue(code: str) -> str:
    text = ISSUE_TEXT.get(code)
    return f"{text} ({code})" if text else code


# The campaign's pitch

TITLE_LIMIT, PITCH_LIMIT, PERK_LIMIT, MAX_PERKS = 60, 300, 80, 4
MAX_EVIDENCE = 3
# Seconds the owner waits for the model's draft before the evidence rules write it instead.
DRAFT_WAIT_S = 30.0
# Claims that are evidence, strongest first; a "promise" claim is the owner's to make, so the pitch never makes it.
EVIDENCE_CLAIMS = ("only", "new", "closer")
MONTHS = (
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
    "December",
)
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
CURRENCY_SIGNS = {"USD": "$", "EUR": "€", "GBP": "£"}

OFFER_SYSTEM = """You write the page of a founding-supporter campaign. Neighbors pledge a fixed amount to a business
planned for an empty storefront near them; PayPal holds each pledge and collects it only if enough neighbors pledge by
the deadline. The owner set the amount, the goal, the deadline and any perk line (owner_terms); you only write words.
Ground every line in the input: the business, what it offers, the evidence and who it is for.
Name no business other than this one, and no person, artist, band, brand, show or podcast. Use no number that is not
in the input, and state no price or amount but owner_terms.pledge. Write "only", "first", "no other" or "nowhere else"
only when the evidence has a claim of kind "only", and add no superlative ("best", "famous", "#1").
Promise no discount, free item, credit or deal unless owner_terms.perk states it, and then say it exactly as the owner
did. Do not explain how the payment works: the page adds that.
Return JSON with keys: title (at most 60 characters), pitch (two or three sentences to neighbors, at most 300
characters) and perks (2 to 4 items of at most 80 characters: what founding supporters get beyond the pledge itself,
such as their name on a founders' wall, an invitation to the opening or the first taste of a signature item)."""

# Numbers in digits ("1,200", "2.5") and in words that state a quantity. "One" alone is left out ("the one place").
DIGITS = re.compile(r"\d[\d,]*(?:\.\d+)?")
UNITS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
NUMBER_WORDS = {
    **{word: value for word, value in UNITS.items() if word != "one"},
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "dozen": 12, "dozens": 12, "hundred": 100, "hundreds": 100,
    "thousand": 1000, "thousands": 1000,
}
NUMBER_WORD = re.compile(
    rf"\b(?:({'|'.join(TENS)})(?:[- ]({'|'.join(UNITS)}))?|({'|'.join(NUMBER_WORDS)}))\b", re.IGNORECASE
)
# Price promises: percentages, discounts, freebies, credits, deals and savings ("gluten-free" is not one).
DISCOUNT = re.compile(
    r"\d\s*%|\bper\s?cent\b|\bdiscount|\bcoupons?\b|\bvouchers?\b|\bpromo(?:tion|tional|s)?\b|\bdeals?\b|\bbargains?\b|"
    r"\bcheaper\b|\b(?:half|reduced|special|lower|best|members?|founders?'?|founding|early[- ]bird)[- ]prices?\b|"
    r"\bearly[- ]bird\b|(?<![-\w])free\b(?!-)|\bcomplimentary\b|\bon the house\b|\bgratis\b|\bbogo\b|"
    r"\b(?:2|two)[- ]for[- ](?:1|one)\b|\bbuy one\b|\bcash ?back\b|\brebates?\b|\bcredits?\b(?!\s*cards?)|"
    r"\bsav(?:e|es|ing)\s+(?:\$|€|£|\d|up\s+to|money|on)|\bsavings\b|\$\s?\d[\d.,]*\s+off\b|\d\s*%\s*off\b|\bhalf[- ]off\b|"
    r"\bon sale\b|\boff\s+(?:your|every|each|all|any|the\s+(?:first|bill|menu|price))\b|\blifetime\b|\bfor life\b",
    re.IGNORECASE,
)
# Money in a line: a currency sign with or without a figure ("$25", "$$$"), or a figure in a currency's name.
PRICE = re.compile(
    r"[$€£¢]+\s?(\d[\d,]*(?:\.\d+)?)?|\b(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks?|cents?|euros?|pounds?|usd|eur|gbp|egp)\b",
    re.IGNORECASE,
)
# Claims of being the only one ("unique" included) or the first, which only an "only" claim in the evidence supports.
# "Only if", "only 20" and "a first taste" or "the first to pledge" claim nothing.
EXCLUSIVE = re.compile(
    r"(?<!\bnot )(?<!\bif )\bonly\b(?!\s+(?:if|when|once|after|until|unless|while|by|pay|charged|collected|held|takes?|"
    r"needs?|asks?|a few|a handful|a couple|" + "|".join([*TENS, *NUMBER_WORDS]) + r")\b|\s+\d)|"
    r"\bno other\b|\bnowhere else\b|\bno ?one else\b|\bnobody else\b|\bthe sole\b|\bone[- ]of[- ]a[- ]kind\b|\bunique\b|"
    r"\bfirst[- ](?:ever|of[- ]its[- ]kind)\b|"
    r"\b(?:the|our|its|their|this|a)\s+(?:very\s+)?first\b(?!\s+\d|\s+(?:tastes?|looks?|bites?|sips?|visits?|orders?|round|"
    r"times?|years?|months?|weeks?|days?|nights?|weekends?|batch|dibs|supporters?|backers?|founders?|neighbou?rs?|"
    r"customers?|guests?|people|ones?|to\s+(?:back|pledge|support|join|try|taste|know|hear|see|visit|sit|order))\b)",
    re.IGNORECASE,
)
LINK = re.compile(r"https?://|\bwww\.|@\w|\b[\w-]+\.(?:com|org|net|io|co|app|shop)\b", re.IGNORECASE)
# Data caveats among a concept's why-here lines: true, but no reason for a neighbor to pledge.
CAVEAT = re.compile(r"^\s*(?:thin evidence|not cross-checked)|comparison is weak", re.IGNORECASE)
# Words a campaign page may capitalize that name nobody: its own terms, PayPal, months and weekdays.
CAMPAIGN_WORDS = frozenset({
    "i", "paypal", "founding", "founders", "founder", "supporters", "supporter", "wall", "opening", "night", "day",
    "grand", "launch", "party", "team", "menu", "neighbors", "neighbours", "club", "list", "members", "member", "friends",
    "family", "chef", "kitchen", "first", "taste", "early", *(month.lower() for month in MONTHS),
    *(day.lower() for day in WEEKDAYS),
})
# Words that say no more than "pledge" and how it works. A perk made of them, the pledge's amount and the business's
# own names offers supporters nothing beyond the pledge itself ("$25 pledge", "Pledge $25", "A $25 contribution").
PLEDGE_WORDS = frozenset({
    "pledge", "pledges", "pledged", "pledging", "contribution", "contributions", "contribute", "contributes",
    "contributed", "contributing", "donation", "donations", "donate", "donated", "donating", "deposit", "payment",
    "pay", "pays", "paid", "paying", "amount", "hold", "holds", "held", "charge", "charges", "charged", "fund", "funds",
    "funded", "funding", "commitment", "commit", "chip", "back", "backs", "backed", "backing", "backer", "backers",
    "support", "supports", "supported", "supporting", "supporter", "supporters", "founding", "founder", "founders",
    "status", "join", "joins", "joining", "neighbor", "neighbors", "neighbour", "neighbours", "paypal", "money",
    "dollar", "dollars", "usd", "us", "bucks", "cents", "help", "helps", "helping", "open", "opening", "goal",
    "campaign", "reach", "reaches", "reached", "meet", "meets", "met", "if", "unless", "only", "once", "one", "time",
    "single", "simple", "just", "become", "becoming", "be", "being", "a", "an", "and", "as", "at", "by", "for", "from",
    "in", "into", "it", "its", "my", "of", "on", "our", "that", "this", "to", "toward", "towards", "we", "with", "you",
    "your",
})


@dataclass(frozen=True)
class OfferRules:
    """What the pitch may say: numbers from its inputs only, the pledge as its only price, none of the inputs' real
    names nor names they do not give, "only" or "first" only with an "only" claim, and a deal only in the owner's perk."""

    numbers: frozenset[str]
    names: tuple[str, ...]
    allowed: tuple[str, ...] = ()  # the business's own name and its neighborhoods, never taken for someone else's
    perk: str | None = None  # the owner's perk line, which alone may promise a discount
    amount: str = ""  # the pledge ("25.00"), the only amount a line may state
    exclusive: bool = False  # whether the evidence has an "only" claim
    vocabulary: frozenset[str] = frozenset()  # every word of the inputs: a capitalized word outside it names someone
    walk: bool = True  # whether the area is a walk; beside a drive, no line may say the place is a walk away


def offer_problem(text: object, limit: int, rules: OfferRules) -> str | None:
    """Why a line of the pitch cannot be used, or None when it can. A line that mentions a discount must state the
    owner's perk, word for word, and add none of its own; the figures and the deal in the perk are the owner's."""
    if not isinstance(text, str) or not text.strip():
        return "is empty"
    text = " ".join(text.split())
    if len(text) > limit:
        return f"is longer than {limit} characters"
    rest = _without_perk(text, rules.perk)
    name = named(text, rules.names, rules.allowed) or _invented_name(rest, rules)
    if name:
        return f"names {name}"
    stray = next((number for number in numbers_in(text) if number not in rules.numbers), None)
    if stray:
        return f"states {stray}, a number the inputs do not have"
    price = _stray_price(rest, rules.amount)
    if price:
        return f"states the price {price}: the pledge is the only amount the page gives"
    if LINK.search(text):
        return "has a link"
    claim = EXCLUSIVE.search(rest)
    if claim and not rules.exclusive:
        return f'says "{claim.group(0)}", which the evidence does not show'
    superlative = SUPERLATIVE.search(rest)
    if superlative:
        return f'says "{superlative.group(0)}", which nothing measured proves'
    if not rules.walk and WALKING.search(rest):
        return "says the place is a walk away, but the area is a drive"
    if DISCOUNT.search(text):
        if not rules.perk:
            return "promises a discount the owner did not set"
        if _changes_discount(text, rules.perk):
            return "changes the perk the owner set"
    return None


RESTATES = "only restates the pledge: say what founding supporters get beyond it"


def restates_pledge(text: object, amount: object, names: Iterable[str] = ()) -> bool:
    """Whether a perk only restates the pledge ("$25 pledge", "Pledge $25", "A $25 contribution", "Back the café with
    $25"): nothing is left of it once the pledge's amount, the words for pledging and the business's own `names` are
    taken out, so it offers supporters nothing beyond the pledge itself."""
    if not isinstance(text, str) or not re.search(r"[^\W_]", text):
        return False
    pledge = _plain(str(amount)) if amount is not None else ""

    def figure(found: re.Match) -> str:
        return " " if pledge and _plain(found.group().rstrip(",").replace(",", "")) == pledge else found.group()

    def word(found: re.Match) -> str:
        return " " if pledge and _word_number(found) == pledge else found.group()

    words = _phrase(NUMBER_WORD.sub(word, DIGITS.sub(figure, text)))
    for name in {_phrase(item).strip() for item in names if isinstance(item, str)} - {""}:
        words = re.sub(rf"(?<= ){re.escape(name)}(?= )", "", words)
    return all(token in PLEDGE_WORDS for token in words.split())


def _without_perk(text: str, perk: str | None) -> str:
    """The line without the owner's perk, where it states it word for word: the perk's figures and deal are theirs."""
    if not perk:
        return text
    own = re.escape(" ".join(perk.split()).rstrip(".!?,;: "))
    return re.sub(rf"(?<!\w){own}(?!\w)", " ", text, flags=re.IGNORECASE) if own else text


def _stray_price(text: str, amount: str) -> str | None:
    """The first amount of money a line states that is not the pledge ("$10", "$$$"), or None."""
    pledge = _plain(amount) if amount else ""
    for match in PRICE.finditer(text):
        figure = match.group(1) or match.group(2)
        if not figure or not pledge or _plain(figure.replace(",", "")) != pledge:
            return match.group(0).strip().rstrip(",")
    return None


def _invented_name(text: str, rules: OfferRules) -> str | None:
    """A capitalized word inside a sentence that no input gives and no campaign page needs, such as a person's name the
    model made up; None in Title Case, where capitals name nothing."""
    if not rules.vocabulary:
        return None
    words = text.split()
    significant = [word for word in words if len(re.sub(r"\W", "", word)) >= 4]
    if len(words) >= 3 and significant and all(word[:1].isupper() for word in significant):
        return None
    for sentence in re.split(r"(?<=[.!?:;])\s+|\s+[-–—]+\s+|[\"“”(]", text):
        for index, token in enumerate(re.findall(r"[^\W_][\w'’&-]*", sentence)):
            if index == 0 or not token[:1].isupper():
                continue
            word = re.sub(r"['’]s$", "", token.lower()).strip("'’-&")
            if not word or word in rules.vocabulary or word in CAMPAIGN_WORDS or word.isdigit():
                continue
            if NATIONAL.match(token) or token in PROPER_WORDS:
                continue
            return token
    return None


def _changes_discount(text: str, discount: str) -> bool:
    """Whether a line that mentions a discount says anything but the owner's own, word for word: a line without it
    ('half off', '$10 off') changes it, and so does one that adds to it ('…, for life')."""
    said, own = _wording(text), _wording(discount).rstrip(".!?,;: ")
    found = re.search(rf"(?<!\w){re.escape(own)}(?!\w)", said) if own else None
    return found is None or bool(DISCOUNT.search(f"{said[:found.start()]} {said[found.end():]}"))


def _wording(text: str) -> str:
    return " ".join(text.lower().replace("’", "'").split())


def numbers_in(text: str) -> list[str]:
    """The numbers a text states, in digits or words, written plainly: '25.00' and 'twenty-five' are both '25'."""
    found = [_plain(match.group().rstrip(",").replace(",", "")) for match in DIGITS.finditer(text)]
    found += [_word_number(match) for match in NUMBER_WORD.finditer(text)]
    return [number for number in found if number]


def _word_number(match: re.Match) -> str:
    """A NUMBER_WORD match as a number: 'twenty-five' -> '25'."""
    tens, unit, word = match.groups()
    return str(TENS[tens.lower()] + (UNITS[unit.lower()] if unit else 0) if tens else NUMBER_WORDS[word.lower()])


def named(text: str, names: Iterable[str], allowed: Iterable[str] = ()) -> str | None:
    """The first of `names` that `text` mentions as a whole phrase. A mention inside one of the `allowed` phrases (the
    business's own name, its neighborhoods) is theirs, but one reaching beyond them is the name: 'Holly' is a
    neighborhood, 'Holly Hardware' a store. Names that are one common word ("Bakery") are anyone's to use."""
    words = _phrase(text)
    own = [span for phrase in {_phrase(item).strip() for item in allowed if item} if phrase for span in _spans(phrase, words)]
    for name in names:
        tokens = _phrase(name).split()
        if not tokens or len("".join(tokens)) < 3 or (len(tokens) == 1 and tokens[0] in COMMON_NAME_WORDS):
            continue
        for start, end in _spans(" ".join(tokens), words):
            if not any(low <= start and end <= high for low, high in own):
                return name
    return None


def _spans(phrase: str, words: str) -> list[tuple[int, int]]:
    """Where a phrase stands, whole, among _phrase's words."""
    return [match.span() for match in re.finditer(rf"(?<= ){re.escape(phrase)}(?= )", words)]


def _phrase(text: str) -> str:
    """Lowercase words between spaces, for whole-phrase matching: "Joe's Bakery & Co" reads " joe bakery and co "."""
    text = re.sub(r"'s\b", "", text.lower().replace("’", "'").replace("&", " and ")).replace("'", "")
    return " " + " ".join(word for word in re.findall(r"[^\W_]+", text) if word != "the") + " "


def _plain(raw: str) -> str:
    try:
        return format(Decimal(raw).normalize(), "f")
    except InvalidOperation:
        return ""


def evidence_lines(concept: Mapping[str, Any], claims: Iterable[Mapping[str, Any]], limit: int = MAX_EVIDENCE) -> list[str]:
    """Up to `limit` lines from the survey that say why this business and why here, for the campaign page: its
    strongest evidence claim (an "only", else an item new to the area, else "closer"), then the concept's why-here
    lines, without the caveats about the data. Every line is the survey's own, checked when the survey wrote it."""
    found = [claim for claim in claims if isinstance(claim, Mapping) and isinstance(claim.get("line"), str)]
    lead = next((claim for kind in EVIDENCE_CLAIMS for claim in found if claim.get("kind") == kind), None)
    lines = [_sentence_of(lead["line"])] if lead else []
    lines += [" ".join(line.split()) for line in _strings(concept.get("why_here")) if line.strip() and not CAVEAT.search(line)]
    return list(dict.fromkeys(line for line in lines if line))[:limit]


def _sentence_of(text: str) -> str:
    text = " ".join(text.split())
    return text if not text or text.endswith((".", "!", "?")) else f"{text}."


def how_it_works(amount: str | Decimal, goal: int, deadline: datetime, currency: str = "USD") -> str:
    """The hold in fixed words, never the model's."""
    code = currency.upper()
    pledge = _amount_text(money(amount, code), code)
    return (
        f"Pledge {pledge}. PayPal only holds it: it is collected if {goal} supporters pledge by {_date_text(deadline)}, "
        f"and released if not, so nobody pays unless the goal is met."
    )


async def draft_offer(
    llm: LLM | None,
    design: Mapping[str, Any],
    *,
    amount: str | Decimal,
    goal: int,
    deadline: datetime,
    currency: str = "USD",
    perk: str | None = None,
    launch: Mapping[str, Any] | None = None,
    concept: Mapping[str, Any] | None = None,
    claims: Iterable[Mapping[str, Any]] | None = None,
    place: str | None = None,
    avoid: Iterable[str] = (),
    answers: AnswerCache | None = None,
) -> dict:
    """The campaign's title, pitch and perks, written by the model from the concept's design sheet, the survey's
    evidence (the kit's `claims`, else the launch plan's) and its why-here lines. Any part that breaks a rule is
    replaced by the evidence rules' version, and so is all of it when no model answers.

    The owner's terms go in unchanged: the amount, the goal, the deadline and any founding-supporter `perk`, which
    leads the perks in the owner's own words. `place` is the site's label; `avoid` adds names the pitch must not use,
    such as every place the survey found. how_it_works explains the hold in fixed words, never the model's.
    """
    brief = _offer_brief(design, amount, goal, deadline, currency, perk, launch, concept, claims, place, avoid)
    payload, rules, perk = brief.payload, brief.rules, brief.perk

    draft: dict = {}
    model = None
    if llm is not None and llm.enabled:
        key = fingerprint("offer", OFFER_SYSTEM, payload)
        saved = answers.get("offer", key) if answers else None
        try:
            if saved:
                draft, model = saved.get("offer") or {}, saved.get("model")
            else:
                # The owner waits for the draft: a model that is slow or resting gives way to the rules' words.
                draft, model = await asyncio.wait_for(llm.complete_json(OFFER_SYSTEM, payload), DRAFT_WAIT_S)
                if draft and answers:
                    answers.put("offer", key, {"offer": draft, "model": model})
            draft = copy.deepcopy(draft) if isinstance(draft, dict) else {}
        except Exception:  # an AI outage must not keep the owner from launching a campaign
            log.warning("Offer LLM call failed; using evidence rules", exc_info=True)
            draft = {}

    kept, rejected = _checked(draft, rules, perk)
    fallback = _rule_offer(brief.name, brief.business, brief.evidence, brief.neighborhoods, goal, brief.when, perk, rules)
    return {
        "title": kept.get("title") or fallback["title"],
        "pitch": kept.get("pitch") or fallback["pitch"],
        "perks": (kept.get("perks") or fallback["perks"])[:MAX_PERKS],
        "how_it_works": how_it_works(amount, goal, deadline, currency),
        "mode": "agent" if kept else "rules",
        "model": model if kept else None,
        "rejected": rejected,
    }


def offer_problems(
    design: Mapping[str, Any],
    *,
    title: object,
    pitch: object,
    perks: object,
    amount: str | Decimal,
    goal: int,
    deadline: datetime,
    currency: str = "USD",
    perk: str | None = None,
    launch: Mapping[str, Any] | None = None,
    concept: Mapping[str, Any] | None = None,
    claims: Iterable[Mapping[str, Any]] | None = None,
    place: str | None = None,
    avoid: Iterable[str] = (),
) -> list[str]:
    """What is wrong with the owner's own title, pitch and perks for the campaign page, in plain words; an empty list
    when nothing is. They are checked by the rules draft_offer checks the model's words by, built from the same inputs
    (pass draft_offer's): no real name but the business's own and its neighborhoods and no name the inputs do not give,
    no number the inputs do not give, no price but the pledge, no "only" or "first" without an "only" claim, no
    superlative, no link, a discount only as the owner's perk says it, no perk that only restates the pledge, and the
    same lengths. The owner's perk may stand as a perk word for word, as draft_offer puts it first. For the HTTP route
    that saves an edited campaign page.
    """
    brief = _offer_brief(design, amount, goal, deadline, currency, perk, launch, concept, claims, place, avoid)
    problems = []
    for label, text, limit in (("The title", title, TITLE_LIMIT), ("The pitch", pitch, PITCH_LIMIT)):
        problem = offer_problem(text, limit, brief.rules)
        if problem:
            problems.append(f"{label} {problem}.")
    if not isinstance(perks, list) or not perks:
        return [*problems, f"Add 1 to {MAX_PERKS} perks."]
    for number, item in enumerate(perks, 1):
        own = brief.perk and isinstance(item, str) and " ".join(item.split()) == brief.perk
        problem = None if own else offer_problem(item, PERK_LIMIT, brief.rules)
        if problem is None and restates_pledge(item, brief.rules.amount, brief.rules.allowed):
            problem = RESTATES
        if problem:
            problems.append(f"Perk {number} {problem}.")
    if len(perks) > MAX_PERKS:
        problems.append(f"Keep at most {MAX_PERKS} perks.")
    return problems


@dataclass(frozen=True)
class _Brief:
    """What the pitch is written from, and the rules its words keep."""

    name: str
    amount_text: str
    when: str
    perk: str | None
    neighborhoods: list[str]
    business: dict
    evidence: list[dict]
    payload: str
    rules: OfferRules


def _offer_brief(
    design: Mapping[str, Any], amount: str | Decimal, goal: int, deadline: datetime, currency: str, perk: str | None,
    launch: Mapping[str, Any] | None, concept: Mapping[str, Any] | None, claims: Iterable[Mapping[str, Any]] | None,
    place: str | None, avoid: Iterable[str],
) -> _Brief:
    """The model's brief, from the design sheet, the survey's evidence and the owner's terms, without any real name but
    the business's own and its neighborhoods; the numbers and words it gives are the only ones the pitch may use."""
    code = currency.upper()
    pledge = money(amount, code)
    amount_text = _amount_text(pledge, code)
    when = _date_text(deadline)
    launch = launch if launch is not None else design.get("launch") or {}
    concept = concept or {}
    perk = " ".join(perk.split()) if perk and perk.strip() else None
    name = " ".join(str(design.get("name") or concept.get("name") or "").split())[:TITLE_LIMIT] or "This business"
    where = launch.get("where") or {}
    neighborhoods = [hood.strip() for hood in where.get("neighborhoods") or [] if isinstance(hood, str) and hood.strip()][:3]
    label = " ".join(place.split()) if isinstance(place, str) and place.strip() else None
    allowed = tuple(item for item in (name, *neighborhoods, label) if item)
    names = tuple(sorted(_real_names(design, launch, concept, avoid) - set(allowed)))
    claims = [claim for claim in (claims if claims is not None else launch.get("claims") or []) if isinstance(claim, Mapping)]

    def safe(value: object) -> str | None:
        text = " ".join(value.split()) if isinstance(value, str) else ""
        return text if text and not named(text, names, allowed) else None

    evidence: list[dict] = []
    for claim in claims:
        if claim.get("kind") in EVIDENCE_CLAIMS and safe(claim.get("line")):
            evidence.append({"kind": claim.get("kind"), "claim": safe(claim.get("line")), "proof": safe(claim.get("proof"))})
    evidence += [{"fact": fact} for fact in map(safe, [line for line in _strings(concept.get("why_here")) if not CAVEAT.search(line)][:3]) if fact]
    when_to_visit, audience = launch.get("when") or {}, launch.get("audience") or {}
    business = {
        "name": name,
        "kind": safe(concept.get("genre")),
        "tagline": safe(design.get("tagline")),
        "offer": [item for item in map(safe, _strings(design.get("offer"))) if item][:6],
        "signature": [item for item in map(safe, _strings(concept.get("signature"))) if item][:4],
        "hours": safe(design.get("hours")),
    }
    brief = _compact({
        "business": business,
        "place": {"label": label, "area": safe(where.get("label")), "neighborhoods": neighborhoods},
        "evidence": evidence,
        "who": {
            "crowd": [item for item in map(safe, _labels(audience.get("crowd"))) if item],
            "times": [item for item in map(safe, _labels(when_to_visit.get("times"))) if item],
            "reasons_to_visit": [item for item in map(safe, _labels(when_to_visit.get("intents"))) if item],
        },
        "owner_terms": {
            "pledge": amount_text, "supporters_needed": goal, "deadline": f"{when}, {deadline.year}", "perk": perk,
        },
    })
    payload = json.dumps(brief, ensure_ascii=False)
    vocabulary = frozenset(re.sub(r"['’]s$", "", word.lower()) for word in re.findall(r"[^\W_][\w'’-]*", payload))
    rules = OfferRules(
        numbers=frozenset(numbers_in(payload)), names=names, allowed=allowed, perk=perk, amount=pledge,
        exclusive=any(claim.get("kind") == "only" for claim in claims), vocabulary=vocabulary,
        walk=is_walk(str(where.get("label") or "")) if where.get("label") else True,
    )
    return _Brief(name, amount_text, when, perk, neighborhoods, business, evidence, payload, rules)


def _checked(draft: Mapping[str, Any], rules: OfferRules, perk: str | None) -> tuple[dict, list[dict]]:
    """The parts of the model's draft that keep the rules, and why the others were dropped."""
    kept: dict[str, Any] = {}
    rejected: list[dict] = []
    if not draft:
        return kept, rejected
    for field, limit in (("title", TITLE_LIMIT), ("pitch", PITCH_LIMIT)):
        text = draft.get(field)
        if isinstance(text, str) and field == "pitch":
            text = _fit(text, limit)
        problem = offer_problem(text, limit, rules)
        if problem:
            rejected.append({"field": field, "reason": problem})
        else:
            kept[field] = " ".join(str(text).split())
    perks: list[str] = []
    for item in draft.get("perks") if isinstance(draft.get("perks"), list) else []:
        problem = offer_problem(item, PERK_LIMIT, rules) or (RESTATES if restates_pledge(item, rules.amount, rules.allowed) else None)
        if problem:
            rejected.append({"field": "perks", "reason": problem})
            continue
        item = " ".join(item.split())
        # The owner's perk leads the perks in the owner's words; the model's version of it is dropped.
        if not (perk and DISCOUNT.search(item)) and item.lower() not in {p.lower() for p in perks}:
            perks.append(item)
    if perks:
        kept["perks"] = ([perk] if perk else []) + perks
    return kept, rejected


def _rule_offer(
    name: str, business: dict, evidence: list[dict], neighborhoods: list[str], goal: int, when: str,
    perk: str | None, rules: OfferRules,
) -> dict:
    """The pitch the evidence rules write: the business's own line, its strongest evidence and the ask."""
    title = next((t for t in (f"Be a founding supporter of {name}", f"Help open {name}") if len(t) <= TITLE_LIMIT), name)
    tagline = business.get("tagline")
    if tagline and not offer_problem(tagline, PITCH_LIMIT, rules):
        lead = tagline
    else:
        lead = f"{name} is planned for {neighborhoods[0]}." if neighborhoods else f"{name} is planned for a storefront near you."
    proof = next((e["claim"] for e in evidence if e.get("claim") and not offer_problem(e["claim"], PITCH_LIMIT, rules)), None)
    ask = f"Be one of the {goal} founding supporters it needs by {when}."
    pitch = next(
        (text for text in (_sentences(lead, proof, ask), _sentences(lead, ask), _sentences(proof, ask)) if len(text) <= PITCH_LIMIT),
        ask,
    )
    item = next(iter(business.get("signature") or business.get("offer") or []), None)
    perks = ["Your name on the founding supporters' wall", "An invitation to the opening night"]
    if item:
        perks.append(f"A first taste of {mid_sentence(item)}")
    perks = [line for line in perks if not offer_problem(line, PERK_LIMIT, rules)]
    return {"title": title, "pitch": pitch, "perks": ([perk] if perk else []) + perks}


def _real_names(design: Mapping[str, Any], launch: Mapping[str, Any], concept: Mapping[str, Any], avoid: Iterable[str]) -> set[str]:
    """Every real name in the inputs, for the pitch to leave out: places (partners, price anchors, places like it, the
    places that inspired it), artists, brands, shows and podcasts, and `avoid`."""
    found: set[str] = set()

    def take(value: object) -> None:
        if isinstance(value, str):
            found.add(value)
        elif isinstance(value, Mapping) and isinstance(value.get("name"), str):
            found.add(value["name"])
        elif isinstance(value, list | tuple | set | frozenset):
            for item in value:
                take(item)

    music = design.get("music")
    take(design.get("partners"))
    take(design.get("price_anchors"))
    take(music.get("artists") if isinstance(music, Mapping) else None)
    experience = design.get("experience")
    for section in experience.values() if isinstance(experience, Mapping) else []:
        if isinstance(section, list):
            take(section)
    audience = launch.get("audience") or {}
    for key in ("artists", "podcasts", "screen", "brands", "shared"):
        take(audience.get(key))
    take((launch.get("where") or {}).get("sites_like"))
    take(concept.get("inspired_by"))
    take(list(avoid))
    return {" ".join(item.split()) for item in found if item.strip()}


def _strings(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _labels(value: object) -> list[str]:
    items = value if isinstance(value, list) else []
    return [item["label"] for item in items if isinstance(item, Mapping) and isinstance(item.get("label"), str)][:3]


def _compact(value: Any) -> Any:
    """The value without empty fields, so the brief carries only what is known."""
    if isinstance(value, dict):
        pairs = ((key, _compact(item)) for key, item in value.items())
        return {key: item for key, item in pairs if item not in (None, "", [], {})}
    if isinstance(value, list):
        return [item for item in map(_compact, value) if item not in (None, "", [], {})]
    return value


def _fit(text: str, limit: int) -> str:
    """The text, or as many of its first whole sentences as fit in `limit` characters."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    kept = ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        candidate = f"{kept} {sentence}".strip()
        if len(candidate) > limit:
            break
        kept = candidate
    return kept or text


def _sentences(*parts: str | None) -> str:
    return " ".join(part if part.endswith((".", "!", "?")) else f"{part}." for part in (p.strip() for p in parts if p) if part)


def _amount_text(value: str, currency: str) -> str:
    sign = CURRENCY_SIGNS.get(currency)
    return f"{sign}{value}" if sign else f"{value} {currency}"


def _date_text(moment: datetime) -> str:
    return f"{MONTHS[moment.month - 1]} {moment.day}"
