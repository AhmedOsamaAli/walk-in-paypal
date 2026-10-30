"""Walk-in Founders' campaigns. A signed-in owner starts one from any ready launch kit (the examples' included): the
owner sets the money terms, the AI drafts the words from the kit's concept and the survey's evidence, the owner edits
them and the server checks them again. Neighbors pledge with PayPal without an account: each pledge is an AUTHORIZE
order, so PayPal only holds the money, and a supporter may withdraw while the campaign is open, on its page or with the
pledge's private receipt (app.routes.receipts). It settles when it closes (app.settlement), and the owner is paid the
net collected total. Holding or withdrawing a pledge, and the owner's close or cancel, take the settlement's lock, so no
pledge changes while its campaign closes or settles."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field

from .. import auth
from ..config import settings
from ..kits import designed
from ..payments import pledges, receipts
from ..payments.paypal import RESOURCE_ID, PayPalError, approval_url, authorized_in_full, request_key
from ..payments.records import (
    CURRENCY,
    Problem,
    campaign_of,
    email_problem,
    iso,
    major,
    mask_email,
    minor,
    paypal_client,
    paypal_problem,
    progress_of,
    public_progress,
)
from ..ratelimit import client_ip
from ..settlement import Refused
from ..survey.kit import place_texts

log = logging.getLogger("walkin")
router = APIRouter(prefix="/api")
CAMPAIGN_ID = r"^[A-Za-z0-9_-]{1,32}$"
# A pledge's PayPal order id, or our own pledge id (the redirect flow's return link carries it).
PLEDGE_REF = r"^[A-Za-z0-9_-]{1,64}$"
NEAR_KM, MAX_KM, LISTED = 25.0, 100.0, 50
# A hold PayPal placed once its campaign had stopped taking pledges: released at once, never counted.
CLOSED_WHILE_HELD = (
    "This campaign stopped taking pledges before this one could count, so PayPal's hold was released: nothing will be "
    "charged."
)
# How far after the close such a hold is dated when PayPal cannot release it yet, so settlement releases it.
LATE = timedelta(seconds=1)


class MoneyTerms(BaseModel):
    """The owner's terms. They are checked by pledges.validate_campaign, which says what is wrong in plain words."""

    amount: Any = Field(None, description='Each pledge, "5.00" to "200.00"', examples=["25.00"])
    goal: Any = Field(None, description="Supporters needed, 3 to 500", examples=[40])
    deadline: Any = Field(None, description="ISO 8601 with a time zone, 1 to 27 days away")
    perk: Any = Field(None, description="What founding supporters get, in the owner's words, or null",
                      examples=["10% off every visit in the first year"])


class Terms(MoneyTerms):
    kit_token: str = Field(..., min_length=1, max_length=64, description="The ready launch kit the campaign starts from")


class NewCampaign(Terms):
    payout_email: Any = Field(None, description="The PayPal email that receives the money")
    title: Any = None
    pitch: Any = None
    perks: Any = None


class PledgeRequest(BaseModel):
    flow: Literal["buttons", "redirect"] = Field(
        "buttons", description="buttons: the page's PayPal buttons approve it; redirect: PayPal's approval link, for an "
                               "assistant to hand to the person",
    )


def deadline_of(value: Any) -> Any:
    """An ISO 8601 deadline as a datetime; anything else is left for validate_campaign to explain."""
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return value
    return value


def perk_of(value: Any) -> str | None:
    """The owner's perk line with its spacing tidied, or None."""
    if not isinstance(value, str):
        return None
    return " ".join(value.split()) or None


