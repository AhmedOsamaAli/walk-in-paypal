"""Walk-in Founders over a fake PayPal: drafting and starting a campaign from a ready kit, the campaign page, finding
campaigns, pledging with the buttons or a redirect, holding (idempotent, declined, refused), withdrawing, the owner's
close and cancel, and what the rest of the app shows of campaigns: /api/config, My places, the kit's page, paused
surveys and the Origin check."""
from __future__ import annotations

import json
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select, update

from app.db.tables import campaigns, kits, pledges
from app.llm import LLM
from app.payments.paypal import PayPalError
from app.payments.pledges import OFFER_SYSTEM
from tests.account_fakes import recording_llm
from tests.founders_fakes import (
    CRON_SECRET,
    Clock,
    FakePayPal,
    configure,
    dev_sign_in,
    make_client,
    race,
    ready_kit,
    run_survey,
    webhook,
)

PERK = "10% off every visit in the first year"
EMAIL = "olive.owner@example.com"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    return configure(monkeypatch)


@pytest.fixture
def world():
    """A PayPal and an app sharing one clock and a model that records what it is asked, a survey, a signed-in owner
    and the ready kit of concept 0."""
    clock = Clock()
    paypal = FakePayPal(clock)
    asked: list[dict] = []
    with make_client(paypal=paypal, clock=clock, llm=recording_llm(asked)) as client:
        run_id = run_survey(client)
        kit = ready_kit(client, run_id)
        owner = dev_sign_in(client)
        yield {"client": client, "paypal": paypal, "clock": clock, "run_id": run_id, "owner": owner, "kit": kit,
               "asked": asked}


def table(client, which) -> list[dict]:
    async def read() -> list[dict]:
        async with client.app.state.db.engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(select(which))).mappings()]

    return client.portal.call(read)


def change(client, which, where, **values) -> None:
    async def write() -> None:
        async with client.app.state.db.engine.begin() as connection:
            await connection.execute(update(which).where(where).values(**values))

    client.portal.call(write)


def offers_asked(world) -> int:
    return sum(1 for body in world["asked"] if body["messages"][0]["content"] == OFFER_SYSTEM)


def terms(world, days: float = 10, kit: dict | None = None, **changes) -> dict:
    deadline = (world["clock"].now + timedelta(days=days)).isoformat()
    return {"kit_token": (kit or world["kit"])["token"], "amount": "25.00", "goal": 3, "deadline": deadline,
            "perk": None, **changes}


def start(world, days: float = 10, kit: dict | None = None, **changes) -> str:
    client = world["client"]
    body = terms(world, days, kit, **changes)
    drafted = client.post("/api/campaigns/draft", json=body).json()
    assert drafted["problems"] == [], drafted
    created = client.post("/api/campaigns", json={**body, "payout_email": EMAIL,
                                                  **{key: drafted[key] for key in ("title", "pitch", "perks")}})
    assert created.status_code == 200, created.text
    return created.json()["id"]


def pledge(client, campaign_id: str, flow: str = "buttons") -> tuple[str, dict]:
    order = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": flow})
    assert order.status_code == 200, order.text
    order_id = order.json()["order_id"]
    held = client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
    assert held.status_code == 200, held.text
    return order_id, held.json()


