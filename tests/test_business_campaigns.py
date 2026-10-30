"""An owner can start without a survey; all money and copy checks still use the existing Founders engine."""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.tables import campaigns, surveys
from tests.founders_fakes import Clock, FakePayPal, configure, dev_sign_in, make_client
from tests.test_campaigns import pledge, table


@pytest.fixture
def business_world(monkeypatch):
    configure(monkeypatch, surveys_paused=True)
    clock = Clock()
    paypal = FakePayPal(clock)
    with make_client(paypal=paypal, clock=clock) as client:
        dev_sign_in(client)
        yield client, paypal, clock


def terms(clock, **changes) -> dict:
    return {
        "name": "Morning Table", "kind": "cafe", "description": "A neighborhood cafe serving breakfast and coffee.",
        "why_here": "A place for neighbors to meet over breakfast.", "address": "East Austin, Texas",
        "lat": 30.26, "lon": -97.71, "amount": "25.00", "goal": 3,
        "deadline": (clock.now + timedelta(days=7)).isoformat(), "perk": "10% off every visit in the first year",
        **changes,
    }


def drafted(client, body):
    response = client.post("/api/business-campaigns/draft", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def publish(client, body, **edits):
    words = drafted(client, body)
    copy = {key: words[key] for key in ("title", "pitch", "perks")}
    return client.post("/api/business-campaigns", json={**body, "payout_email": "owner@example.com", **copy, **edits})


def test_an_owner_starts_without_a_survey_and_never_appears_survey_verified(business_world):
    client, _, clock = business_world
    response = publish(client, terms(clock))
    assert response.status_code == 200, response.text
    campaign_id = response.json()["id"]
    row = table(client, campaigns)[0]
    assert row["kit_token"] is row["survey_id"] is row["idx"] is None
    assert table(client, surveys) == []
    assert client.portal.call(client.app.state.campaigns.survey_ids) == []
    view = client.get(f"/api/campaigns/{campaign_id}").json()
    assert view["source"] == "owner" and view["kit_url"] is view["survey_url"] is None
    assert view["evidence"] == [terms(clock)["why_here"]]
    assert client.get("/api/campaigns").json()["campaigns"][0]["id"] == campaign_id
    assert client.get("/api/me/places").status_code == 200
    assert client.get("/founders/start").status_code == 200


def test_business_campaigns_use_the_same_real_hold_capture_and_payout_code(business_world):
    client, paypal, clock = business_world
    response = publish(client, terms(clock))
    assert response.status_code == 200, response.text
    campaign_id = response.json()["id"]
    for _ in range(3):
        pledge(client, campaign_id)
    closed = client.post(f"/api/campaigns/{campaign_id}/close")
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "collected" and closed.json()["progress"]["total"] == "75.00"
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/capture")) == 3
    assert len(paypal.calls(r"/v1/payments/payouts")) == 1


def test_editing_unproven_claims_is_refused_even_when_there_is_no_survey(business_world):
    client, _, clock = business_world
    body = terms(clock)
    for title in ("The best place on the block", "The only cafe in East Austin"):
        response = publish(client, body, title=title)
        assert response.status_code == 422 and response.json()["problems"], response.text
    assert table(client, campaigns) == []


@pytest.mark.parametrize("changes", [
    {"goal": 0}, {"goal": 1}, {"amount": 25.0}, {"amount": "250.00"},
    {"name": "  "}, {"description": "        "}, {"address": "   "}, {"lat": 91}, {"lon": -181},
    {"kind": "not-a-kind"}, {"kit_token": "made-up"},
])
def test_bad_business_terms_are_refused_before_any_campaign_is_stored(business_world, changes):
    client, _, clock = business_world
    response = client.post("/api/business-campaigns/draft", json=terms(clock, **changes))
    assert response.status_code == 422, response.text
    assert table(client, campaigns) == []


def test_starting_business_campaigns_requires_sign_in_and_is_rate_limited(business_world):
    client, _, clock = business_world
    body = terms(clock)
    words = drafted(client, body)
    payload = {**body, "payout_email": "owner@example.com",
               **{key: words[key] for key in ("title", "pitch", "perks")}}
    client.app.state.campaign_limiter.limit = 0
    assert client.post("/api/business-campaigns", json=payload).status_code == 429
    client.post("/api/auth/logout")
    assert client.post("/api/business-campaigns/draft", json=body).status_code == 401
    assert client.post("/api/business-campaigns", json=payload).status_code == 401