def check_terms(body: MoneyTerms, now: datetime, name: str | None = None) -> tuple[Any, list[str]]:
    """The deadline as a datetime, and what is wrong with the owner's terms; the perk line must offer something beyond
    the pledge (`name` is the business's, which a perk may mention)."""
    deadline = deadline_of(body.deadline)
    problems = pledges.validate_campaign(body.amount, body.goal, deadline, now, CURRENCY)
    perk = body.perk
    if perk is not None and (not isinstance(perk, str) or len(" ".join(perk.split())) > pledges.PERK_LIMIT):
        problems.append(f"Write the perk in at most {pledges.PERK_LIMIT} characters: it leads the perks.")
    elif pledges.restates_pledge(perk_of(perk), body.amount, [name] if name else []):
        problems.append(f"The perk {pledges.RESTATES}, or leave it empty.")
    return deadline, problems


async def ready_kit(request: Request, token: str) -> dict:
    """A ready launch kit, with its payload: anyone's, the examples' included."""
    kit = await request.app.state.kits.kit(token)
    if kit is None:
        raise HTTPException(404, "Kit not found.")
    if kit["status"] != "ready":
        raise HTTPException(409, "Start a campaign once the kit is ready.")
    return kit


async def survey_behind(request: Request, kit: dict):
    """The kit's survey and the concept's design sheet."""
    state = request.app.state
    run = await state.runs.fetch(kit["survey_id"])
    if run is None or not 0 <= kit["idx"] < len(run.concepts):
        raise HTTPException(409, "The survey behind this kit is no longer saved, so a campaign cannot start from it.")
    return run, await designed(state.services, state.surveys, run, kit["idx"])


def kit_claims(kit: dict, sheet: dict) -> list[dict]:
    """The claims the kit's ads were allowed to make, else the launch plan's."""
    payload = kit.get("payload") if isinstance(kit.get("payload"), dict) else {}
    claims = payload.get("claims")
    if isinstance(claims, list):
        return [claim for claim in claims if isinstance(claim, dict)]
    return [claim for claim in (sheet.get("launch") or {}).get("claims") or [] if isinstance(claim, dict)]


def offer_inputs(kit: dict, run, sheet: dict, body: Terms, deadline: datetime) -> dict:
    """What draft_offer and offer_problems are given: the owner's terms and the survey's evidence."""
    return {
        "amount": body.amount, "goal": body.goal, "deadline": deadline, "currency": CURRENCY, "perk": perk_of(body.perk),
        "concept": run.concepts[kit["idx"]], "claims": kit_claims(kit, sheet), "place": run.site.label,
        "avoid": place_texts(run),
    }


async def campaign_row(request: Request, campaign_id: str) -> dict:
    row = await request.app.state.campaigns.get(campaign_id)
    if row is None:
        raise HTTPException(404, "Campaign not found.")
    return row


async def owners_campaign(request: Request, campaign_id: str, user: dict) -> dict:
    row = await campaign_row(request, campaign_id)
    if row["user_id"] != user["id"]:
        raise HTTPException(403, "Only the campaign's owner can do that.")
    return row


async def progress_now(request: Request, row: dict, at: datetime | None = None) -> dict:
    found = await request.app.state.campaigns.pledges([row["id"]])
    return progress_of(row, found, at or request.app.state.now())


def place_of(row: dict) -> dict:
    place = (row["offer"] or {}).get("place") or {}
    return {
        "label": place.get("label") or "", "lat": row["lat"], "lon": row["lon"], "area": place.get("area") or "",
    }


def payout_view(row: dict, payout: dict | None) -> dict:
    """The payout as its owner sees it, the email masked."""
    if payout is None:
        return {"status": "none", "amount": None, "email": mask_email(row["payout_email"])}
    return {
        "status": payout["status"], "amount": major(payout["amount_cents"], payout["currency"]),
        "email": mask_email(payout["email"]),
    }