def test_an_owner_drafts_and_starts_a_campaign_from_any_ready_kit(world):
    client, kit = world["client"], world["kit"]
    drafted = client.post("/api/campaigns/draft", json=terms(world, perk=f"  {PERK} ")).json()
    assert drafted["problems"] == [] and drafted["title"] and drafted["pitch"]
    assert set(drafted) == {"title", "pitch", "perks", "how_it_works", "problems"}
    assert drafted["perks"][0] == PERK  # the owner's words, first and unchanged
    assert "$25.00" in drafted["how_it_works"] and "3 supporters" in drafted["how_it_works"]
    assert offers_asked(world) == 1  # the model wrote the words (its empty answer left them to the rules)

    body = {**terms(world, perk=PERK), "payout_email": EMAIL, **{key: drafted[key] for key in ("title", "pitch", "perks")}}
    created = client.post("/api/campaigns", json=body).json()
    campaign_id = created["id"]
    assert created == {"id": campaign_id, "url": f"/p/{campaign_id}"}
    again = client.post("/api/campaigns", json=body)
    assert again.status_code == 409 and again.json()["url"] == created["url"]  # one open campaign per user per kit
    assert again.json()["detail"]

    page = client.get(f"/api/campaigns/{campaign_id}").json()
    assert page == {
        "id": campaign_id, "status": "open", "accepting": True, "kit_token": kit["token"], "kit_url": f"/k/{kit['token']}",
        "survey_url": f"/s/{world['run_id']}?sheet=0", "name": kit["name"], "place": page["place"],
        "concept": page["concept"], "evidence": page["evidence"], "title": drafted["title"], "pitch": drafted["pitch"],
        "perks": drafted["perks"], "how_it_works": drafted["how_it_works"], "amount": "25.00", "currency": "USD",
        "goal": 3, "deadline": page["deadline"], "closed_at": None,
        "progress": {"supporters": 0, "goal": 3, "remaining": 3, "percent": 0, "total": "0.00", "funded": False},
        "is_owner": True,
        "owner": {"counts": page["owner"]["counts"], "report": None,
                  "payout": {"status": "none", "amount": None, "email": "o***@example.com"}},
    }
    assert page["place"]["label"] == "Test Corner, Testville" and page["place"]["area"] == "10-minute walk"
    assert isinstance(page["place"]["lat"], float) and isinstance(page["place"]["lon"], float)
    assert page["concept"]["genre"] and page["concept"]["summary"] and page["deadline"].endswith("Z")
    assert 1 <= len(page["evidence"]) <= 3 and all(isinstance(line, str) and line for line in page["evidence"])
    assert set(page["owner"]["counts"]) >= {"created", "authorized", "captured", "voided", "withdrawn"}
    [row] = table(client, campaigns)
    assert (row["user_id"], row["payout_email"], row["kit_token"]) == (world["owner"]["id"], EMAIL, kit["token"])

    client.post("/api/auth/logout")
    public = client.get(f"/api/campaigns/{campaign_id}").json()
    assert public["is_owner"] is False and "owner" not in public  # the payout email is the owner's to see
    assert EMAIL not in str(public)
    assert client.get("/api/campaigns/no-such-campaign").status_code == 404
    assert client.get("/api/campaigns/bad%20id!").status_code == 422

    # Another signed-in user may start a campaign from the same kit (examples included): it is theirs.
    other = dev_sign_in(client, "neighbor@example.com", "Nora Neighbor")
    theirs = start(world)
    assert theirs != campaign_id and table(client, campaigns)[1]["user_id"] == other["id"]


def test_the_terms_and_the_edited_words_are_checked_and_bad_terms_ask_no_model(world):
    client = world["client"]
    bad = client.post("/api/campaigns/draft", json=terms(world, days=40, amount="500.00", goal=1)).json()
    assert bad["title"] == "" and bad["perks"] == [] and len(bad["problems"]) == 3
    assert any("27 days" in problem for problem in bad["problems"])
    assert client.post("/api/campaigns/draft", json={**terms(world), "deadline": "next week"}).json()["problems"]
    assert client.post("/api/campaigns/draft", json={**terms(world), "deadline": "2026-11-01T12:00:00"}).json()["problems"]
    assert client.post("/api/campaigns/draft", json={**terms(world), "amount": 25.0}).json()["problems"]  # no floats
    too_long = client.post("/api/campaigns/draft", json=terms(world, perk="x" * 81)).json()
    assert too_long["problems"] and "perk" in too_long["problems"][0]
    assert offers_asked(world) == 0  # no draft, no model

    drafted = client.post("/api/campaigns/draft", json=terms(world)).json()
    body = {**terms(world), "payout_email": EMAIL, **{key: drafted[key] for key in ("title", "pitch", "perks")}}

    def refused(**changes) -> list[str]:
        answer = client.post("/api/campaigns", json={**body, **changes})
        assert answer.status_code == 422, answer.text
        assert answer.json()["detail"]
        return answer.json()["problems"]

    assert refused(goal=1) == ["The goal must be 3 to 500 supporters."]
    assert refused(payout_email="not an email") == ["The payout email is not an email address PayPal can pay."]
    assert refused(payout_email=None) == ["Give the PayPal email that receives the money."]
    assert refused(perks=["A free coffee on every visit"]) == ["Perk 1 promises a discount the owner did not set."]
    assert refused(perks=[]) == ["Add 1 to 4 perks."]
    # The goal is always a known number; a literal 9 depends on the deadline's calendar day.
    price = body["goal"]
    assert refused(pitch=f"Burgers from ${price}, the best in town.") == [
        f"The pitch states the price ${price}: the pledge is the only amount the page gives."]
    assert refused(pitch="Bring 99999 neighbors together.") == [
        "The pitch states 99999, a number the inputs do not have."]
    assert refused(title="The best place on the block") == ['The title says "best", which nothing measured proves.']
    assert refused(title="Run by chef Marco from the corner") == ["The title names Marco."]
    assert table(client, campaigns) == []

    assert client.post("/api/campaigns/draft", json={**terms(world), "kit_token": "no-such-kit"}).status_code == 404
    assert client.post("/api/campaigns", json={**body, "kit_token": "no-such-kit"}).status_code == 404
    client.post("/api/auth/logout")
    assert client.post("/api/campaigns/draft", json=terms(world)).status_code == 401
    assert client.post("/api/campaigns", json=body).status_code == 401


