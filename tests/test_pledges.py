"""Pledge campaigns: terms, progress, what to do with each hold, settlement with a fake PayPal, the AI pitch and the
rules its words and the owner's edits keep, and the evidence a campaign page shows."""
import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.answers import AnswerCache
from app.llm import LLM
from app.payments.paypal import AUTHORIZATION_PERIOD, PayPalClient, request_key
from app.payments.pledges import (
    LONGEST_CAMPAIGN,
    SETTLEMENT_MARGIN,
    Campaign,
    CampaignError,
    CampaignStatus,
    OfferRules,
    Pledge,
    PledgeStatus,
    accepting,
    decide,
    decide_funding,
    draft_offer,
    evidence_lines,
    funded_at_close,
    lapsed,
    named,
    needs_reauthorization,
    new_campaign,
    offer_problem,
    offer_problems,
    pledge_from_order,
    progress,
    restates_pledge,
    settle,
    validate_campaign,
)

API = "https://api-m.sandbox.paypal.com"
NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
AUTHORIZED, CAPTURED, VOIDED, EXPIRED, FAILED = (
    PledgeStatus.AUTHORIZED, PledgeStatus.CAPTURED, PledgeStatus.VOIDED, PledgeStatus.EXPIRED, PledgeStatus.FAILED,
)


def campaign(**changes) -> Campaign:
    """A campaign of 3 supporters at $25 whose deadline passed five minutes ago."""
    return replace(Campaign(id="c1", amount="25.00", goal=3, deadline=NOW - timedelta(minutes=5)), **changes)


def pledge(n: int, days_ago: float = 1, **changes) -> Pledge:
    """Supporter n's pledge, held `days_ago` days before NOW."""
    at = NOW - timedelta(days=days_ago)
    fields = {
        "id": f"p{n}", "amount": "25.00", "status": AUTHORIZED, "order_id": f"ORDER{n}", "payer_id": f"PAYER{n}",
        "authorization_id": f"AUTH{n}", "authorized_at": at, "expires_at": at + timedelta(days=29),
    }
    return Pledge(**{**fields, **changes})


def kinds(actions) -> list[tuple]:
    return [(action.kind, action.pledge_id, action.reauthorize) for action in actions]


def test_new_campaigns_keep_to_the_allowed_terms():
    assert validate_campaign("25", 50, NOW + timedelta(days=21), NOW) == []
    assert validate_campaign("5.00", 3, NOW + timedelta(days=1), NOW) == []
    assert validate_campaign("200", 500, NOW + timedelta(days=27), NOW, "usd") == []
    made = new_campaign("c9", "25", 50, NOW + timedelta(days=21), NOW, "usd")
    assert (made.amount, made.currency, made.status, made.goal, made.funded) == ("25.00", "USD", "open", 50, None)

    def problems(**changes) -> list[str]:
        terms = {"amount": "25", "goal": 50, "deadline": NOW + timedelta(days=21), "now": NOW, **changes}
        return validate_campaign(**terms)

    assert problems(amount="4.99") == ["The pledge must be from 5.00 to 200.00."]
    assert problems(amount="200.01") == ["The pledge must be from 5.00 to 200.00."]
    assert problems(amount=25.0) == ["The pledge must be from 5.00 to 200.00."]  # floats are not money
    assert problems(amount="twenty") == ["The pledge must be from 5.00 to 200.00."]
    assert problems(amount="25.005") == ["The pledge has more decimals than USD allows."]
    assert problems(goal=2) == problems(goal=501) == problems(goal=True) == ["The goal must be 3 to 500 supporters."]
    deadline = ("The deadline must be 1 to 27 days away: PayPal holds a pledge for 29 days, and the last 2 are kept "
                "for collecting it.")
    assert problems(deadline=NOW + timedelta(hours=23)) == [deadline]
    assert problems(deadline=NOW + timedelta(days=27, minutes=1)) == [deadline]
    assert problems(deadline=datetime(2026, 12, 1)) == ["The deadline needs a date, a time and a time zone."]
    assert problems(currency="US") == ["The currency must be a three-letter code, such as USD."]
    with pytest.raises(CampaignError) as error:
        new_campaign("c9", "1", 1, NOW + timedelta(days=40), NOW)
    assert len(error.value.problems) == 3


def test_the_longest_campaign_leaves_time_to_collect_its_first_pledges():
    # A hold lasts 29 days, so a 29-day campaign let its first holds run out before they could be collected.
    assert LONGEST_CAMPAIGN == AUTHORIZATION_PERIOD - SETTLEMENT_MARGIN == timedelta(days=27)
    with pytest.raises(CampaignError):
        new_campaign("c9", "25", 3, NOW + timedelta(days=29), NOW)
    longest = new_campaign("c9", "25", 3, NOW + LONGEST_CAMPAIGN, NOW)
    first = [pledge(n, days_ago=-10 / 1440) for n in (1, 2, 3)]  # held ten minutes after the launch
    # Settled when it closes, or after a retry within the margin, every hold is still live.
    assert not any(lapsed(p, longest.deadline + SETTLEMENT_MARGIN) for p in first)
    assert kinds(decide(longest, first, longest.deadline + timedelta(hours=1))) == [
        ("capture", "p1", True), ("capture", "p2", True), ("capture", "p3", True)]


def test_progress_counts_supporters_once_and_the_money_held_or_collected():
    pledges = [
        pledge(1), pledge(2, status=CAPTURED), replace(pledge(3), payer_id="PAYER1"),  # PAYER1 pledged twice
        pledge(4, status=VOIDED), Pledge("p5", "25.00"),  # released, and not approved yet
        pledge(6, days_ago=30, expires_at=NOW - timedelta(days=1)),  # a hold that ran out
    ]
    now = progress(campaign(goal=4), pledges, NOW)
    assert now["counts"] == {"created": 1, "authorized": 2, "declined": 0, "captured": 1, "voided": 1, "withdrawn": 0,
                             "expired": 1, "failed": 0, "refunded": 0}
    assert (now["pledges"], now["supporters"], now["total"], now["currency"]) == (3, 2, "75.00", "USD")
    assert (now["goal"], now["remaining"], now["percent"], now["funded"]) == (4, 2, 50, False)
    # Without a moment, a hold is counted as stored.
    assert progress(campaign(goal=3), pledges)["supporters"] == 3
    assert progress(campaign(goal=3), pledges)["funded"]


