"""A pledge's private receipt (app.payments.receipts), for whoever holds it: the supporter on any device, or the AI
assistant that prepared the pledge for them. GET /api/receipts/{receipt} tells the pledge's state in plain words with
its campaign's public progress and terms; POST /api/receipts/{receipt}/withdraw withdraws it exactly as the campaign's
page does (app.routes.campaigns.withdraw_pledge: under the settlement lock, only while the campaign takes pledges).

The receipt is the only key, so its answers name no payer and no PayPal order, are never kept by a browser or the front
door (no-store), and come only for a receipt Walk-in knows, found by its SHA-256 alone; any other gets 404, however it
is written. Each address may ask a few times an hour. Uvicorn's access log writes request paths, so it writes a
receipt's as ***."""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException, Request, Response

from ..cache_policy import NO_STORE
from ..payments import pledges, receipts
from ..payments.records import campaign_of, iso, major, public_progress
from ..ratelimit import RateLimiter, client_ip
from .campaigns import campaign_row, place_of, progress_now, withdraw_pledge

router = APIRouter(prefix="/api")
# A receipt at the start of a request's path: its API, or its page in the web app.
IN_PATH = re.compile(r"^(/api/receipts/|/r/)[^/?#\s]+")


class HideReceipts(logging.Filter):
    """Writes a receipt in a request's path as *** in Uvicorn's access log, so the log never holds a working one."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(hidden(arg) if isinstance(arg, str) else arg for arg in record.args)
        return True


def hidden(path: str) -> str:
    """'/api/receipts/<receipt>/withdraw' -> '/api/receipts/***/withdraw'; any other text as it is."""
    return IN_PATH.sub(r"\1***", path)


def hide_from_access_log() -> None:
    """Adds HideReceipts to Uvicorn's access log, once however many apps are made."""
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(each, HideReceipts) for each in access.filters):
        access.addFilter(HideReceipts())


def allow(request: Request, limiter: RateLimiter, doing: str) -> None:
    if not limiter.allow(client_ip(request)):
        raise HTTPException(429, f"Too many {doing} from this address. Try again later.")


async def pledge_of(request: Request, receipt: str) -> dict:
    """The pledge a receipt belongs to, found by the receipt's digest: 404 for any receipt Walk-in does not know."""
    found = None
    if receipts.well_formed(receipt):
        found = await request.app.state.campaigns.pledge(receipt_hash=receipts.digest(receipt))
    if found is None:
        raise HTTPException(404, "Receipt not found. Check that its link was copied whole.")
    return found


async def receipt_view(request: Request, found: dict) -> dict:
    """The pledge's state in plain words (app.payments.receipts.words), its amount and when it was started, and its
    campaign's public page in brief: the business, the terms, the progress and whether it still takes pledges."""
    state = request.app.state
    row = await campaign_row(request, found["campaign_id"])
    now = state.now()
    campaign = campaign_of(row)
    progress = await progress_now(request, row, now)
    place = place_of(row)
    return {
        "status": found["status"],
        **receipts.words(found, campaign, now),
        "amount": major(found["amount_cents"], campaign.currency),
        "currency": campaign.currency,
        "pledged_at": iso(found["created_at"]),
        "campaign": {
            "id": row["id"],
            "url": f"/p/{row['id']}",
            "name": (row["offer"] or {}).get("name") or "",
            "title": row["title"],
            "place": {"label": place["label"], "area": place["area"]},
            "status": row["status"],
            "accepting": pledges.accepting(campaign, now),
            "amount": campaign.amount,
            "currency": campaign.currency,
            "goal": campaign.goal,
            "deadline": iso(campaign.deadline),
            "closed_at": iso(campaign.closed_at),
            "progress": public_progress(progress),
        },
    }


@router.get("/receipts/{receipt}")
async def read_receipt(request: Request, response: Response, receipt: str) -> dict:
    """The pledge a private receipt belongs to: its state in plain words, whether it can be withdrawn now, and its
    campaign's progress and terms. Never kept by a cache: it is the receipt holder's alone, and it changes."""
    allow(request, request.app.state.receipt_limiter, "receipt checks")
    found = await pledge_of(request, receipt)
    response.headers["Cache-Control"] = NO_STORE
    return await receipt_view(request, found)


@router.post("/receipts/{receipt}/withdraw")
async def withdraw_with_receipt(request: Request, response: Response, receipt: str) -> dict:
    """Withdraws the pledge a private receipt belongs to, as the campaign's page does: only while the campaign takes
    pledges (409 after), PayPal releasing the hold; idempotent. The receipt as it stands after."""
    allow(request, request.app.state.receipt_withdraw_limiter, "withdrawals")
    found = await pledge_of(request, receipt)
    await withdraw_pledge(request, found["campaign_id"], found["id"])
    response.headers["Cache-Control"] = NO_STORE
    again = await request.app.state.campaigns.pledge(id=found["id"])
    if again is None:
        raise HTTPException(404, "Receipt not found. Check that its link was copied whole.")
    return await receipt_view(request, again)