async def campaign_view(request: Request, row: dict) -> dict:
    """The campaign page: the business, the place, why this and why here, the pitch and the progress; for its owner
    also the pledges by status, the settlement report and the payout."""
    state = request.app.state
    user = await auth.current_user(request)
    now = state.now()
    campaign = campaign_of(row)
    progress = await progress_now(request, row, now)
    offer = row["offer"] or {}
    owner = user is not None and user["id"] == row["user_id"]
    view = {
        "id": row["id"],
        "status": row["status"],
        "accepting": pledges.accepting(campaign, now),
        "kit_token": row["kit_token"],
        "kit_url": f"/k/{row['kit_token']}" if row["kit_token"] else None,
        "survey_url": f"/s/{row['survey_id']}?sheet={row['idx']}" if row["survey_id"] else None,
        "name": offer.get("name") or "",
        "place": place_of(row),
        "concept": offer.get("concept") or {"genre": "", "summary": ""},
        "evidence": offer.get("evidence") or [],
        "title": row["title"],
        "pitch": offer.get("pitch") or "",
        "perks": offer.get("perks") or [],
        "how_it_works": offer.get("how_it_works") or "",
        "amount": campaign.amount,
        "currency": campaign.currency,
        "goal": campaign.goal,
        "deadline": iso(campaign.deadline),
        "closed_at": iso(campaign.closed_at),
        "progress": public_progress(progress),
        "is_owner": owner,
    }
    if row["kit_token"] is None:
        view["source"] = "owner"
    if owner:
        view["owner"] = {
            "counts": progress["counts"],
            "report": row["report"],
            "payout": payout_view(row, await state.campaigns.payout(row["id"])),
        }
    return view


def public_base(request: Request) -> str:
    """Where PayPal sends the supporter back: PUBLIC_URL, else this server's own address."""
    return settings.public_url or (auth.own_origin(request) or str(request.base_url)).rstrip("/")


@router.post("/campaigns/draft")
async def draft(request: Request, body: Terms, user: auth.SignedIn) -> dict:
    """The campaign's words drafted from the kit's concept and the survey's evidence; the owner's terms go in unchanged
    and the AI sets no number. When the terms are not allowed, `problems` says why and nothing is drafted."""
    state = request.app.state
    kit = await ready_kit(request, body.kit_token)
    deadline, problems = check_terms(body, state.now(), kit["name"])
    if problems:
        return {"title": "", "pitch": "", "perks": [], "how_it_works": "", "problems": problems}
    if not state.draft_limiter.allow(client_ip(request)):
        raise HTTPException(429, "Too many drafts from this address. Try again later.")
    run, sheet = await survey_behind(request, kit)
    services = state.services
    offer = await pledges.draft_offer(services.llm, sheet, answers=services.answers, **offer_inputs(kit, run, sheet, body, deadline))
    return {key: offer[key] for key in ("title", "pitch", "perks", "how_it_works")} | {"problems": []}


@router.post("/campaigns")
async def create(request: Request, body: NewCampaign, user: auth.SignedIn) -> dict:
    """Starts the campaign on the owner's terms and words, once both keep the rules; one open campaign per user per
    kit. The owner's PayPal email receives the money."""
    state = request.app.state
    kit = await ready_kit(request, body.kit_token)
    running = await state.campaigns.open_for(user["id"], kit["token"])
    if running:
        raise Problem(409, "You already have an open campaign for this kit.", url=f"/p/{running['id']}")
    now = state.now()
    deadline, problems = check_terms(body, now, kit["name"])
    email = email_problem(body.payout_email)
    if email:
        problems.append(email)
    if problems:
        raise Problem(422, " ".join(problems), problems=problems)
    run, sheet = await survey_behind(request, kit)
    inputs = offer_inputs(kit, run, sheet, body, deadline)
    problems = pledges.offer_problems(sheet, title=body.title, pitch=body.pitch, perks=body.perks, **inputs)
    if problems:
        raise Problem(422, " ".join(problems), problems=problems)
    campaign = pledges.new_campaign(uuid.uuid4().hex[:16], body.amount, body.goal, deadline, now, CURRENCY)
    concept = run.concepts[kit["idx"]]
    payload = kit.get("payload") if isinstance(kit.get("payload"), dict) else {}
    name = kit["name"] or (payload.get("concept") or {}).get("name") or str(concept.get("name") or "")
    site = run.site
    offer = {
        "pitch": " ".join(body.pitch.split()),
        "perks": [" ".join(perk.split()) for perk in body.perks],
        "how_it_works": pledges.how_it_works(campaign.amount, campaign.goal, campaign.deadline, campaign.currency),
        "perk": inputs["perk"],
        "name": name,
        "place": {"label": site.label, "area": site.area},
        "concept": {
            "genre": str(concept.get("genre") or ""),
            "summary": str(concept.get("one_liner") or sheet.get("tagline") or ""),
        },
        "evidence": pledges.evidence_lines(concept, inputs["claims"]),
    }
    async with state.campaign_lock:
        running = await state.campaigns.open_for(user["id"], kit["token"])
        if running:
            raise Problem(409, "You already have an open campaign for this kit.", url=f"/p/{running['id']}")
        await state.campaigns.create(
            id=campaign.id, kit_token=kit["token"], survey_id=kit["survey_id"], idx=kit["idx"], user_id=user["id"],
            status="open", title=" ".join(body.title.split()), offer=offer,
            amount_cents=minor(campaign.amount, campaign.currency), currency=campaign.currency, goal_count=campaign.goal,
            deadline=campaign.deadline, lat=site.lat, lon=site.lon, payout_email=body.payout_email.strip(),
        )
    log.info("Campaign %s started from kit %s", campaign.id, kit["token"][:8])
    return {"id": campaign.id, "url": f"/p/{campaign.id}"}