def test_pledges_are_read_from_paypal_s_authorized_order():
    order = {
        "id": "ORDER7", "status": "COMPLETED", "payer": {"payer_id": "PAYER7"},
        "purchase_units": [{"custom_id": "pledge:c1:p7", "payments": {"authorizations": [{
            "id": "AUTH7", "status": "CREATED", "amount": {"currency_code": "USD", "value": "25.00"},
            "create_time": "2026-11-01T09:30:00Z", "expiration_time": "2026-11-30T09:30:00Z",
        }]}}],
    }
    made = pledge_from_order("p7", order)
    assert made == Pledge(
        id="p7", amount="25.00", currency="USD", status=AUTHORIZED, order_id="ORDER7", payer_id="PAYER7",
        authorization_id="AUTH7", authorized_at=datetime(2026, 11, 1, 9, 30, tzinfo=UTC),
        expires_at=datetime(2026, 11, 30, 9, 30, tzinfo=UTC),
    )
    order["purchase_units"][0]["payments"]["authorizations"][0]["status"] = "DENIED"
    assert pledge_from_order("p7", order).status == PledgeStatus.DECLINED


def test_an_open_campaign_takes_pledges_and_only_marks_holds_that_ran_out():
    running = campaign(deadline=NOW + timedelta(days=3))
    card_hold = pledge(2, days_ago=8, expires_at=NOW - timedelta(hours=1))  # PayPal let this hold go early
    assert accepting(running, NOW) and not accepting(campaign(), NOW)
    assert not accepting(replace(running, closed_at=NOW - timedelta(minutes=1)), NOW)
    assert kinds(decide(running, [pledge(1), card_hold, Pledge("p3", "25.00")], NOW)) == [("expire", "p2", False)]
    assert decide(running, [pledge(1, days_ago=10)], NOW) == []  # funded or not, nothing moves before the deadline


def test_a_funded_campaign_captures_and_renews_holds_past_the_honor_period():
    renewed = pledge(3, days_ago=9, reauthorization_id="RE-AUTH3", reauthorized_at=NOW - timedelta(days=5))
    actions = decide(campaign(), [pledge(1, days_ago=1), pledge(2, days_ago=5), renewed], NOW)
    # p2 is past its 3-day honor period; p3 was renewed once already and PayPal allows no second renewal.
    assert kinds(actions) == [("capture", "p1", False), ("capture", "p2", True), ("capture", "p3", False)]
    assert needs_reauthorization(pledge(4, days_ago=3), NOW) and not needs_reauthorization(pledge(4, days_ago=2.9), NOW)
    assert needs_reauthorization(replace(pledge(4), authorized_at=None), NOW)  # unknown age: try, PayPal decides
    assert not needs_reauthorization(pledge(4, days_ago=30), NOW)  # past day 29 PayPal never renews a hold


def test_a_campaign_short_of_its_goal_releases_every_hold():
    pledges = [pledge(1), pledge(2), replace(pledge(3), payer_id="PAYER1")]  # 3 pledges, 2 supporters
    assert kinds(decide(campaign(), pledges, NOW)) == [("void", "p1", False), ("void", "p2", False), ("void", "p3", False)]
    early = campaign(deadline=NOW + timedelta(days=5), closed_at=NOW - timedelta(hours=1))
    assert [action.kind for action in decide(early, pledges, NOW)] == ["void"] * 3


def test_the_owner_can_close_a_funded_campaign_early():
    early = campaign(deadline=NOW + timedelta(days=5), closed_at=NOW - timedelta(hours=1))
    assert [action.kind for action in decide(early, [pledge(1), pledge(2), pledge(3)], NOW)] == ["capture"] * 3


def test_late_lapsed_and_leftover_holds():
    late = pledge(4, days_ago=0.001)  # held after the deadline passed
    lapsed = pledge(5, days_ago=20, expires_at=NOW - timedelta(days=1))  # ran out before the close
    actions = decide(campaign(), [pledge(1), pledge(2), pledge(3), late, lapsed], NOW)
    assert kinds(actions)[3:] == [("void", "p4", False), ("expire", "p5", False)]
    # Settled campaigns release whatever is still held; partial ones keep collecting, below the goal or not.
    assert kinds(decide(campaign(status=CampaignStatus.COLLECTED), [pledge(1)], NOW)) == [("void", "p1", False)]
    assert kinds(decide(campaign(status=CampaignStatus.EXPIRED), [pledge(1)], NOW)) == [("void", "p1", False)]
    assert kinds(decide(campaign(status=CampaignStatus.PARTIAL), [pledge(1)], NOW)) == [("capture", "p1", False)]
    # Money collected outside settlement is no leave to collect the rest: short of its goal at the close, the campaign
    # releases every hold (and settle() flags the collected pledge for refund).
    assert kinds(decide(campaign(), [pledge(1, status=CAPTURED), pledge(2)], NOW)) == [("void", "p2", False)]


def test_a_capture_made_outside_settlement_never_funds_a_campaign():
    # Goal 10: three live holds, and one pledge the owner captured in PayPal's dashboard.
    stray = pledge(0, status=CAPTURED, capture_id="CAP-DASHBOARD")
    pledges = [stray, pledge(1), pledge(2), pledge(3)]
    assert not funded_at_close(campaign(goal=10), pledges)
    assert kinds(decide(campaign(goal=10), pledges, NOW)) == [("void", f"p{n}", False) for n in (1, 2, 3)]
    fake = FakePayPal()
    result = settle_with(fake, campaign(goal=10), pledges)
    assert fake.calls() == ["void AUTH1", "void AUTH2", "void AUTH3"]
    assert (result.campaign.status, result.campaign.funded) == (CampaignStatus.EXPIRED, False)
    assert result.reasons == [
        "1 pledge was collected although the campaign fell short of its goal: refund it (CAP-DASHBOARD)."]


def test_the_funded_decision_counts_the_holds_valid_at_the_close_and_is_taken_once():
    pledges = [pledge(1), pledge(2), pledge(3)]
    decided = decide_funding(campaign(), pledges, NOW)
    assert (decided.funded, decided.status) == (True, CampaignStatus.FUNDED)
    assert decide_funding(decided, [], NOW) is decided  # taken once, whatever the pledges say later
    short = decide_funding(campaign(), pledges[:2], NOW)
    assert (short.funded, short.status) == (False, CampaignStatus.OPEN)
    running = campaign(deadline=NOW + timedelta(days=2))
    assert decide_funding(running, pledges, NOW) is running  # still taking pledges: nothing to decide
    # Holds that were not valid at the close never count: placed after it, run out before it, released, declined.
    invalid = [pledge(4, days_ago=0.001), pledge(5, days_ago=20, expires_at=NOW - timedelta(days=1)),
               pledge(6, status=VOIDED), pledge(7, status=PledgeStatus.DECLINED)]
    assert not funded_at_close(campaign(), [pledge(1), pledge(2), *invalid])
    # Collected and refused pledges were valid holds at the close: a settlement cut short resumes collecting...
    halfway = [pledge(1, status=CAPTURED, capture_id="CAP-AUTH1"), pledge(2, status=FAILED, error="INSTRUMENT_DECLINED"),
               pledge(3)]
    assert funded_at_close(campaign(), halfway)
    assert kinds(decide(campaign(), halfway, NOW)) == [("capture", "p3", False)]
    # ...and a stored decision stands whatever happens to the pledges since: collect, or release.
    withdrawn = [halfway[0], replace(halfway[1], status=VOIDED), halfway[2]]
    assert not funded_at_close(campaign(), withdrawn)
    assert kinds(decide(decided, withdrawn, NOW)) == [("capture", "p3", False)]
    assert kinds(decide(short, pledges, NOW)) == [("void", f"p{n}", False) for n in (1, 2, 3)]
    stored = settle_with(FakePayPal(), decided, withdrawn)
    assert (stored.campaign.status, stored.campaign.funded, stored.reasons) == (CampaignStatus.COLLECTED, True, [])