def drafting_llm(draft: dict) -> LLM:
    """A model that drafts these words, whatever it is asked."""
    def handler(request: httpx.Request) -> httpx.Response:
        message = {"role": "assistant", "content": json.dumps(draft)}
        return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 0, "model": "test-model",
                                         "choices": [{"index": 0, "finish_reason": "stop", "message": message}]})

    return LLM("test-key", "https://llm.test/v1/", "test-model",
               http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_a_perk_that_only_restates_the_pledge_is_refused_in_the_draft_and_the_campaign(world, monkeypatch):
    client = world["client"]
    restated = "The perk only restates the pledge: say what founding supporters get beyond it, or leave it empty."
    for perk in ("Pledge $25", "$25 pledge", "A $25 contribution", f"Back {world['kit']['name']} with $25.00"):
        answer = client.post("/api/campaigns/draft", json=terms(world, perk=perk)).json()
        assert (answer["problems"], answer["perks"]) == ([restated], []), perk
    assert offers_asked(world) == 0  # no draft, no model

    # The AI's perks keep the same rule: the pledge itself never comes back as one.
    monkeypatch.setattr(client.app.state.services, "llm", drafting_llm({
        "title": "Back it", "pitch": "Come by.",
        "perks": ["Pledge $25.00 to become a founding supporter.", "An invitation to the opening night"],
    }))
    drafted = client.post("/api/campaigns/draft", json=terms(world)).json()
    assert drafted["problems"] == [] and drafted["perks"] == ["An invitation to the opening night"]

    body = {**terms(world), "payout_email": EMAIL, **{key: drafted[key] for key in ("title", "pitch", "perks")}}
    edited = client.post("/api/campaigns", json={**body, "perks": [*drafted["perks"], "A $25 contribution"]})
    assert edited.status_code == 422 and edited.json()["problems"] == [
        "Perk 2 only restates the pledge: say what founding supporters get beyond it."]
    own = client.post("/api/campaigns", json={**body, "perk": "Pledge $25", "perks": ["Pledge $25"]})
    assert own.status_code == 422 and own.json()["problems"] == [restated]
    assert table(client, campaigns) == []
    assert client.post("/api/campaigns", json=body).status_code == 200


def test_a_kit_still_building_starts_no_campaign(world):
    client = world["client"]
    # Built first: a build still running would end by marking the kit ready (KitStore.finish), over the change below.
    made = ready_kit(client, world["run_id"], index=1)
    change(client, kits, kits.c.token == made["token"], status="building")
    answer = client.post("/api/campaigns/draft", json=terms(world, kit={"token": made["token"]}))
    assert answer.status_code == 409 and "ready" in answer.json()["detail"]


def test_supporters_pledge_with_the_buttons_or_a_redirect_and_are_held_once(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    client.post("/api/auth/logout")  # supporters need no account

    buttons = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": "buttons"}).json()
    assert buttons["approve_url"] is None and buttons["order_id"]
    [row] = table(client, pledges)
    request = paypal.orders[buttons["order_id"]]["request"]
    unit = request["purchase_units"][0]
    assert request["intent"] == "AUTHORIZE" and unit["amount"] == {"currency_code": "USD", "value": "25.00"}
    assert unit["custom_id"] == row["id"] and unit["reference_id"] == campaign_id
    assert unit["description"] == f"Founding supporter: {world['kit']['name']}"
    context = request["payment_source"]["paypal"]["experience_context"]
    assert context["user_action"] == "CONTINUE" and context["shipping_preference"] == "NO_SHIPPING"
    assert context["return_url"] == f"http://testserver/p/{campaign_id}?pledge={row['id']}"
    assert context["cancel_url"] == f"http://testserver/p/{campaign_id}?cancelled=1"
    assert (row["status"], row["flow"], row["amount_cents"]) == ("created", "buttons", 2500)
    assert client.post(f"/api/campaigns/{campaign_id}/pledges").json()["approve_url"] is None  # buttons by default

    redirect = client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": "redirect"}).json()
    assert redirect["approve_url"] == f"https://www.sandbox.paypal.com/checkoutnow?token={redirect['order_id']}"
    assert client.post(f"/api/campaigns/{campaign_id}/pledges", json={"flow": "carrier pigeon"}).status_code == 422

    held = client.post(f"/api/campaigns/{campaign_id}/pledges/{buttons['order_id']}/authorize")
    assert held.json() == {"status": "authorized", "progress": {
        "supporters": 1, "goal": 3, "remaining": 2, "percent": 33, "total": "25.00", "funded": False}}
    again = client.post(f"/api/campaigns/{campaign_id}/pledges/{buttons['order_id']}/authorize")
    assert again.json() == held.json()  # idempotent: PayPal is not asked to hold it twice
    assert len(paypal.calls(r"/v2/checkout/orders/[^/]+/authorize")) == 1

    # PayPal sends the redirect's supporter back to /p/{id}?pledge=<pledge id>: that id holds the pledge too.
    pledge_id = next(r["id"] for r in table(client, pledges) if r["order_id"] == redirect["order_id"])
    back = client.post(f"/api/campaigns/{campaign_id}/pledges/{pledge_id}/authorize")
    assert back.json()["status"] == "authorized" and back.json()["progress"]["supporters"] == 2
    stored = {r["order_id"]: r for r in table(client, pledges)}[redirect["order_id"]]
    assert stored["status"] == "authorized" and stored["authorization_id"] and stored["payer_id"]
    assert stored["authorized_at"] and stored["expires_at"] - stored["authorized_at"] == timedelta(days=29)
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/UNKNOWN/authorize").status_code == 404


def test_a_declined_payment_method_answers_402_and_can_be_retried(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    order_id = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    paypal.decline.append(order_id)
    declined = client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
    assert declined.status_code == 402 and declined.json()["retry"] is True and declined.json()["detail"]
    assert table(client, pledges)[0]["status"] == "created"  # nothing counted, nothing lost
    held = client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
    assert held.status_code == 200 and held.json()["status"] == "authorized"

    # A hold PayPal denies is a declined pledge: it never counts, and saying so again is idempotent.
    denied = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    paypal.deny.append(denied)
    first = client.post(f"/api/campaigns/{campaign_id}/pledges/{denied}/authorize").json()
    assert first == {"status": "declined", "progress": held.json()["progress"]}
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{denied}/authorize").json() == first

    # Not approved in PayPal yet: nothing is held.
    waiting = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    paypal.unapproved.add(waiting)
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{waiting}/authorize").status_code == 409


def test_supporters_withdraw_while_the_campaign_is_open(world):
    client, paypal, clock = world["client"], world["paypal"], world["clock"]
    campaign_id = start(world)
    first, _ = pledge(client, campaign_id)
    second, _ = pledge(client, campaign_id)
    withdrawn = client.post(f"/api/campaigns/{campaign_id}/pledges/{first}/withdraw")
    assert withdrawn.json() == {"status": "withdrawn", "progress": {
        "supporters": 1, "goal": 3, "remaining": 2, "percent": 33, "total": "25.00", "funded": False}}
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{first}/withdraw").json()["status"] == "withdrawn"
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/void")) == 1  # once
    assert {r["order_id"]: r["status"] for r in table(client, pledges)}[first] == "withdrawn"
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{first}/authorize").status_code == 409
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/NOPE/withdraw").status_code == 404

    # A pledge never approved is withdrawn without PayPal: nothing is held.
    never = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    assert client.post(f"/api/campaigns/{campaign_id}/pledges/{never}/withdraw").json()["status"] == "withdrawn"
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/void")) == 1

    clock.advance(days=10, minutes=1)  # past the deadline, before it is settled
    late = client.post(f"/api/campaigns/{campaign_id}/pledges/{second}/withdraw")
    assert late.status_code == 409 and "closed" in late.json()["detail"]
    assert client.post(f"/api/campaigns/{campaign_id}/pledges").status_code == 409  # no new pledges either


def test_closing_needs_the_goal_and_cancelling_releases_every_hold(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    pledge(client, campaign_id)
    early = client.post(f"/api/campaigns/{campaign_id}/close")
    assert early.status_code == 409 and "cancel" in early.json()["detail"]
    dev_sign_in(client, "someone@example.com")
    assert client.post(f"/api/campaigns/{campaign_id}/cancel").status_code == 403
    assert client.post(f"/api/campaigns/{campaign_id}/close").status_code == 403
    client.post("/api/auth/logout")
    assert client.post(f"/api/campaigns/{campaign_id}/cancel").status_code == 401
    dev_sign_in(client)
    cancelled = client.post(f"/api/campaigns/{campaign_id}/cancel").json()
    assert (cancelled["status"], cancelled["accepting"], cancelled["closed_at"] is not None) == ("cancelled", False, True)
    assert cancelled["owner"]["counts"]["voided"] == 1 and cancelled["owner"]["report"] == []
    assert cancelled["owner"]["payout"]["status"] == "none"
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/void")) == 1
    assert paypal.calls(r"/v2/payments/authorizations/[^/]+/capture") == []
    assert client.post(f"/api/campaigns/{campaign_id}/cancel").json()["status"] == "cancelled"  # idempotent
    assert table(client, campaigns)[0]["funded"] is False
    assert start(world) != campaign_id  # the kit may start another campaign now

    funded = table(client, campaigns)[1]["id"]
    for _ in range(3):
        pledge(client, funded)
    met = client.post(f"/api/campaigns/{funded}/cancel")
    assert met.status_code == 409 and "close it" in met.json()["detail"]


def authorize_path(campaign_id: str, order_id: str) -> tuple[str, str]:
    return "POST", f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize"


def authorization_of(paypal: FakePayPal, order_id: str) -> dict:
    return next(held for held in paypal.authorizations.values() if held["order_id"] == order_id)


def test_the_owner_s_close_waits_for_a_pledge_paypal_is_holding_and_collects_it_too(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    for _ in range(3):
        pledge(client, campaign_id)
    fourth = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    held, closed = race(client, authorize_path(campaign_id, fourth), ("POST", f"/api/campaigns/{campaign_id}/close"),
                        paused="authorize_order")
    assert held.status_code == 200 and held.json()["status"] == "authorized", held.text
    assert closed.status_code == 200, closed.text
    page = closed.json()
    assert (page["status"], page["owner"]["counts"]["captured"], page["owner"]["counts"]["authorized"]) == ("collected", 4, 0)
    assert {row["status"] for row in table(client, pledges)} == {"captured"}  # no hold left after the close
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/capture")) == 4
    assert paypal.calls(r"/v2/payments/authorizations/[^/]+/void") == []
    assert page["owner"]["payout"]["amount"] == "94.56"  # four pledges, after PayPal's fees


def test_cancelling_waits_for_a_pledge_paypal_is_holding_and_then_finds_the_goal_met(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    for _ in range(2):
        pledge(client, campaign_id)
    third = client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"]
    held, cancelled = race(client, authorize_path(campaign_id, third), ("POST", f"/api/campaigns/{campaign_id}/cancel"),
                           paused="authorize_order")
    assert held.status_code == 200 and held.json()["progress"]["funded"] is True, held.text
    assert cancelled.status_code == 409 and "close it" in cancelled.json()["detail"]
    [row] = table(client, campaigns)
    assert (row["status"], row["closed_at"], row["funded"]) == ("open", None, None)
    assert [pledge["status"] for pledge in table(client, pledges)] == ["authorized"] * 3
    assert paypal.calls(r"/v2/payments/authorizations/[^/]+/void") == []


def test_closing_waits_for_a_withdrawal_and_then_finds_the_goal_no_longer_met(world):
    client, paypal = world["client"], world["paypal"]
    campaign_id = start(world)
    orders = [pledge(client, campaign_id)[0] for _ in range(3)]
    withdrawn, closed = race(client, ("POST", f"/api/campaigns/{campaign_id}/pledges/{orders[0]}/withdraw"),
                             ("POST", f"/api/campaigns/{campaign_id}/close"), paused="void_authorization")
    assert withdrawn.status_code == 200 and withdrawn.json()["progress"]["supporters"] == 2, withdrawn.text
    assert closed.status_code == 409 and "cancel" in closed.json()["detail"]  # not cancelled in the owner's place
    [row] = table(client, campaigns)
    assert (row["status"], row["closed_at"], row["funded"]) == ("open", None, None)
    assert sorted(pledge["status"] for pledge in table(client, pledges)) == ["authorized", "authorized", "withdrawn"]
    assert len(paypal.calls(r"/v2/payments/authorizations/[^/]+/void")) == 1
    assert paypal.calls(r"/v2/payments/authorizations/[^/]+/capture") == []


def test_a_hold_placed_after_the_campaign_stopped_taking_pledges_is_released_and_never_counts(world, monkeypatch):
    client, paypal, clock = world["client"], world["paypal"], world["clock"]
    campaign_id = start(world)
    pledge(client, campaign_id)
    by_page, by_webhook, slow = (client.post(f"/api/campaigns/{campaign_id}/pledges").json()["order_id"] for _ in range(3))
    service = client.app.state.services.paypal
    real = service.authorize_order

    async def answer_lost(order_id: str, request_id: str) -> dict:
        await real(order_id, request_id)  # PayPal holds the money, but its answer never arrives
        raise PayPalError(0, "TIMEOUT", "PayPal did not answer in time")

    monkeypatch.setattr(service, "authorize_order", answer_lost)
    for order_id in (by_page, by_webhook):
        lost = client.post(f"/api/campaigns/{campaign_id}/pledges/{order_id}/authorize")
        assert lost.status_code == 502 and authorization_of(paypal, order_id)["status"] == "CREATED"

    async def past_the_deadline(order_id: str, request_id: str) -> dict:
        clock.advance(days=10, minutes=1)  # the campaign closes while PayPal places the hold
        return await real(order_id, request_id)

    monkeypatch.setattr(service, "authorize_order", past_the_deadline)
    late = client.post(f"/api/campaigns/{campaign_id}/pledges/{slow}/authorize")
    assert late.status_code == 409 and "nothing will be charged" in late.json()["detail"]
    assert authorization_of(paypal, slow)["status"] == "VOIDED"

    # The supporters whose answers were lost come back after the close, one by the page, one by PayPal's webhook.
    again = client.post(f"/api/campaigns/{campaign_id}/pledges/{by_page}/authorize")
    assert again.status_code == 409 and "nothing will be charged" in again.json()["detail"]
    hold = next(name for name, held in paypal.authorizations.items() if held["order_id"] == by_webhook)
    created = {"id": hold, "status": "CREATED", "supplementary_data": {"related_ids": {"order_id": by_webhook}}}
    assert webhook(client, "WH-LATE-HOLD", "PAYMENT.AUTHORIZATION.CREATED", created).json() == {"status": "ok"}
    for order_id in (by_page, by_webhook, slow):
        assert authorization_of(paypal, order_id)["status"] == "VOIDED", order_id
    rows = {row["order_id"]: row for row in table(client, pledges)}
    assert [rows[order_id]["status"] for order_id in (by_page, by_webhook, slow)] == ["voided"] * 3
    assert client.post("/api/cron/settle", headers={"x-cron-secret": CRON_SECRET}).status_code == 200
    page = client.get(f"/api/campaigns/{campaign_id}").json()
    assert page["status"] == "expired" and page["progress"]["supporters"] == 0  # none of them ever counted
    assert all(held["status"] == "VOIDED" for held in paypal.authorizations.values())


def test_open_campaigns_are_found_near_a_place_or_newest_first(world):
    client, clock = world["client"], world["clock"]
    second_kit = ready_kit(client, world["run_id"], 1)
    near = start(world)
    clock.advance(minutes=5)
    far = start(world, kit=second_kit)
    pledge(client, near)
    row = next(r for r in table(client, campaigns) if r["id"] == near)
    lat, lon = row["lat"], row["lon"]
    change(client, campaigns, campaigns.c.id == far, lat=lat + 0.2, lon=lon)  # about 22 km north

    newest = client.get("/api/campaigns").json()["campaigns"]
    assert [c["id"] for c in newest] == [far, near]
    listed = newest[1]
    assert listed == {
        "id": near, "url": f"/p/{near}", "title": row["title"], "name": world["kit"]["name"],
        "place": {"label": "Test Corner, Testville", "lat": lat, "lon": lon}, "distance_km": None, "amount": "25.00",
        "goal": 3, "supporters": 1, "total": "25.00", "deadline": listed["deadline"],
    }
    around = client.get("/api/campaigns", params={"lat": lat, "lon": lon}).json()["campaigns"]
    assert [(c["id"], c["distance_km"]) for c in around] == [(near, 0.0), (far, 22.2)]
    assert [c["id"] for c in client.get("/api/campaigns", params={"lat": lat, "lon": lon, "km": 10}).json()["campaigns"]] == [near]
    assert client.get("/api/campaigns", params={"lat": lat + 0.2, "lon": lon, "km": 1}).json()["campaigns"][0]["id"] == far
    assert client.get("/api/campaigns", params={"lat": lat}).status_code == 400
    assert client.get("/api/campaigns", params={"lat": lat, "lon": lon, "km": 101}).status_code == 422
    assert client.get("/api/campaigns", params={"lat": 91, "lon": lon}).status_code == 422

    client.post(f"/api/campaigns/{far}/cancel")
    assert [c["id"] for c in client.get("/api/campaigns").json()["campaigns"]] == [near]  # open ones only
    clock.advance(days=11)
    assert client.get("/api/campaigns").json()["campaigns"] == []  # past its deadline


def test_config_my_places_and_the_kit_page_show_campaigns(world):
    client, kit = world["client"], world["kit"]
    config = client.get("/api/config").json()
    assert config["paypal"] == {"enabled": True, "client_id": "test-paypal-client", "environment": "sandbox",
                                "currency": "USD"}
    assert config["surveys_paused"] is False
    kit_campaigns = f"/api/kits/{kit['token']}/campaigns"
    assert client.get(kit_campaigns).json() == {"campaigns": []}

    mine = start(world)
    pledge(client, mine)
    assert client.get("/api/me/places").json()["campaigns"] == [{
        "id": mine, "title": table(client, campaigns)[0]["title"], "status": "open", "supporters": 1, "total": "25.00",
        "goal": 3, "deadline": client.get(f"/api/campaigns/{mine}").json()["deadline"], "url": f"/p/{mine}",
    }]
    world["clock"].advance(minutes=1)
    dev_sign_in(client, "neighbor@example.com")
    theirs = start(world)
    assert client.get("/api/me/places").json()["campaigns"][0]["id"] == theirs

    def listed() -> list[tuple]:
        return [(c["id"], c["is_owner"], c["supporters"]) for c in client.get(kit_campaigns).json()["campaigns"]]

    assert listed() == [(theirs, True, 0), (mine, False, 1)]  # the viewer's own first
    dev_sign_in(client)
    assert listed() == [(mine, True, 1), (theirs, False, 0)]
    page = client.get(kit_campaigns).json()["campaigns"][0]
    assert page == {"id": mine, "url": f"/p/{mine}", "is_owner": True, "status": "open", "amount": "25.00", "goal": 3,
                    "supporters": 1, "total": "25.00", "deadline": page["deadline"]}
    client.post("/api/auth/logout")
    assert listed() == [(theirs, False, 0), (mine, False, 1)]  # signed out: the newest first
    world["clock"].advance(days=11)
    assert listed() == []  # past their deadline, they take no pledges


def test_the_kit_page_is_one_for_everyone_and_its_campaigns_are_never_kept(world):
    """A kit's page may be kept in memory and by the front door, one copy for every visitor (app.cache_policy), so no
    campaign is in it: campaigns change with every pledge and say which one is the viewer's own, so they have an
    endpoint of their own that nothing keeps."""
    client, kit = world["client"], world["kit"]
    page = f"/api/kits/{kit['token']}"
    mine = start(world)
    pledge(client, mine)
    as_owner = client.get(page)
    client.post("/api/auth/logout")
    as_visitor = client.get(page)
    assert "campaigns" not in as_owner.json() and as_owner.json() == as_visitor.json()
    listed = client.get(f"{page}/campaigns")
    assert listed.headers["cache-control"] == "no-store"
    assert [(c["id"], c["is_owner"], c["supporters"]) for c in listed.json()["campaigns"]] == [(mine, False, 1)]


def test_without_paypal_nobody_can_pledge(monkeypatch):
    with make_client() as client:
        config = client.get("/api/config").json()
        assert config["paypal"] == {"enabled": False, "client_id": None, "environment": "sandbox", "currency": "USD"}
        run_id = run_survey(client)
        kit = ready_kit(client, run_id)
        dev_sign_in(client)
        world = {"client": client, "clock": Clock(), "kit": kit}
        campaign_id = start(world)
        answer = client.post(f"/api/campaigns/{campaign_id}/pledges")
        assert answer.status_code == 503 and "PayPal" in answer.json()["detail"]
        assert client.post("/api/paypal/webhook", content=b"{}").status_code == 404
    configure(monkeypatch, paypal_env="live")
    with make_client(paypal=FakePayPal()) as client:
        assert client.get("/api/config").json()["paypal"]["environment"] == "live"


def test_paused_surveys_answer_503_and_the_rest_still_works(monkeypatch):
    configure(monkeypatch, surveys_paused=True)
    with make_client(paypal=FakePayPal()) as client:
        answer = client.get("/api/run", params={"lat": 40.0, "lon": -73.0})
        assert answer.status_code == 503
        assert answer.json() == {"detail": "New surveys are paused; open one of the surveyed storefronts"}
        assert client.get("/api/config").json()["surveys_paused"] is True
        assert client.get("/api/campaigns").json() == {"campaigns": []}


def test_paypal_and_the_scheduler_are_not_held_to_the_origin_check(monkeypatch):
    configure(monkeypatch, public_url="https://walk-in.example.com", auth_dev_login=False)
    with make_client(paypal=FakePayPal()) as client:
        evil = {"origin": "https://evil.example.com"}
        assert client.post("/api/campaigns/abc/pledges", headers=evil).status_code == 403
        assert client.post("/api/cron/settle", headers={**evil, "x-cron-secret": CRON_SECRET}).json() == {
            "settled": [], "payouts": []}
        assert webhook(client, "WH-ORIGIN", "SOMETHING.ELSE", {}, headers=evil).json() == {"status": "ignored"}


def test_pledges_and_drafts_are_rate_limited_per_address(world):
    client = world["client"]
    campaign_id = start(world)
    client.app.state.pledge_limiter.limit = 1
    assert client.post(f"/api/campaigns/{campaign_id}/pledges").status_code == 200
    limited = client.post(f"/api/campaigns/{campaign_id}/pledges")
    assert limited.status_code == 429 and "Too many pledges" in limited.json()["detail"]
    other = client.post(f"/api/campaigns/{campaign_id}/pledges", headers={"x-forwarded-for": "198.51.100.7"})
    assert other.status_code == 200  # another address has its own allowance
    client.app.state.draft_limiter.limit = 0
    assert client.post("/api/campaigns/draft", json=terms(world)).status_code == 429
    assert client.post("/api/campaigns/draft", json=terms(world, goal=1)).json()["problems"]  # problems cost nothing


def test_campaign_pages_are_pages_of_the_web_app(world):
    client = world["client"]
    campaign_id = start(world)
    for path in (f"/p/{campaign_id}", "/p/anything", "/founders"):
        page = client.get(path)
        assert page.status_code == 200 and page.headers["content-type"].startswith("text/html"), path
        policy = page.headers["content-security-policy"]
        assert "https://www.sandbox.paypal.com https://www.paypal.com" in policy
