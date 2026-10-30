"""Walk-in Founders around the endpoints: money in minor units, PayPal's refusals as HTTP answers, campaigns and pledges
from their rows as app.payments.pledges sees them, and the owner's PayPal email, checked and masked."""
from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from . import pledges
from .paypal import ZERO_DECIMAL, PayPalClient, PayPalError, money

CURRENCY = "USD"
PROGRESS_KEYS = ("supporters", "goal", "remaining", "percent", "total", "funded")
# PayPal's receiver email for a payout is at most 127 characters.
EMAIL = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,120}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$"
)
TEST_MODE = "Demo payments — no real money."


class Problem(Exception):
    """An HTTP error whose JSON carries more than FastAPI's detail, such as {"detail": ..., "retry": true}."""

    def __init__(self, status: int, detail: str, **extra: Any) -> None:
        super().__init__(detail)
        self.status, self.detail, self.extra = status, detail, extra


async def problem_response(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, Problem)
    return JSONResponse({"detail": exc.detail, **exc.extra}, status_code=exc.status)


def iso(moment: datetime | None) -> str | None:
    """A time as the API writes it: ISO 8601 in UTC, to the second ('2026-10-22T14:03:00Z')."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if moment else None


def minor(amount: str | Decimal | int, currency: str) -> int:
    """'25.00' USD -> 2500; whole units for currencies without cents."""
    value = Decimal(money(amount, currency))
    return int(value if currency.upper() in ZERO_DECIMAL else value * 100)


def major(units: int, currency: str) -> str:
    """2500 USD -> '25.00'."""
    return str(units) if currency.upper() in ZERO_DECIMAL else f"{Decimal(units) / 100:.2f}"


def minor_or_none(amount: str | None, currency: str) -> int | None:
    """A net amount PayPal gave ('23.73') in minor units; None when there is none. Zero is a real net."""
    if amount is None:
        return None
    value = Decimal(amount)
    return int(value if currency.upper() in ZERO_DECIMAL else (value * 100).to_integral_value())


def paypal_client(request: Request) -> PayPalClient:
    client = request.app.state.services.paypal
    if client is None or not client.configured:
        raise HTTPException(503, "Pledging is not set up on this server: PayPal is not configured.")
    return client


def paypal_problem(exc: PayPalError, doing: str) -> Problem:
    """PayPal's refusal as an answer for the page. A declined card is the supporter's to fix in PayPal's buttons."""
    if exc.has("INSTRUMENT_DECLINED"):
        return Problem(402, "PayPal declined that payment method. Choose another one to continue.", retry=True)
    if exc.has("ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"):
        return Problem(409, "The pledge was not approved in PayPal yet.")
    if exc.retryable or exc.status in (401, 403):
        return Problem(502, f"PayPal could not {doing} right now. Try again in a moment.")
    code = exc.issues[0] if exc.issues else exc.name
    return Problem(400, f"PayPal could not {doing} ({code}).")


def email_problem(value: object) -> str | None:
    """Why a payout email cannot receive the money, in plain words; None when it can."""
    if not isinstance(value, str) or not value.strip():
        return "Give the PayPal email that receives the money."
    if not EMAIL.match(value.strip()):
        return "The payout email is not an email address PayPal can pay."
    return None


def mask_email(email: str) -> str:
    """'owner@example.com' -> 'o***@example.com'."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


# Campaigns and pledges, from their rows

def campaign_of(row: dict) -> pledges.Campaign:
    return pledges.Campaign(
        id=row["id"], amount=major(row["amount_cents"], row["currency"]), goal=row["goal_count"], deadline=row["deadline"],
        currency=row["currency"], status=row["status"], closed_at=row["closed_at"], funded=row["funded"],
    )


def pledge_of(row: dict, currency: str) -> pledges.Pledge:
    net = row.get("net_cents")
    return pledges.Pledge(
        id=row["id"], amount=major(row["amount_cents"], currency), currency=currency, status=row["status"],
        order_id=row["order_id"], payer_id=row["payer_id"], authorization_id=row["authorization_id"],
        authorized_at=row["authorized_at"], expires_at=row["expires_at"], reauthorization_id=row["reauthorization_id"],
        reauthorized_at=row["reauthorized_at"], capture_id=row["capture_id"], capture_status=row.get("capture_status"),
        net_amount=major(net, currency) if net is not None else None, error=row["error"],
    )


def public_progress(progress: dict) -> dict:
    return {key: progress[key] for key in PROGRESS_KEYS}


def progress_of(row: dict, pledge_rows: list[dict], now: datetime) -> dict:
    found = [pledge_of(pledge, row["currency"]) for pledge in pledge_rows]
    return pledges.progress(campaign_of(row), found, now)