def test_settlement_records_the_funded_decision_before_its_first_capture():
    fake = FakePayPal()
    recorded: list[tuple] = []

    async def record(decided: Campaign) -> None:
        recorded.append((decided.status, decided.funded, len(fake.requests)))

    result = settle_with(fake, campaign(), [pledge(1), pledge(2), pledge(3)], record=record)
    assert recorded == [(CampaignStatus.FUNDED, True, 0)]  # stored before PayPal was called at all
    assert (result.campaign.status, result.campaign.funded) == (CampaignStatus.COLLECTED, True)
    assert fake.calls() == ["capture AUTH1", "capture AUTH2", "capture AUTH3"]

    async def broken(decided: Campaign) -> None:
        raise RuntimeError("the database is down")

    silent = FakePayPal()
    with pytest.raises(RuntimeError):
        settle_with(silent, campaign(), [pledge(1), pledge(2), pledge(3)], record=broken)
    assert silent.requests == []  # nothing is collected unless the decision is stored first
    # A decision already stored is not recorded again, and an open campaign has none to record.
    settle_with(FakePayPal(), result.campaign, result.pledges, record=broken)
    settle_with(FakePayPal(), campaign(deadline=NOW + timedelta(days=2)), [pledge(1)], record=broken)


def paypal_error(status: int, issue: str, name: str = "UNPROCESSABLE_ENTITY") -> httpx.Response:
    return httpx.Response(status, json={"name": name, "message": "The requested action could not be performed.",
                                        "debug_id": "dbg1", "details": [{"issue": issue, "description": issue}]})