@router.get("/campaigns")
async def find_campaigns(
    request: Request,
    lat: float | None = Query(None, ge=-90, le=90, description="With lon: campaigns near this point, nearest first"),
    lon: float | None = Query(None, ge=-180, le=180),
    km: float = Query(NEAR_KM, gt=0, le=MAX_KM, description="How far from the point, in kilometres (at most 100)"),
) -> dict:
    """Campaigns that still take pledges: near a point (nearest first), or the newest first; at most 50."""
    if (lat is None) != (lon is None):
        raise HTTPException(400, "Give both lat and lon, or neither.")
    state = request.app.state
    now = state.now()
    if lat is None or lon is None:
        found = [(row, None) for row in await state.campaigns.newest(now, LISTED)]
    else:
        found = await state.campaigns.near(lat, lon, km, now, LISTED)
    held: dict[str, list[dict]] = {row["id"]: [] for row, _ in found}
    for pledge in await state.campaigns.pledges(held):
        held[pledge["campaign_id"]].append(pledge)
    listed = []
    for row, distance in found:
        place = place_of(row)
        progress = progress_of(row, held[row["id"]], now)
        listed.append({
            "id": row["id"], "url": f"/p/{row['id']}", "title": row["title"], "name": (row["offer"] or {}).get("name") or "",
            "place": {"label": place["label"], "lat": place["lat"], "lon": place["lon"]},
            "distance_km": round(distance, 1) if distance is not None else None,
            "amount": major(row["amount_cents"], row["currency"]), "goal": row["goal_count"],
            "supporters": progress["supporters"], "total": progress["total"], "deadline": iso(row["deadline"]),
        })
    return {"campaigns": listed}


@router.get("/campaigns/{campaign_id}")
async def campaign_page(request: Request, campaign_id: str = Path(..., pattern=CAMPAIGN_ID)) -> dict:
    return await campaign_view(request, await campaign_row(request, campaign_id))


