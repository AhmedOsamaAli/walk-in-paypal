"""Campaigns for an owner's business. Their description is never presented as survey-verified evidence."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import ConfigDict, Field

from .. import auth
from ..payments import pledges
from ..payments.records import CURRENCY, Problem, email_problem, minor
from ..ratelimit import client_ip
from .campaigns import MoneyTerms, check_terms

log = logging.getLogger("walkin")
router = APIRouter(prefix="/api")
BusinessKind = Literal["cafe", "restaurant", "bakery", "bar", "gym", "studio", "salon", "barber",
                       "bookstore", "shop", "grocery", "kids", "services", "other"]


class BusinessTerms(MoneyTerms):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=2, max_length=60)
    kind: BusinessKind
    description: str = Field(min_length=8, max_length=500)
    why_here: str = Field(default="", max_length=300)
    address: str = Field(min_length=3, max_length=250)
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


class NewBusinessCampaign(BusinessTerms):
    payout_email: Any = None
    title: Any = None
    pitch: Any = None
    perks: Any = None


def clean(value: str) -> str:
    return " ".join(value.split())


def inputs(body: BusinessTerms, deadline) -> tuple[dict, dict]:
    """Use a kit's drafting and editing checks, but pass no measured claims."""
    name, address = clean(body.name), clean(body.address)
    concept = {"name": name, "genre": body.kind, "signature": [],
               "why_here": [clean(body.why_here)] if clean(body.why_here) else []}
    design = {
        "name": name, "tagline": clean(body.description), "offer": [clean(body.description)],
        "launch": {"where": {"neighborhoods": [address]}},
    }
    return design, {
        "amount": body.amount, "goal": body.goal, "deadline": deadline, "currency": CURRENCY, "perk": body.perk,
        "concept": concept, "claims": [], "place": address,
    }


def checked(body: BusinessTerms, request: Request):
    deadline, problems = check_terms(body, request.app.state.now(), clean(body.name))
    for label, value, minimum in (("business name", body.name, 2), ("description", body.description, 8),
                                  ("address", body.address, 3)):
        if len(clean(value)) < minimum:
            problems.append(f"Write the {label} in at least {minimum} characters, not just spaces.")
    if problems:
        raise Problem(422, " ".join(problems), problems=problems)
    return deadline


@router.post("/business-campaigns/draft")
async def draft_business(request: Request, body: BusinessTerms, user: auth.SignedIn) -> dict:
    deadline = checked(body, request)
    state = request.app.state
    if not state.draft_limiter.allow(client_ip(request)):
        raise HTTPException(429, "Too many drafts from this address. Try again later.")
    design, brief = inputs(body, deadline)
    offer = await pledges.draft_offer(state.services.llm, design, answers=state.services.answers, **brief)
    return {key: offer[key] for key in ("title", "pitch", "perks", "how_it_works")} | {"problems": []}


@router.post("/business-campaigns")
async def create_business(request: Request, body: NewBusinessCampaign, user: auth.SignedIn) -> dict:
    state = request.app.state
    deadline = checked(body, request)
    email = email_problem(body.payout_email)
    if email:
        raise Problem(422, email, problems=[email])
    design, brief = inputs(body, deadline)
    problems = pledges.offer_problems(design, title=body.title, pitch=body.pitch, perks=body.perks, **brief)
    if problems:
        raise Problem(422, " ".join(problems), problems=problems)
    if not state.campaign_limiter.allow(user["id"]):
        raise HTTPException(429, "Too many campaigns started from this account. Try again later.")
    now = state.now()
    campaign = pledges.new_campaign(uuid.uuid4().hex[:16], body.amount, body.goal, deadline, now, CURRENCY)
    why = clean(body.why_here)
    offer = {
        "source": "owner", "name": clean(body.name), "pitch": clean(body.pitch), "perks": [clean(perk) for perk in body.perks],
        "how_it_works": pledges.how_it_works(campaign.amount, campaign.goal, deadline, CURRENCY),
        "perk": clean(body.perk) if isinstance(body.perk, str) else None,
        "place": {"label": clean(body.address), "area": ""},
        "concept": {"genre": body.kind, "summary": clean(body.description)},
        "evidence": [why] if why else [],
    }
    await state.campaigns.create(
        id=campaign.id, kit_token=None, survey_id=None, idx=None, user_id=user["id"], status="open",
        title=clean(body.title), offer=offer, amount_cents=minor(campaign.amount, CURRENCY), currency=CURRENCY,
        goal_count=campaign.goal, deadline=deadline, lat=body.lat, lon=body.lon, payout_email=body.payout_email.strip(),
    )
    log.info("Owner-described campaign %s started", campaign.id)
    return {"id": campaign.id, "url": f"/p/{campaign.id}"}
