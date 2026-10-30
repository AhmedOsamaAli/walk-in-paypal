"""A pledge's private receipt over a fake PayPal: minted with the pledge and kept only as its digest, read in plain
words with the campaign's progress and terms and nothing about the payer, withdrawn as the campaign's page withdraws
(under the settlement lock, only while the campaign takes pledges), 404 for any receipt Walk-in does not know, limited
per address, never cached, and kept out of the access log."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta

import pytest

from app import cache_policy
from app.db.tables import pledges
from app.payments import pledges as rules
from app.payments import receipts
from app.payments.pledges import PledgeStatus
from app.routes.receipts import HideReceipts, hidden
from tests.founders_fakes import CRON_SECRET, configure, make_client, race
from tests.test_campaigns import EMAIL, start, table
from tests.test_campaigns import world as campaign_world

world = campaign_world

RECEIPT = re.compile(r"[A-Za-z0-9_-]{32}")
KEYS = {"status", "state", "explanation", "withdrawable", "amount", "currency", "pledged_at", "campaign"}
CAMPAIGN_KEYS = {"id", "url", "name", "title", "place", "status", "accepting", "amount", "currency", "goal", "deadline",
                 "closed_at", "progress"}
HELD = ("PayPal holds your $25.00. You are charged only if 3 neighbors join by the deadline; otherwise the hold is "
        "released and you pay nothing.")


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    return configure(monkeypatch)


def started(client, campaign_id: str, flow: str = "buttons") -> tuple[str, str]:
    """A new pledge, not approved yet: its private receipt and its PayPal order id."""
    answer = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": flow})
    assert answer.status_code == 200, answer.text
    return answer.json()["receipt"], answer.json()["order_id"]


def held(client, campaign_id: str) -> tuple[str, str]:
    """A pledge PayPal holds: its private receipt and its PayPal order id."""
    receipt, order_id = started(client, campaign_id)
    hold = client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
    assert hold.status_code == 200 and hold.json()["status"] == "authorized", hold.text
    return receipt, order_id


def read(client, receipt: str):
    return client.get(f"/api/receipts/{receipt}")


def withdraw(client, receipt: str, **options):
    return client.post(f"/api/receipts/{receipt}/withdraw", **options)


def voids(paypal) -> int:
    return len(paypal.calls(r"/v2/payments/authorizations/[^/]+/void"))


def test_each_pledge_gets_a_private_receipt_once_and_walkin_keeps_only_its_digest(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    answer = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": "buttons"}).json()
    assert set(answer) == {"order_id", "approve_url", "receipt"}
    redirect = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": "redirect"}).json()
    assert redirect["approve_url"] and set(redirect) == {"order_id", "approve_url", "receipt"}
    given = [answer["receipt"], redirect["receipt"]]
    assert all(RECEIPT.fullmatch(receipt) for receipt in given) and given[0] != given[1]

    rows = {row["order_id"]: row for row in table(client, pledges)}
    for order, receipt in zip((answer["order_id"], redirect["order_id"]), given, strict=True):
        assert rows[order]["receipt_hash"] == hashlib.sha256(receipt.encode()).hexdigest() == receipts.digest(receipt)
    stored = json.dumps([list(row.values()) for row in rows.values()], default=str)
    sent_to_paypal = json.dumps([order["request"] for order in paypal.orders.values()])
    for receipt in given:  # only its digest is kept, and PayPal never sees it: not in the return link, not anywhere
        assert receipt not in stored and receipt not in sent_to_paypal

    again = read(client, given[0]).json()
    assert again["status"] == "created" and given[0] not in json.dumps(again)  # given once, at the start, never again


def test_a_receipt_tells_its_pledge_in_plain_words_with_the_campaign_and_nothing_about_the_payer(world):
    client, kit = world["client"], world["kit"]
    campaign_id = start(world)
    client.post("/api/auth/logout")  # the receipt is the only key: no account, no cookie
    receipt, order_id = started(client, campaign_id)

    waiting = read(client, receipt)
    assert waiting.status_code == 200 and waiting.headers["cache-control"] == cache_policy.NO_STORE
    assert waiting.json()["status"] == "created"
    assert waiting.json()["state"] == "Waiting for your approval in PayPal" and waiting.json()["withdrawable"] is True
    assert "Approve the pledge in PayPal" in waiting.json()["explanation"]

    client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
    answer = read(client, receipt)
    page = client.get(f"/api/campaigns/{campaign_id}").json()
    view = answer.json()
    assert set(view) == KEYS and set(view["campaign"]) == CAMPAIGN_KEYS
    assert {key: view[key] for key in ("status", "state", "explanation", "withdrawable", "amount", "currency")} == {
        "status": "authorized", "state": "Held", "explanation": HELD, "withdrawable": True, "amount": "25.00",
        "currency": "USD",
    }
    assert view["pledged_at"].endswith("Z")
    assert view["campaign"] == {
        "id": campaign_id, "url": f"/p/{campaign_id}", "name": kit["name"], "title": page["title"],
        "place": {"label": page["place"]["label"], "area": page["place"]["area"]}, "status": "open", "accepting": True,
        "amount": "25.00", "currency": "USD", "goal": 3, "deadline": page["deadline"], "closed_at": None,
        "progress": page["progress"],
    }
    assert view["campaign"]["progress"]["supporters"] == 1
    row = next(row for row in table(client, pledges) if row["order_id"] == order_id)
    text = answer.text
    for private in (order_id, row["id"], row["payer_id"], row["authorization_id"], "buyer@example.com", EMAIL,
                    "o***@example.com", row["receipt_hash"], receipt):
        assert private not in text  # no PayPal order, payer or hold, no owner's email, not even the receipt itself
    assert not cache_policy.is_public(answer.headers["cache-control"])


def test_withdrawing_with_a_receipt_releases_the_hold_as_the_campaign_page_does(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    receipt, order_id = held(client, campaign_id)
    other, _ = held(client, campaign_id)

    answer = withdraw(client, receipt)
    assert answer.status_code == 200 and answer.headers["cache-control"] == cache_policy.NO_STORE
    view = answer.json()
    assert (view["status"], view["state"], view["withdrawable"]) == ("withdrawn", "Withdrawn", False)
    assert view["explanation"] == "It was withdrawn, and PayPal released the hold: nothing was charged."
    assert view["campaign"]["progress"]["supporters"] == 1  # the other pledge still counts
    assert voids(paypal) == 1
    rows = {row["order_id"]: row for row in table(client, pledges)}
    assert rows[order_id]["status"] == "withdrawn"
    assert withdraw(client, receipt).json() == view  # idempotent: PayPal is not asked twice
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/withdraw").json()["status"] == "withdrawn"
    assert voids(paypal) == 1
    assert read(client, other).json()["status"] == "authorized"

    # Never approved: withdrawn without asking PayPal, as nothing is held.
    never, _ = started(client, campaign_id)
    view = withdraw(client, never).json()
    assert view["status"] == "withdrawn" and view["explanation"] == "It was withdrawn before PayPal held anything: nothing was charged."
    assert voids(paypal) == 1


def test_a_receipt_withdrawal_waits_for_the_owner_s_close_under_the_settlement_lock(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    given = [held(client, campaign_id)[0] for _ in range(3)]
    withdrawn, closed = race(client, ("POST", f"/api/receipts/{given[0]}/withdraw"),
                             ("POST", f"/api/campaigns/{campaign_id}/close"), paused="void_authorization")
    assert withdrawn.status_code == 200 and withdrawn.json()["campaign"]["progress"]["supporters"] == 2, withdrawn.text
    assert closed.status_code == 409 and "cancel" in closed.json()["detail"]  # the goal is no longer met
    assert sorted(row["status"] for row in table(client, pledges)) == ["authorized", "authorized", "withdrawn"]
    assert paypal.calls(r"/v2/payments/authorizations/[^/]+/capture") == []


def test_a_receipt_withdrawal_during_the_settlement_pass_finds_the_campaign_closed(world):
    client, paypal, clock = world["client"], world["paypal"], world["clock"]
    campaign_id = start(world)
    given = [held(client, campaign_id)[0] for _ in range(3)]
    clock.advance(days=10, minutes=1)
    settled, withdrawn = race(client, ("POST", "/api/cron/settle", {"x-cron-secret": CRON_SECRET}),
                              ("POST", f"/api/receipts/{given[0]}/withdraw"), paused="capture_authorization")
    assert settled.json()["settled"] == [{"id": campaign_id, "status": "collected"}]
    assert withdrawn.status_code == 409 and "closed" in withdrawn.json()["detail"]
    assert voids(paypal) == 0
    collected = read(client, given[0]).json()
    assert (collected["status"], collected["state"], collected["withdrawable"]) == ("captured", "Collected", False)
    assert collected["explanation"] == "The campaign met its goal, so PayPal collected your $25.00 for its owner."
    assert collected["campaign"]["status"] == "collected" and collected["campaign"]["accepting"] is False


def test_a_closed_campaign_keeps_its_receipts_but_refuses_to_withdraw_and_then_tells_how_it_ended(world):
    client, paypal, clock = world["client"], world["paypal"], world["clock"]
    campaign_id = start(world)
    receipt, _ = held(client, campaign_id)
    clock.advance(days=10, minutes=1)  # past the deadline, before it is settled
    settling = read(client, receipt).json()
    assert (settling["state"], settling["withdrawable"], settling["campaign"]["accepting"]) == ("Held", False, False)
    assert settling["explanation"].startswith("The campaign has closed and is being settled.")
    refused = withdraw(client, receipt)
    assert refused.status_code == 409 and "closed" in refused.json()["detail"] and voids(paypal) == 0

    assert client.post("/api/cron/settle", headers={"x-cron-secret": CRON_SECRET}).status_code == 200
    released = read(client, receipt).json()
    assert (released["status"], released["state"], released["campaign"]["status"]) == ("voided", "Released", "expired")
    assert released["explanation"] == "The campaign ended short of its goal, so PayPal released the hold: nothing was charged."
    assert withdraw(client, receipt).status_code == 409


def test_unknown_receipts_get_404_however_they_are_written(world):
    client = world["client"]
    campaign_id = start(world)
    receipt, _ = held(client, campaign_id)
    unknown = [secrets.token_urlsafe(24), receipt[:-1] + ("A" if receipt[-1] != "A" else "B"), receipt[:16],
               receipt + "x", "not-a-receipt", "%2E%2E"]
    for value in unknown:
        for answer in (read(client, value), withdraw(client, value)):
            assert answer.status_code == 404, (value, answer.text)
            assert answer.json() == {"detail": "Receipt not found. Check that its link was copied whole."}
            assert answer.headers["cache-control"] == cache_policy.NO_STORE
    assert read(client, receipt).json()["status"] == "authorized"  # nothing was withdrawn meanwhile


def test_receipts_are_limited_per_address_unknown_ones_included(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    receipt, _ = held(client, campaign_id)
    client.app.state.receipt_limiter.limit = 2
    assert read(client, secrets.token_urlsafe(24)).status_code == 404  # guesses count too
    assert read(client, receipt).status_code == 200
    limited = read(client, receipt)
    assert limited.status_code == 429 and "Too many receipt checks" in limited.json()["detail"]
    assert read(client, receipt).status_code == 429
    elsewhere = client.get(f"/api/receipts/{receipt}", headers={"x-forwarded-for": "198.51.100.7"})
    assert elsewhere.status_code == 200  # another address has its own allowance

    client.app.state.receipt_withdraw_limiter.limit = 0
    refused = withdraw(client, receipt)
    assert refused.status_code == 429 and "Too many withdrawals" in refused.json()["detail"]
    assert voids(paypal) == 0 and table(client, pledges)[0]["status"] == "authorized"


def test_withdrawing_with_a_receipt_from_another_site_s_page_is_refused(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    receipt, _ = held(client, campaign_id)
    evil = withdraw(client, receipt, headers={"origin": "https://evil.example.com"})
    assert evil.status_code == 403 and voids(paypal) == 0
    assert withdraw(client, receipt, headers={"origin": "http://testserver"}).status_code == 200


def test_the_receipt_page_is_a_page_of_the_web_app(world):
    client = world["client"]
    receipt, _ = started(client, start(world))
    page = client.get(f"/r/{receipt}")
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert "content-security-policy" in page.headers
    assert page.headers["referrer-policy"] == "no-referrer"
    assert read(client, receipt).headers["referrer-policy"] == "no-referrer"


def test_the_access_log_writes_a_receipt_as_stars():
    receipt = secrets.token_urlsafe(24)
    assert hidden(f"/api/receipts/{receipt}") == "/api/receipts/***"
    assert hidden(f"/api/receipts/{receipt}/withdraw") == "/api/receipts/***/withdraw"
    assert hidden(f"/r/{receipt}?from=paypal") == "/r/***?from=paypal"
    for path in ("/api/campaigns/abc/pledges", "/p/abc", "/api/runs/r1", "/k/tok/r/x", "/founders"):
        assert hidden(path) == path
    # As Uvicorn logs a request: client, method, path, HTTP version, status.
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("203.0.113.9:5000", "POST", f"/api/receipts/{receipt}/withdraw", "1.1", 200), None)
    assert HideReceipts().filter(record) is True
    assert receipt not in record.getMessage() and "/api/receipts/***/withdraw" in record.getMessage()

    make_client(), make_client()  # one filter, however many apps are made
    filters = logging.getLogger("uvicorn.access").filters
    assert sum(isinstance(each, HideReceipts) for each in filters) == 1


def pledge_row(status: str, **values) -> dict:
    return {"status": status, "amount_cents": 2500, "authorization_id": None, "authorized_at": None, **values}


@pytest.mark.parametrize(("status", "changes", "late", "state", "explanation"), [
    ("created", {}, False, "Waiting for your approval in PayPal", "Nothing is held yet."),
    ("created", {"status": "expired"}, False, "Not held", "It was not approved in PayPal before the campaign stopped"),
    ("authorized", {}, False, "Held", "PayPal holds your $25.00. You are charged only if 40 neighbors join"),
    ("authorized", {"status": "funded"}, False, "Being collected", "The campaign met its goal, so PayPal is collecting"),
    ("authorized", {"status": "cancelled"}, False, "Being released", "The owner cancelled the campaign, so PayPal is releasing"),
    ("authorized", {"status": "collected"}, True, "Being released", "It came after the campaign stopped taking pledges"),
    ("captured", {"status": "collected"}, False, "Collected", "The campaign met its goal, so PayPal collected your $25.00"),
    ("voided", {"status": "cancelled"}, False, "Released", "The owner cancelled the campaign, so PayPal released the hold"),
    ("voided", {"status": "collected"}, False, "Released", "It came after the campaign stopped taking pledges, so PayPal released"),
    ("declined", {}, False, "Declined", "PayPal declined the pledge, so nothing was held or charged."),
    ("expired", {"status": "collected"}, False, "Expired", "PayPal's hold ran out before the pledge was collected"),
    ("failed", {"status": "partial"}, False, "Not collected", "The campaign met its goal, but PayPal could not collect"),
    ("refunded", {"status": "collected"}, False, "Refunded", "PayPal collected your $25.00, then refunded it."),
])
def test_every_pledge_status_has_its_words_and_only_a_live_one_can_be_withdrawn(status, changes, late, state, explanation):
    now = datetime(2026, 11, 1, 12, tzinfo=UTC)
    ended = changes.get("status", "open") != "open"
    found = rules.Campaign(id="c1", amount="25.00", goal=40, deadline=now + timedelta(days=5),
                           closed_at=now - timedelta(days=1) if ended else None, **changes)
    placed = now if late else now - timedelta(days=2)
    said = receipts.words(pledge_row(status, authorized_at=placed), found, now)
    assert said["state"] == state and said["explanation"].startswith(explanation)
    assert said["withdrawable"] is (not ended and status in (PledgeStatus.CREATED, PledgeStatus.AUTHORIZED))
    assert "$" not in said["explanation"] or "$25.00" in said["explanation"]  # the pledge's own amount, or none


def test_a_capture_pending_at_paypal_is_not_reported_as_completed():
    now = datetime(2026, 11, 1, 12, tzinfo=UTC)
    campaign = rules.Campaign(id="c1", amount="25.00", goal=3, deadline=now, status="partial")
    said = receipts.words(pledge_row("captured", capture_status="PENDING"), campaign, now)
    assert said["state"] == "Collection pending" and said["withdrawable"] is False
    assert "not confirmed" in said["explanation"]


def test_an_unknown_stored_status_is_an_error_not_an_empty_success():
    now = datetime(2026, 11, 1, 12, tzinfo=UTC)
    campaign = rules.Campaign(id="c1", amount="25.00", goal=3, deadline=now)
    with pytest.raises(ValueError, match="Unknown pledge status"):
        receipts.words(pledge_row("unexpected"), campaign, now)