@router.post("/campaigns/{campaign_id}/pledges")
async def pledge(
    request: Request, body: PledgeRequest | None = None, campaign_id: str = Path(..., pattern=CAMPAIGN_ID),
) -> dict:
    """A PayPal order (intent AUTHORIZE) that will hold one supporter's pledge. The page's PayPal buttons approve it by
    its id; with flow "redirect" the answer carries PayPal's approval link, and PayPal sends the supporter back to the
    campaign's page to hold it there. Either way the answer carries the pledge's private receipt, once: only its digest
    is kept (app.payments.receipts)."""
    state = request.app.state
    row = await campaign_row(request, campaign_id)
    campaign = campaign_of(row)
    if not pledges.accepting(campaign, state.now()):
        raise HTTPException(409, "This campaign no longer takes pledges.")
    client = paypal_client(request)
    if not state.pledge_limiter.allow(client_ip(request)):
        raise HTTPException(429, "Too many pledges from this address. Try again later.")
    flow = body.flow if body else "buttons"
    pledge_id = uuid.uuid4().hex
    name = (row["offer"] or {}).get("name") or row["title"]
    base = public_base(request)
    try:
        order = await client.create_order(
            intent="AUTHORIZE", amount=campaign.amount, currency=campaign.currency,
            description=f"Founding supporter: {name}", custom_id=pledge_id, reference_id=campaign_id,
            request_id=request_key("pledge", pledge_id),
            # PayPal adds token (the order id) and PayerID to these; the page holds the pledge it names.
            return_url=f"{base}/p/{campaign_id}?pledge={pledge_id}", cancel_url=f"{base}/p/{campaign_id}?cancelled=1",
        )
    except PayPalError as exc:
        raise paypal_problem(exc, "start the pledge") from exc
    order_id = order.get("id")
    if not isinstance(order_id, str) or not RESOURCE_ID.match(order_id) or len(order_id) > 64:
        raise HTTPException(502, "PayPal did not return an order. Try again in a moment.")
    approve = approval_url(order)
    if flow == "redirect" and not approve:
        raise HTTPException(502, "PayPal did not return an approval link. Try again in a moment.")
    receipt, digest = receipts.mint()
    await state.campaigns.add_pledge(
        id=pledge_id, campaign_id=campaign_id, order_id=order_id, flow=flow, amount_cents=row["amount_cents"],
        status="created", receipt_hash=digest,
    )
    return {"order_id": order_id, "approve_url": approve if flow == "redirect" else None, "receipt": receipt}


async def release_late(request: Request, campaign: pledges.Campaign, found: dict, order: dict | None = None) -> bool:
    """Releases any hold PayPal placed on a pledge its campaign no longer takes, so none is left held: the order PayPal
    just answered with, else the order as PayPal has it now (a hold whose answer was lost on the way). When PayPal
    cannot release it yet, the pledge is kept as held after the close, which the next settlement releases. Whether
    PayPal held anything."""
    state = request.app.state
    client = state.services.paypal
    if client is None or not client.configured:
        return False
    try:
        order = order if order is not None else await client.get_order(found["order_id"])
    except (PayPalError, ValueError) as exc:
        log.info("Pledge %s's order could not be read for a hold to release: %s", found["id"], exc)
        return False
    hold = pledges.pledge_from_order(found["id"], order)
    if hold.status != pledges.PledgeStatus.AUTHORIZED or not hold.authorization_id:
        return False
    original = hold.authorization_id
    values: dict[str, Any] = {"authorization_id": original, "payer_id": hold.payer_id, "expires_at": hold.expires_at}
    try:
        await client.void_authorization(original, request_key("void", original))
    except PayPalError as exc:
        if not exc.has(*pledges.VOIDED_ISSUES, "AUTHORIZATION_EXPIRED"):
            log.warning("Hold %s came after its campaign closed and is not released yet: %s", original, exc)
            after = max(state.now(), pledges.closing_time(campaign) + LATE)  # placed after the close: never counted
            await state.campaigns.update_pledge(
                found["id"], only=("created",), status="authorized", authorized_at=after,
                error=(exc.issues[0] if exc.issues else exc.name)[:64], **values,
            )
            return True
    await state.campaigns.update_pledge(found["id"], only=("created",), status="voided", **values)
    log.info("Released hold %s: it came after its campaign stopped taking pledges", original)
    return True


