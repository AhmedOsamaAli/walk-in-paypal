"""Walk-in Founders, plugged into the app: campaigns, pledges, settlement and payouts with PayPal.

install() adds the endpoints (a pledge's private receipt included), the answers that carry more than a detail
(records.Problem), and PayPal's and the scheduler's callbacks to the paths the Origin check lets through, and keeps
receipts out of Uvicorn's access log; PAGES are the web app's pages for campaigns and receipts. running() gives them
their stores, rate limits and the settlement loop for the app's lifetime.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..config import settings
from ..db.campaigns import CampaignStore
from ..db.events import EventStore
from ..ratelimit import RateLimiter
from ..settlement import Settler
from . import records

PLEDGES_PER_HOUR = 20
DRAFTS_PER_HOUR = 30
# A receipt's page reads it once as it opens and again after each step, and an assistant on request.
RECEIPT_CHECKS_PER_HOUR = 120
RECEIPT_WITHDRAWALS_PER_HOUR = 20
SHUTDOWN_GRACE_S = 10
# Called by PayPal and a scheduled job, never by a page; each proves itself otherwise.
CALLBACKS = frozenset({"/api/paypal/webhook", "/api/cron/settle"})
# The web app's pages for a campaign, for the list of open campaigns and for a pledge's private receipt.
PAGES = ("/p/{key}", "/founders", "/founders/start", "/r/{key}")


def paypal_config(state) -> dict:
    """The page's PayPal settings: whether pledging works here, and what PayPal's JavaScript SDK needs."""
    client = getattr(state, "services", None) and state.services.paypal
    enabled = bool(client is not None and client.configured and settings.paypal_client_id)
    return {
        "enabled": enabled,
        "client_id": settings.paypal_client_id if enabled else None,
        "environment": settings.paypal_environment,
        "currency": records.CURRENCY,
    }


def install(app: FastAPI) -> None:
    """Adds the campaign and receipt endpoints and the callbacks to the app; the web app's pages are PAGES."""
    from ..routes import business_campaigns, campaigns, hooks, receipts

    for area in (campaigns, hooks, receipts, business_campaigns):
        app.include_router(area.router)
    app.add_exception_handler(records.Problem, records.problem_response)
    app.state.origin_exempt = frozenset(getattr(app.state, "origin_exempt", frozenset()) | CALLBACKS)
    receipts.hide_from_access_log()


@asynccontextmanager
async def running(app: FastAPI, settle_every: float | None) -> AsyncIterator[None]:
    """The stores, limits and background settlement while the app runs: campaigns past their close settle every
    `settle_every` seconds (None or 0: never; tests settle by hand, and the cron endpoint still does)."""
    state = app.state
    state.campaigns = CampaignStore(state.db)
    state.events = EventStore(state.db)
    state.settler = Settler(state.campaigns, state.services.paypal, lambda: state.now())
    state.campaign_lock = asyncio.Lock()
    state.pledge_limiter = RateLimiter(PLEDGES_PER_HOUR, 3600)
    state.draft_limiter = RateLimiter(DRAFTS_PER_HOUR, 3600)
    state.campaign_limiter = RateLimiter(10, 3600)
    state.receipt_limiter = RateLimiter(RECEIPT_CHECKS_PER_HOUR, 3600)
    state.receipt_withdraw_limiter = RateLimiter(RECEIPT_WITHDRAWALS_PER_HOUR, 3600)
    if settle_every:
        state.settler.start(settle_every)
    try:
        yield
    finally:
        await state.settler.stop(SHUTDOWN_GRACE_S)