class FakePayPal:
    """A small PayPal: tokens, reauthorize, capture, void and orders. Each (operation, authorization) can be given
    replies to send first; otherwise every call succeeds."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.replies: dict[tuple[str, str], list[httpx.Response]] = {}
        self.orders: dict[str, dict] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        parts = request.url.path.strip("/").split("/")
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "token", "token_type": "Bearer", "expires_in": 32400})
        if parts[:2] == ["v2", "checkout"]:
            return httpx.Response(200, json=self.orders[parts[3]])
        authorization, operation = parts[3], parts[4]
        queued = self.replies.get((operation, authorization))
        if queued:
            return queued.pop(0)
        if operation == "reauthorize":
            return httpx.Response(201, json={"id": f"RE-{authorization}", "status": "CREATED"})
        if operation == "capture":
            return httpx.Response(201, json={
                "id": f"CAP-{authorization}", "status": "COMPLETED", "final_capture": True,
                "amount": json.loads(request.content)["amount"],
                "links": [{"rel": "up", "href": f"{API}/v2/payments/authorizations/{authorization}"}],
            })
        return httpx.Response(200, json={"id": authorization, "status": "VOIDED"})

    def calls(self) -> list[str]:
        """The payment calls made, as 'operation AUTHORIZATION', in a stable order."""
        paths = [r.url.path.split("/") for r in self.requests if r.url.path.startswith("/v2/payments/")]
        return sorted(f"{path[5]} {path[4]}" for path in paths)

    def request(self, operation: str, authorization: str) -> httpx.Request:
        return next(r for r in self.requests if r.url.path == f"/v2/payments/authorizations/{authorization}/{operation}")


def settle_with(fake: FakePayPal, the_campaign: Campaign, pledges: list[Pledge], now: datetime = NOW, **options):
    client = PayPalClient("id", "secret", API, retries=0,
                          http_client=httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    return asyncio.run(settle(the_campaign, pledges, client, now, **options))


def by_id(result) -> dict:
    return {item.id: item for item in result.pledges}


def test_a_funded_campaign_collects_every_hold():
    fake = FakePayPal()
    result = settle_with(fake, campaign(), [pledge(1), pledge(2, days_ago=2), pledge(3, days_ago=2.5)])
    assert result.campaign.status == CampaignStatus.COLLECTED and result.reasons == []
    assert [(p.status, p.capture_id, p.error) for p in result.pledges] == [
        (CAPTURED, f"CAP-AUTH{n}", None) for n in (1, 2, 3)]
    assert fake.calls() == ["capture AUTH1", "capture AUTH2", "capture AUTH3"]
    capture = fake.request("capture", "AUTH1")
    assert json.loads(capture.content) == {"final_capture": True, "amount": {"currency_code": "USD", "value": "25.00"}}
    assert capture.headers["paypal-request-id"] == request_key("capture", "AUTH1")
    assert (result.progress["funded"], result.progress["total"], result.progress["counts"]["captured"]) == (True, "75.00", 3)


def test_holds_past_the_honor_period_are_renewed_once_and_the_renewal_is_captured():
    fake = FakePayPal()
    renewed = pledge(3, days_ago=9, reauthorization_id="RE-OLD3", reauthorized_at=NOW - timedelta(days=5))
    result = settle_with(fake, campaign(), [pledge(1, days_ago=5), pledge(2), renewed])
    assert fake.calls() == ["capture AUTH2", "capture RE-AUTH1", "capture RE-OLD3", "reauthorize AUTH1"]
    reauthorize = fake.request("reauthorize", "AUTH1")
    assert json.loads(reauthorize.content) == {"amount": {"currency_code": "USD", "value": "25.00"}}
    assert reauthorize.headers["paypal-request-id"] == request_key("reauthorize", "AUTH1")
    first = by_id(result)["p1"]
    assert (first.status, first.reauthorization_id, first.reauthorized_at, first.capture_id) == (
        CAPTURED, "RE-AUTH1", NOW, "CAP-RE-AUTH1")
    assert [outcome.reauthorized for outcome in result.outcomes] == [True, False, False]
    assert result.campaign.status == CampaignStatus.COLLECTED


def test_a_renewal_paypal_refuses_falls_back_to_capturing_the_hold_as_it_is():
    fake = FakePayPal()
    fake.replies[("reauthorize", "AUTH1")] = [paypal_error(422, "REAUTHORIZATION_TOO_SOON")]
    result = settle_with(fake, campaign(), [pledge(1, days_ago=3.01), pledge(2), pledge(3)])
    assert "capture AUTH1" in fake.calls() and by_id(result)["p1"].reauthorization_id is None
    assert by_id(result)["p1"].status == CAPTURED and result.campaign.status == CampaignStatus.COLLECTED


def test_already_captured_holds_count_as_collected():
    fake = FakePayPal()
    fake.replies[("capture", "AUTH2")] = [paypal_error(422, "AUTHORIZATION_ALREADY_CAPTURED")]
    fake.orders["ORDER2"] = {"id": "ORDER2", "status": "COMPLETED", "purchase_units": [{"payments": {"captures": [
        {"id": "CAP-EARLIER", "status": "COMPLETED",
         "links": [{"rel": "up", "href": f"{API}/v2/payments/authorizations/AUTH2"}]},
    ]}}]}
    result = settle_with(fake, campaign(), [pledge(1), pledge(2), pledge(3)])
    assert (by_id(result)["p2"].status, by_id(result)["p2"].capture_id) == (CAPTURED, "CAP-EARLIER")
    assert result.campaign.status == CampaignStatus.COLLECTED and result.reasons == []


def test_settling_again_sends_the_same_request_ids():
    first, second = FakePayPal(), FakePayPal()
    pledges = [pledge(1, days_ago=4), pledge(2), pledge(3)]
    settle_with(first, campaign(), pledges)
    settle_with(second, campaign(), pledges)  # as after a crash before the results were stored
    ids = [[(r.url.path, r.headers["paypal-request-id"]) for r in fake.requests if "payments" in r.url.path]
           for fake in (first, second)]
    assert sorted(ids[0]) == sorted(ids[1]) and len(ids[0]) == 4


def test_partial_failures_are_reported_and_retried():
    fake = FakePayPal()
    fake.replies[("capture", "AUTH2")] = [paypal_error(422, "INSTRUMENT_DECLINED")]
    fake.replies[("capture", "AUTH3")] = [paypal_error(503, "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE")]
    first = settle_with(fake, campaign(), [pledge(1), pledge(2), pledge(3)])
    assert first.campaign.status == CampaignStatus.PARTIAL
    assert [(p.status, p.error) for p in first.pledges] == [
        (CAPTURED, None), (FAILED, "INSTRUMENT_DECLINED"), (AUTHORIZED, "SERVICE_UNAVAILABLE")]
    assert [outcome.temporary for outcome in first.outcomes] == [False, False, True]
    assert first.reasons == [
        "1 pledge could not be collected: the card or bank declined the payment (INSTRUMENT_DECLINED).",
        "1 pledge is not collected yet (SERVICE_UNAVAILABLE); the next settlement tries again.",
    ]
    again = settle_with(fake, first.campaign, first.pledges, NOW + timedelta(hours=1))
    assert [outcome.pledge_id for outcome in again.outcomes] == ["p3"]  # the declined pledge is not tried again
    assert by_id(again)["p3"].status == CAPTURED and by_id(again)["p3"].error is None
    assert again.campaign.status == CampaignStatus.PARTIAL and len(again.reasons) == 1


def test_paypal_s_answers_decide_each_pledge():
    fake = FakePayPal()
    fake.replies[("capture", "AUTH1")] = [httpx.Response(201, json={
        "id": "CAP-P", "status": "PENDING", "status_details": {"reason": "PENDING_REVIEW"}})]
    fake.replies[("capture", "AUTH2")] = [httpx.Response(201, json={"id": "CAP-D", "status": "DECLINED"})]
    fake.replies[("reauthorize", "AUTH3")] = [paypal_error(422, "AUTHORIZATION_VOIDED")]
    fake.replies[("capture", "AUTH4")] = [paypal_error(401, "INVALID_TOKEN", "AUTHENTICATION_FAILURE")] * 2
    result = settle_with(fake, campaign(goal=4), [pledge(1), pledge(2), pledge(3, days_ago=5), pledge(4)])
    assert [(p.status, p.error) for p in result.pledges] == [
        (CAPTURED, None), (FAILED, "DECLINED"), (FAILED, "AUTHORIZATION_VOIDED"), (AUTHORIZED, "INVALID_TOKEN")]
    assert "capture AUTH3" not in fake.calls()  # a cancelled hold is never captured
    assert result.outcomes[0].capture_status == "PENDING" and result.outcomes[3].temporary
    assert result.campaign.status == CampaignStatus.PARTIAL
    assert result.reasons == [
        "1 pledge could not be collected: the hold had been cancelled (AUTHORIZATION_VOIDED).",
        "1 pledge could not be collected: PayPal declined the capture (DECLINED).",
        "1 pledge is not collected yet (INVALID_TOKEN); the next settlement tries again.",
        "1 payment is pending at PayPal, which completes or denies it later.",
    ]


def test_a_retry_that_succeeds_completes_the_collection():
    fake = FakePayPal()
    fake.replies[("capture", "AUTH3")] = [httpx.Response(429, json={"name": "RATE_LIMIT_REACHED", "message": "Too many requests."})]
    first = settle_with(fake, campaign(), [pledge(1), pledge(2), pledge(3)])
    assert first.campaign.status == CampaignStatus.PARTIAL
    again = settle_with(fake, first.campaign, first.pledges, NOW + timedelta(minutes=30))
    assert again.campaign.status == CampaignStatus.COLLECTED and again.reasons == []
    final = settle_with(fake, again.campaign, again.pledges, NOW + timedelta(hours=1))
    assert final.outcomes == [] and final.campaign.status == CampaignStatus.COLLECTED


def test_a_campaign_short_of_its_goal_releases_every_hold_once():
    fake = FakePayPal()
    fake.replies[("void", "AUTH2")] = [paypal_error(422, "PREVIOUSLY_VOIDED")]
    result = settle_with(fake, campaign(), [pledge(1), pledge(2)])
    assert result.campaign.status == CampaignStatus.EXPIRED and result.reasons == []
    assert [p.status for p in result.pledges] == [VOIDED, VOIDED]
    void = fake.request("void", "AUTH1")
    assert void.content == b"" and void.headers["paypal-request-id"] == request_key("void", "AUTH1")
    cancelled = campaign(deadline=NOW + timedelta(days=4), closed_at=NOW - timedelta(minutes=1))
    assert settle_with(FakePayPal(), cancelled, [pledge(1)]).campaign.status == CampaignStatus.CANCELLED


def test_a_void_goes_to_the_original_hold_and_flags_money_to_refund():
    fake = FakePayPal()
    fake.replies[("void", "AUTH2")] = [paypal_error(422, "PREVIOUSLY_CAPTURED")]
    fake.replies[("void", "AUTH3")] = [paypal_error(422, "AUTHORIZATION_EXPIRED")]
    fake.orders["ORDER2"] = {"purchase_units": [{"payments": {"captures": [{"id": "CAP-STRAY"}]}}]}
    renewed = pledge(1, reauthorization_id="RE-AUTH1")
    result = settle_with(fake, campaign(goal=5), [renewed, pledge(2), pledge(3)])
    assert fake.calls() == ["void AUTH1", "void AUTH2", "void AUTH3"]  # never the reauthorization
    assert [p.status for p in result.pledges] == [VOIDED, CAPTURED, EXPIRED]
    assert result.campaign.status == CampaignStatus.EXPIRED
    assert result.reasons == [
        "1 pledge was collected although the campaign fell short of its goal: refund it (CAP-STRAY)."]


def test_holds_that_ran_out_are_marked_without_calling_paypal():
    fake = FakePayPal()
    running = campaign(deadline=NOW + timedelta(days=2))
    lapsed = pledge(2, days_ago=10, expires_at=NOW - timedelta(minutes=1))
    result = settle_with(fake, running, [pledge(1), lapsed])
    assert fake.requests == [] and [p.status for p in result.pledges] == [AUTHORIZED, EXPIRED]
    assert result.campaign.status == CampaignStatus.OPEN and result.reasons == []


def test_a_late_hold_is_released_and_a_broken_pledge_does_not_stop_the_rest():
    fake = FakePayPal()
    broken = replace(pledge(3), amount="not money")
    late = pledge(4, days_ago=0.001)
    result = settle_with(fake, campaign(), [pledge(1), pledge(2), broken, late])
    assert [p.status for p in result.pledges] == [CAPTURED, CAPTURED, AUTHORIZED, VOIDED]
    assert by_id(result)["p3"].error == "ValueError" and result.campaign.status == CampaignStatus.PARTIAL
    assert "void AUTH4" in fake.calls()


DESIGN = {
    "name": "Golden Hour",
    "tagline": "Morning pastries for the block",
    "offer": ["Kouign amann", "Rye loaf", "Cardamom bun"],
    "hours": "Daily 7 am–3 pm",
    # Sheets made before the design sheet dropped them still carry partners, price anchors and artists: never named.
    "partners": [{"name": "Corner Cellar", "why": "Drinks after dinner"}],
    "price_anchors": [{"name": "Crumb Bakehouse", "url": "https://crumb.example/", "level": 3}],
    "music": {"direction": "Local", "artists": ["Mobley", "Gary Clark Jr."]},
    "experience": {"soundtrack": [{"id": "a1", "name": "Mobley"}], "basis": "What people within 1.5 km over-index on."},
    "launch": {
        "audience": {"crowd": [{"label": "Families", "places": 3, "of": 3}], "artists": ["Mobley"],
                     "podcasts": ["Stassi"], "screen": [], "brands": ["Patagonia"], "shared": []},
        "where": {"label": "10-minute walk", "minutes": 10, "reach_m": 556, "neighborhoods": ["Holly", "East Cesar Chavez"],
                  "sites_like": [{"name": "Sunrise Loaves", "url": "https://sunrise.example/"}]},
        "when": {"times": [{"label": "Morning", "places": 3, "of": 3}],
                 "intents": [{"label": "Routine visit", "places": 2, "of": 3, "angle": "Lead with the habit."}]},
        "claims": [
            {"kind": "only", "line": "The only bakery within a 10-minute walk",
             "proof": "Qloo lists no bakery inside the walk; 3 of the bakeries locals love are outside it."},
            {"kind": "new", "line": "Cardamom bun, which no bakery within a 10-minute walk is known for",
             "proof": "2 of the bakeries locals love are known for it; none inside the walk is."},
            {"kind": "promise", "line": "Book ahead, or be served fast at the counter",
             "proof": "Reviews of 2 of the bakeries inside the walk flag long waits."},
        ],
    },
}
CONCEPT = {
    "name": "Golden Hour", "genre": "Bakery", "signature": ["Kouign amann", "Rye loaf"],
    "inspired_by": ["Crumb Bakehouse", "Sunrise Loaves"],
    "why_here": ["Locals travel a median 2.1 km to bakeries such as Crumb Bakehouse.",
                 "Neighbors rank bakery #6 among the place types they engage with.",
                 "Not cross-checked: OpenStreetMap did not answer in time, so this count is Qloo's alone."],
}
TERMS = {"amount": "25", "goal": 40, "deadline": datetime(2026, 11, 12, 23, 0, tzinfo=UTC)}
FORBIDDEN = ("Mobley", "Gary Clark", "Patagonia", "Stassi", "Crumb", "Sunrise Loaves", "Corner Cellar")
PERK = "10% off every visit in the first year"
# The same business beside a drive, with no "only" claim: nothing proves it is the only or the first.
DRIVE = {**DESIGN, "launch": {**DESIGN["launch"], "where": {**DESIGN["launch"]["where"], "label": "30-minute drive"},
                              "claims": [{"kind": "new", "line": "Cardamom bun, which no bakery within a 30-minute drive is known for",
                                          "proof": "2 of the bakeries locals love are known for it; none inside the drive is."}]}}


def llm_answering(draft: dict | None, seen: list[dict], status: int = 200) -> LLM:
    """The app's LLM client, answered by a fake OpenAI-compatible endpoint."""
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "overloaded"}})
        message = {"role": "assistant", "content": json.dumps(draft)}
        return httpx.Response(200, json={
            "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": "test-model",
            "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
        })

    return LLM("key", "https://llm.test/v1/", "test-model", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def draft(llm, design: dict = DESIGN, **extra) -> dict:
    return asyncio.run(draft_offer(llm, design, **{**TERMS, **extra}))


GOOD = {
    "title": "Bring Golden Hour to Holly",
    "pitch": "Golden Hour is the only bakery within a 10-minute walk, made for families' mornings. "
             "Join the 40 founding supporters it needs by November 12.",
    "perks": ["Your name on the founders' wall", "An invitation to the opening", "First taste of the kouign amann"],
}


def test_the_model_writes_the_words_and_the_owner_s_terms_stay_fixed():
    seen: list[dict] = []
    offer = draft(llm_answering(GOOD, seen), concept=CONCEPT, place="Holly, Austin")
    assert {key: offer[key] for key in ("title", "pitch", "perks")} == GOOD
    assert (offer["mode"], offer["model"], offer["rejected"]) == ("agent", "test-model", [])
    assert offer["how_it_works"] == (
        "Pledge $25.00. PayPal only holds it: it is collected if 40 supporters pledge by November 12, and released if "
        "not, so nobody pays unless the goal is met.")
    sent = seen[0]["messages"][1]["content"]
    brief = json.loads(sent)
    assert brief["owner_terms"] == {"pledge": "$25.00", "supporters_needed": 40, "deadline": "November 12, 2026"}
    assert brief["place"] == {"label": "Holly, Austin", "area": "10-minute walk", "neighborhoods": ["Holly", "East Cesar Chavez"]}
    assert brief["evidence"] == [
        {"kind": "only", "claim": "The only bakery within a 10-minute walk",
         "proof": "Qloo lists no bakery inside the walk; 3 of the bakeries locals love are outside it."},
        {"kind": "new", "claim": "Cardamom bun, which no bakery within a 10-minute walk is known for",
         "proof": "2 of the bakeries locals love are known for it; none inside the walk is."},
        {"fact": "Neighbors rank bakery #6 among the place types they engage with."},  # the caveat is left out
    ]
    assert brief["who"] == {"crowd": ["Families"], "times": ["Morning"], "reasons_to_visit": ["Routine visit"]}
    assert "Book ahead" not in sent  # a promise is the owner's to make
    assert not [name for name in FORBIDDEN if name in sent]  # the model never sees a real name to repeat


def test_the_kit_s_claims_are_the_evidence_when_given():
    seen: list[dict] = []
    claims = [{"kind": "closer", "line": "Bakery without crossing town", "proof": "2 of the 3 bakeries people here love are outside the walk."}]
    draft(llm_answering(GOOD, seen), claims=claims)
    assert json.loads(seen[0]["messages"][1]["content"])["evidence"] == [
        {"kind": "closer", "claim": "Bakery without crossing town", "proof": "2 of the 3 bakeries people here love are outside the walk."}]


def test_lines_that_break_the_rules_are_replaced_by_the_evidence_rules():
    seen: list[dict] = []
    offer = draft(llm_answering({
        "title": "Golden Hour, for Patagonia fans",
        "pitch": "Join 99 neighbors and get 20% off your first coffee at Golden Hour.",
        "perks": ["A free coffee every week", "Your name on the founders' wall", "Front-row seats to Mobley",
                  "Order at goldenhour.com first", "Your name on the founders' wall", "Pastries from $4 a box",
                  "Meet Chef Marco at the opening", "The best croissant in town"],
    }, seen))
    assert offer["title"] == "Be a founding supporter of Golden Hour"
    assert offer["pitch"] == ("Morning pastries for the block. The only bakery within a 10-minute walk. "
                              "Be one of the 40 founding supporters it needs by November 12.")
    assert offer["perks"] == ["Your name on the founders' wall"]  # the model's one good perk, once
    assert offer["mode"] == "agent"
    assert offer["rejected"] == [
        {"field": "title", "reason": "names Patagonia"},
        {"field": "pitch", "reason": "states 99, a number the inputs do not have"},
        {"field": "perks", "reason": "promises a discount the owner did not set"},
        {"field": "perks", "reason": "names Mobley"},
        {"field": "perks", "reason": "has a link"},
        {"field": "perks", "reason": "states 4, a number the inputs do not have"},
        {"field": "perks", "reason": "names Marco"},
        {"field": "perks", "reason": 'says "best", which nothing measured proves'},
    ]


def test_without_a_model_the_evidence_rules_write_the_whole_pitch():
    offer = draft(None)
    assert offer == {
        "title": "Be a founding supporter of Golden Hour",
        "pitch": "Morning pastries for the block. The only bakery within a 10-minute walk. "
                 "Be one of the 40 founding supporters it needs by November 12.",
        "perks": ["Your name on the founding supporters' wall", "An invitation to the opening night",
                  "A first taste of kouign amann"],
        "how_it_works": "Pledge $25.00. PayPal only holds it: it is collected if 40 supporters pledge by November 12, "
                        "and released if not, so nobody pays unless the goal is met.",
        "mode": "rules", "model": None, "rejected": [],
    }
    assert draft(LLM("", None, "no-key"))["mode"] == "rules"  # a model without a key is no model
    unnamed = asyncio.run(draft_offer(None, {"name": "Golden Hour", "launch": {}}, **TERMS))
    assert unnamed["pitch"] == ("Golden Hour is planned for a storefront near you. "
                                "Be one of the 40 founding supporters it needs by November 12.")
    # Without an "only" claim the rules lead with an item new to the area instead.
    assert draft(None, DRIVE)["pitch"] == ("Morning pastries for the block. Cardamom bun, which no bakery within a "
                                           "30-minute drive is known for. Be one of the 40 founding supporters it needs "
                                           "by November 12.")


def test_an_ai_outage_or_an_empty_answer_falls_back_to_the_rules():
    assert draft(llm_answering(None, [], status=503))["mode"] == "rules"
    empty = draft(llm_answering({}, []))
    assert (empty["mode"], empty["rejected"]) == ("rules", [])
    junk = draft(llm_answering({"title": "", "pitch": 42, "perks": "free stuff"}, []))
    assert junk["mode"] == "rules" and [r["field"] for r in junk["rejected"]] == ["title", "pitch"]


def test_the_owner_s_perk_leads_the_perks_and_bounds_the_model():
    seen: list[dict] = []
    offer = draft(llm_answering({
        "title": "Founding supporters of Golden Hour",
        "pitch": "Founding supporters get 10% off every visit in the first year.",
        "perks": ["15% off for founders", "10% off your first year", "A first taste of the rye loaf"],
    }, seen), perk=PERK)
    assert offer["pitch"] == "Founding supporters get 10% off every visit in the first year."
    assert offer["perks"] == [PERK, "A first taste of the rye loaf"]
    assert offer["rejected"] == [
        {"field": "perks", "reason": "states 15, a number the inputs do not have"},
        {"field": "perks", "reason": "changes the perk the owner set"},  # 'your first year', not 'every visit in…'
    ]
    assert json.loads(seen[0]["messages"][1]["content"])["owner_terms"]["perk"] == PERK
    assert draft(None, perk=PERK)["perks"][0] == PERK
    # A perk that is no discount leads the perks all the same, and a line may repeat it.
    tour = draft(llm_answering({**GOOD, "pitch": "Every founder gets a bakery tour before the opening."}, []),
                 perk="A bakery tour before the opening")
    assert tour["perks"][0] == "A bakery tour before the opening" and tour["rejected"] == []


def test_the_pitch_states_the_owner_s_perk_word_for_word():
    for pitch, reason in (
        ("Founding supporters get half off every visit.", "changes the perk the owner set"),
        ("Founding supporters get 10% off every visit, for life.", "changes the perk the owner set"),
        ("Founding supporters get 10% off every visit in the first year, and free coffee for life.",
         "changes the perk the owner set"),
        # 10 is also the walk's minutes, but no amount is the owner's but the pledge.
        ("Founding supporters get $10 off every visit.", "states the price $10: the pledge is the only amount the page gives"),
    ):
        offer = draft(llm_answering({**GOOD, "pitch": pitch}, []), perk=PERK)
        assert offer["rejected"] == [{"field": "pitch", "reason": reason}], pitch
    kept = draft(llm_answering({**GOOD, "pitch": "Pledge now: 10% Off Every Visit in the first year."}, []), perk=PERK)
    assert kept["rejected"] == [] and kept["pitch"] == "Pledge now: 10% Off Every Visit in the first year."
    own_price = draft(llm_answering({**GOOD, "pitch": "Pledge now for $5 off your first box."}, []), perk="$5 off your first box")
    assert own_price["rejected"] == []  # the owner's perk may state an amount


def test_only_or_first_needs_an_only_claim():
    def reasons(pitch: str, design: dict = DESIGN) -> list[dict]:
        return draft(llm_answering({**GOOD, "pitch": pitch}, []), design)["rejected"]

    assert reasons("The only bakery within a 10-minute walk of Holly.") == []
    assert reasons("The only bakery near Holly.", DRIVE) == [
        {"field": "pitch", "reason": 'says "only", which the evidence does not show'}]
    assert reasons("The first bakery Holly has had.", DRIVE) == [
        {"field": "pitch", "reason": 'says "The first", which the evidence does not show'}]
    assert reasons("There is nowhere else to buy kouign amann.", DRIVE) == [
        {"field": "pitch", "reason": 'says "nowhere else", which the evidence does not show'}]
    assert reasons("Unique pastries for Holly.", DRIVE) == [
        {"field": "pitch", "reason": 'says "Unique", which the evidence does not show'}]
    for fine in ("You are charged only if 40 neighbors pledge.", "Be among the first to back Golden Hour.",
                 "Be one of the first 40 founding supporters.", "A first taste of the rye loaf.",
                 "Only 30 minutes from your door."):
        assert reasons(fine, DRIVE) in ([], [{"field": "pitch", "reason": "says the place is a walk away, but the area is a drive"}]), fine


def test_prices_superlatives_and_made_up_names_are_refused():
    def reason(pitch: str, design: dict = DESIGN) -> str | None:
        rejected = draft(llm_answering({**GOOD, "pitch": pitch}, []), design)["rejected"]
        return rejected[0]["reason"] if rejected else None

    assert reason("Pledge $25 to back Golden Hour.") is None  # the pledge itself
    assert reason("Pledge $25.00 to back Golden Hour.") is None
    assert reason("Fresh loaves from $10.") == "states the price $10: the pledge is the only amount the page gives"
    assert reason("Pastries at $$ prices.") == "states the price $$: the pledge is the only amount the page gives"
    assert reason("Kouign amann for 10 dollars.") == "states the price 10 dollars: the pledge is the only amount the page gives"
    assert reason("The best kouign amann in Holly.") == 'says "best", which nothing measured proves'
    assert reason("Holly's most loved bakery.") == 'says "most loved", which nothing measured proves'
    assert reason("Baked by chef Marco Rossi for Holly.") == "names Marco"
    assert reason("Bring Golden Hour to Holly and East Cesar Chavez, with Rye loaf for Families.") is None
    assert reason("A Danish twist on the rye loaf.") is None  # a nationality names nobody
    assert reason("A short walk from your door.", DRIVE) == "says the place is a walk away, but the area is a drive"
    assert reason("A short walk from your door.") is None
    title = draft(llm_answering({**GOOD, "title": "Be A Founding Supporter Of Golden Hour"}, []))
    assert title["rejected"] == []  # Title Case names nobody


@pytest.mark.parametrize(("pitch", "problem"), [
    ("Loaves from $10, baked nearby.", "states the price $10: the pledge is the only amount the page gives"),
    ("Loaves from $10.00, baked nearby.", "states the price $10.00: the pledge is the only amount the page gives"),
    ("Goods for $1,200, ordered nearby.", "states the price $1,200: the pledge is the only amount the page gives"),
    ("Goods for $1,200.50, ordered nearby.", "states the price $1,200.50: the pledge is the only amount the page gives"),
    ("Loaves for 10 dollars, baked nearby.", "states the price 10 dollars: the pledge is the only amount the page gives"),
    ("Pledge $25, then follow the campaign.", None),
    ("Pledge $25.00, then follow the campaign.", None),
    ("Pledge 25 dollars, then follow the campaign.", None),
    ("Pledge $25, or pay $10, instead.", "states the price $10: the pledge is the only amount the page gives"),
])
def test_price_errors_preserve_amounts_without_sentence_punctuation(pitch, problem):
    rules = OfferRules(numbers=frozenset({"10", "25", "1200", "1200.5"}), names=(), amount="25.00")
    assert offer_problem(pitch, 300, rules) == problem


@pytest.mark.parametrize("day", [9, 30])
def test_a_deadlines_day_never_permits_an_unsupported_price(day):
    problems = offer_problems(
        DESIGN, title=GOOD["title"], pitch="Burgers from $9, the best in town.", perks=GOOD["perks"],
        concept=CONCEPT, **{**TERMS, "deadline": datetime(2026, 11, day, 12, tzinfo=UTC)},
    )
    reason = "states the price $9: the pledge is the only amount the page gives" if day == 9 else (
        "states 9, a number the inputs do not have"
    )
    assert problems == [f"The pitch {reason}."]


def test_a_long_pitch_keeps_its_first_whole_sentences_and_avoid_adds_names():
    long_pitch = ("Golden Hour bakes for Holly. Pledge with your neighbors by November 12. " + "Mornings matter. " * 20).strip()
    offer = draft(llm_answering({**GOOD, "pitch": long_pitch}, []))
    assert offer["pitch"].startswith("Golden Hour bakes for Holly. Pledge with your neighbors by November 12.")
    assert len(offer["pitch"]) <= 300 and offer["rejected"] == []
    named = draft(llm_answering({**GOOD, "pitch": "Closer than Joe's Bakery & Co, and open early."}, []),
                  avoid=["Joe's Bakery & Co"])
    assert named["rejected"] == [{"field": "pitch", "reason": "names Joe's Bakery & Co"}]


def test_drafts_for_the_same_evidence_are_replayed(tmp_path):
    seen: list[dict] = []
    answers = AnswerCache(tmp_path)
    llm = llm_answering(GOOD, seen)
    first = asyncio.run(draft_offer(llm, DESIGN, answers=answers, **TERMS))
    again = asyncio.run(draft_offer(llm, DESIGN, answers=answers, **TERMS))
    assert first == again and len(seen) == 1


def test_a_real_name_around_an_allowed_word_is_still_a_name():
    allowed = ["Golden Hour", "Holly"]  # the business and its neighborhood
    assert named("Next to Holly Hardware, a short walk away", ["Holly Hardware"], allowed) == "Holly Hardware"
    assert named("Golden Hour opens in Holly", ["Holly Hardware", "Golden"], allowed) is None
    seen: list[dict] = []
    concept = {**CONCEPT, "inspired_by": ["Holly Bakehouse"],
               "why_here": ["Locals travel a median 2.1 km to bakeries such as Holly Bakehouse."]}
    offer = draft(llm_answering({**GOOD, "title": "Golden Hour, closer than Holly Bakehouse"}, seen), concept=concept)
    assert offer["rejected"] == [{"field": "title", "reason": "names Holly Bakehouse"}]
    assert "Holly Bakehouse" not in seen[0]["messages"][1]["content"]  # nor did the model see it


def test_the_owner_s_edits_are_checked_by_the_draft_s_rules():
    def problems(title: str = GOOD["title"], pitch: str = GOOD["pitch"], perks=GOOD["perks"], design: dict = DESIGN,
                 **terms) -> list[str]:
        return offer_problems(design, title=title, pitch=pitch, perks=perks, concept=CONCEPT, **{**TERMS, **terms})

    assert problems() == []
    assert problems(perks=[PERK, *GOOD["perks"]], perk=PERK) == []  # the perk leads, as drafted
    assert problems(perks=[f"{PERK}, and a free coffee every week"], perk=PERK) == [
        "Perk 1 changes the perk the owner set."]
    assert problems(title="Closer than Crumb Bakehouse", pitch="Mornings matter. " * 20,
                    perks=["A free coffee every week", 7, "Your name on the founders' wall"]) == [
        "The title names Crumb Bakehouse.",
        "The pitch is longer than 300 characters.",
        "Perk 1 promises a discount the owner did not set.",
        "Perk 2 is empty.",
    ]
    assert problems(pitch="Join 99 neighbors at Golden Hour.") == ["The pitch states 99, a number the inputs do not have."]
    assert problems(pitch="The first bakery in Holly.", design=DRIVE) == [
        'The pitch says "The first", which the evidence does not show.']
    assert problems(pitch="Croissants from $3.", title="Holly's finest bakery") == [
        'The title says "finest", which nothing measured proves.',
        "The pitch states the price $3: the pledge is the only amount the page gives.",
    ]
    assert problems(pitch="Pastries for $$$.") == ["The pitch states the price $$$: the pledge is the only amount the page gives."]
    assert problems(perks=["Coffee with Chef Marco"]) == ["Perk 1 names Marco."]
    assert problems(perks=[]) == problems(perks="A free coffee") == ["Add 1 to 4 perks."]
    five = ["Your name on the wall", "An invitation to the opening", "A first taste", "A tour of the kitchen", "A tote bag"]
    assert problems(perks=five) == ["Keep at most 4 perks."]


RESTATED = ["$25 pledge", "Pledge $25", "A $25 contribution", "Pledge $25.00 to become a founding supporter.",
            "Your $25 pledge", "A pledge of twenty-five dollars", "US$25", "Back Golden Hour with $25",
            "Help Golden Hour open in Holly", "Become a founding supporter", "Pledge $25, charged only if we reach the goal"]


def test_a_perk_must_give_more_than_the_pledge_itself():
    for perk in RESTATED:
        assert restates_pledge(perk, "25.00", ["Golden Hour", "Holly"]), perk
    for perk in (*GOOD["perks"], PERK, "A Golden Hour tote bag", "Pledge $25 and get a first taste of the rye loaf",
                 "Your name in the window", "Opening night seat", "Pledge $40", "!!!", "", None):
        assert not restates_pledge(perk, "25.00", ["Golden Hour", "Holly"]), perk
    assert restates_pledge("Pledge $25", 25) and restates_pledge("Pledge 25", "25") and not restates_pledge("Pledge $5", "25.00")


def test_a_perk_that_only_restates_the_pledge_is_refused_whoever_wrote_it():
    # The owner's edits: each restated perk is named, with what to write instead.
    def problems(perks: list, **terms) -> list[str]:
        return offer_problems(DESIGN, title=GOOD["title"], pitch=GOOD["pitch"], perks=perks, concept=CONCEPT,
                              **{**TERMS, **terms})

    assert problems(["Your name on the founders' wall", "A $25 contribution", "Pledge $25"]) == [
        "Perk 2 only restates the pledge: say what founding supporters get beyond it.",
        "Perk 3 only restates the pledge: say what founding supporters get beyond it.",
    ]
    assert problems(["Pledge $25"], perk="Pledge $25") == [  # not even as the owner's own perk line
        "Perk 1 only restates the pledge: say what founding supporters get beyond it."]

    # The model's draft: its restated perks are dropped, and the evidence rules' perks stand in when none is left.
    seen: list[dict] = []
    offer = draft(llm_answering({**GOOD, "perks": ["Pledge $25.00 to become a founding supporter.",
                                                    "An invitation to the opening"]}, seen))
    assert offer["perks"] == ["An invitation to the opening"]
    assert offer["rejected"] == [
        {"field": "perks", "reason": "only restates the pledge: say what founding supporters get beyond it"}]
    restated = draft(llm_answering({**GOOD, "perks": ["$25 pledge", "A $25 contribution"]}, []))
    assert restated["perks"] == draft(None)["perks"] and len(restated["rejected"]) == 2
    assert "beyond the pledge itself" in seen[0]["messages"][0]["content"]  # the model is asked for no such perk


def test_the_page_s_evidence_says_why_this_and_why_here():
    claims = DESIGN["launch"]["claims"]
    assert evidence_lines(CONCEPT, claims) == [
        "The only bakery within a 10-minute walk.",
        "Locals travel a median 2.1 km to bakeries such as Crumb Bakehouse.",
        "Neighbors rank bakery #6 among the place types they engage with.",
    ]
    assert evidence_lines(CONCEPT, claims[1:], limit=2) == [
        "Cardamom bun, which no bakery within a 10-minute walk is known for.",
        "Locals travel a median 2.1 km to bakeries such as Crumb Bakehouse.",
    ]
    # A promise is no evidence, and caveats about the data are left out.
    assert evidence_lines({"why_here": CONCEPT["why_here"][2:]}, claims[2:]) == []
    assert evidence_lines({}, []) == []


def test_a_slow_model_gives_way_to_the_rules(monkeypatch):
    from app.payments import pledges as module

    monkeypatch.setattr(module, "DRAFT_WAIT_S", 0.05)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(2)
        return httpx.Response(503)

    llm = LLM("key", "https://llm.test/v1/", "test-model", http_client=httpx.AsyncClient(transport=httpx.MockTransport(slow)))
    started = asyncio.run(asyncio.wait_for(draft_offer(llm, DESIGN, **TERMS), 5))
    assert started["mode"] == "rules" and started["title"] == "Be a founding supporter of Golden Hour"