async def hold_pledge(request: Request, found: dict) -> dict:
    """Holds an approved pledge (PayPal authorizes its order) and counts it; idempotent. 'declined' when PayPal denied
    the hold; 402 with retry when PayPal declined the payment method, so the supporter can choose another.

    Under the settlement lock, as withdrawing is, so a pledge is never held while its campaign closes or settles: the
    campaign and the pledge are read again under it, and a pledge counts only when it is held while the campaign still
    takes pledges. A hold PayPal places after that (the deadline passed while PayPal answered, or the supporter came
    back after the close) is released at once, and the answer says nothing will be charged."""
    state = request.app.state
    async with state.settler.lock:
        row = await campaign_row(request, found["campaign_id"])
        found = await state.campaigns.pledge(id=found["id"])
        if found is None:
            raise HTTPException(404, "Pledge not found.")
        campaign = campaign_of(row)

        async def answer(status: str) -> dict:
            return {"status": status, "progress": public_progress(await progress_now(request, row))}

        if found["status"] in ("authorized", "captured"):
            return await answer("authorized")
        if found["status"] == "declined":
            return await answer("declined")
        if found["status"] != "created":
            raise HTTPException(409, "This pledge was withdrawn or released, so it cannot be held.")
        if not pledges.accepting(campaign, state.now()):
            if await release_late(request, campaign, found):
                raise HTTPException(409, CLOSED_WHILE_HELD)
            raise HTTPException(409, "This campaign no longer takes pledges, so nothing was held.")
        client = paypal_client(request)
        try:
            # A fresh request id each time, so a supporter whose card was declined can try again with another.
            held = await client.authorize_order(found["order_id"], str(uuid.uuid4()))
        except PayPalError as exc:
            if not exc.has("ORDER_ALREADY_AUTHORIZED"):
                raise paypal_problem(exc, "hold the pledge") from exc
            try:
                held = await client.get_order(found["order_id"])
            except PayPalError as again:
                raise paypal_problem(again, "confirm the pledge") from again
        hold = pledges.pledge_from_order(found["id"], held)
        if not authorized_in_full(held, campaign.amount, campaign.currency, found["id"]):
            if hold.status == pledges.PledgeStatus.DECLINED:
                await state.campaigns.update_pledge(
                    found["id"], only=("created",), status="declined", authorization_id=hold.authorization_id,
                    payer_id=hold.payer_id,
                )
                return await answer("declined")
            if hold.status == pledges.PledgeStatus.CREATED:
                raise Problem(409, "PayPal is still reviewing this pledge. It counts once PayPal confirms the hold.", pending=True)
            log.error("Pledge order %s was held but not as pledged: %s", found["order_id"], hold)
            raise HTTPException(502, "PayPal's answer did not match this pledge, so it was not counted.")
        now = state.now()
        if not pledges.accepting(campaign, now):  # its deadline passed while PayPal placed the hold
            await release_late(request, campaign, found, held)
            raise HTTPException(409, CLOSED_WHILE_HELD)
        # PayPal's clock may run a little ahead of ours: the hold counts from no later than the moment we learned of
        # it, so an owner closing right after never finds it placed after the close.
        placed = min(hold.authorized_at or now, now)
        stored = await state.campaigns.update_pledge(
            found["id"], only=("created",), status="authorized", authorization_id=hold.authorization_id,
            payer_id=hold.payer_id, authorized_at=placed, expires_at=hold.expires_at,
        )
        if not stored:  # held by another request meanwhile, or withdrawn
            again = await state.campaigns.pledge(id=found["id"])
            if again is None or again["status"] not in ("authorized", "captured"):
                raise HTTPException(409, "This pledge was withdrawn or released, so it cannot be held.")
        return await answer("authorized")


@router.post("/campaigns/{campaign_id}/pledges/{order_id}/authorize")
async def authorize(
    request: Request, campaign_id: str = Path(..., pattern=CAMPAIGN_ID), order_id: str = Path(..., pattern=PLEDGE_REF),
) -> dict:
    """Holds a pledge the supporter approved in PayPal, by its order id (or the pledge id in the return link)."""
    await campaign_row(request, campaign_id)
    found = await request.app.state.campaigns.pledge_in(campaign_id, order_id)
    if found is None:
        raise HTTPException(404, "Pledge not found.")
    return await hold_pledge(request, found)


@router.post("/campaigns/{campaign_id}/pledges/{order_id}/withdraw")
async def withdraw(
    request: Request, campaign_id: str = Path(..., pattern=CAMPAIGN_ID), order_id: str = Path(..., pattern=PLEDGE_REF),
) -> dict:
    """Releases a supporter's pledge while the campaign is open: PayPal voids the hold. Anyone with the order id may."""
    state = request.app.state
    await campaign_row(request, campaign_id)
    if await state.campaigns.pledge_in(campaign_id, order_id) is None:
        raise HTTPException(404, "Pledge not found.")
    progress = await withdraw_pledge(request, campaign_id, order_id)
    return {"status": "withdrawn", "progress": public_progress(progress)}


async def withdraw_pledge(request: Request, campaign_id: str, reference: str) -> dict:
    """Withdraws a campaign's pledge, by its order id or our own id, and gives the campaign's progress after it;
    idempotent. Under the settlement lock, so never while a settlement collects it: the campaign and the pledge are read
    again under it. Only while the campaign takes pledges (409 after): PayPal voids a hold, and a pledge never approved
    is withdrawn without PayPal. Both the campaign's page and the pledge's receipt (app.routes.receipts) withdraw here."""
    state = request.app.state
    async with state.settler.lock:  # never while a settlement collects it
        row = await campaign_row(request, campaign_id)
        found = await state.campaigns.pledge_in(campaign_id, reference)
        if found is None:
            raise HTTPException(404, "Pledge not found.")
        if found["status"] != "withdrawn":
            if not pledges.accepting(campaign_of(row), state.now()):
                raise HTTPException(409, "The campaign has closed, so pledges can no longer be withdrawn.")
            if found["status"] == "authorized":
                original = found["authorization_id"]
                if original:
                    try:
                        await paypal_client(request).void_authorization(original, request_key("void", original))
                    except PayPalError as exc:
                        if not exc.has(*pledges.VOIDED_ISSUES, "AUTHORIZATION_EXPIRED"):
                            raise paypal_problem(exc, "release the pledge") from exc
                await state.campaigns.update_pledge(found["id"], only=("authorized",), status="withdrawn", error=None)
            elif found["status"] == "created":  # never approved: nothing is held
                await state.campaigns.update_pledge(found["id"], only=("created",), status="withdrawn")
            else:
                raise HTTPException(409, "This pledge can no longer be withdrawn.")
        return await progress_now(request, row)


async def settle_now(request: Request, campaign_id: str, *, cancel: bool = False) -> dict:
    """The owner's close or cancel, settled at once; 409 when the campaign as it stands under the settlement lock does
    not allow it (app.settlement.Settler.close)."""
    try:
        await request.app.state.settler.close(campaign_id, cancel=cancel)
    except Refused as exc:
        raise HTTPException(409, str(exc)) from exc
    return await campaign_view(request, await campaign_row(request, campaign_id))


@router.post("/campaigns/{campaign_id}/close")
async def close(request: Request, user: auth.SignedIn, campaign_id: str = Path(..., pattern=CAMPAIGN_ID)) -> dict:
    """Closes the campaign and settles it now, once its goal is met (or its deadline has passed): every hold is
    collected, then the owner is paid; short of the goal, every hold is released."""
    await owners_campaign(request, campaign_id, user)
    return await settle_now(request, campaign_id)


@router.post("/campaigns/{campaign_id}/cancel")
async def cancel(request: Request, user: auth.SignedIn, campaign_id: str = Path(..., pattern=CAMPAIGN_ID)) -> dict:
    """Ends a campaign short of its goal and releases every hold; nobody is charged."""
    await owners_campaign(request, campaign_id, user)
    return await settle_now(request, campaign_id, cancel=True)
