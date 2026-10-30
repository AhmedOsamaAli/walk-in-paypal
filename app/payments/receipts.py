"""A pledge's private receipt: a random token minted with the pledge and given once, in the answer that starts it, to
whoever started it (the campaign page in the supporter's browser, or the AI assistant preparing it for a person).
Walk-in keeps only its SHA-256 (pledges.receipt_hash), as a session keeps only that of its cookie, so the database never
holds a working receipt; a receipt is looked up by its digest alone, so how long a lookup takes says nothing about the
receipt's characters. Whoever holds it may follow the pledge and withdraw it while its campaign takes pledges, from any
device (app.routes.receipts); it names neither the payer nor the PayPal order.

The pledge's state comes in plain words from fixed sentences, never a model's, with no number but the pledge's amount
and the campaign's goal: the dates and the count are the campaign's own fields, for each reader to put in their zone.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime

from . import pledges
from .pledges import CURRENCY_SIGNS, CampaignStatus, PledgeStatus
from .records import major

# secrets.token_urlsafe(24): 24 random bytes (192 bits), as 32 URL-safe characters.
RECEIPT_BYTES = 24
RECEIPT = re.compile(r"[A-Za-z0-9_-]{32}")
WAITING = "Waiting for your approval in PayPal"
# Why PayPal released a hold, by how the campaign ended; any other release was a hold placed after the close.
RELEASED_BECAUSE = {
    CampaignStatus.EXPIRED: "The campaign ended short of its goal",
    CampaignStatus.CANCELLED: "The owner cancelled the campaign",
}
LATE = "It came after the campaign stopped taking pledges"


def mint() -> tuple[str, str]:
    """A new receipt, and the digest the pledge keeps in its place."""
    receipt = secrets.token_urlsafe(RECEIPT_BYTES)
    return receipt, digest(receipt)


def digest(receipt: str) -> str:
    """The receipt's SHA-256 in hex: what the pledge keeps, and what a receipt is looked up by."""
    return hashlib.sha256(receipt.encode("utf-8")).hexdigest()


def well_formed(receipt: str) -> bool:
    return RECEIPT.fullmatch(receipt) is not None


def words(pledge: dict, campaign: pledges.Campaign, now: datetime) -> dict:
    """The pledge's state for whoever holds its receipt: `state` in a few words, `explanation` in a sentence or two on
    what it means for their money, and whether it can be withdrawn now (`withdrawable`: started or held, while the
    campaign takes pledges, as withdrawing allows)."""
    status = pledge["status"]
    code = campaign.currency.upper()
    amount = f"{CURRENCY_SIGNS[code]}{major(pledge['amount_cents'], code)}" if code in CURRENCY_SIGNS else (
        f"{major(pledge['amount_cents'], code)} {code}")
    accepting = pledges.accepting(campaign, now)

    def said(state: str, explanation: str) -> dict:
        withdrawable = accepting and status in (PledgeStatus.CREATED, PledgeStatus.AUTHORIZED)
        return {"state": state, "explanation": explanation, "withdrawable": withdrawable}

    if status == PledgeStatus.CREATED:
        if accepting:
            return said(WAITING, "Nothing is held yet. Approve the pledge in PayPal with the link you were given; PayPal "
                                 "then brings you back to the campaign's page, which places the hold.")
        return said("Not held", "It was not approved in PayPal before the campaign stopped taking pledges, so nothing "
                                "was held or charged.")
    if status == PledgeStatus.AUTHORIZED:
        placed = pledge.get("authorized_at")
        if placed is not None and placed > pledges.closing_time(campaign):  # PayPal could not release it at once
            return said("Being released", f"{LATE}, so it never counted, and PayPal is releasing the hold: nothing "
                                          "will be charged.")
        if accepting:
            return said("Held", f"PayPal holds your {amount}. You are charged only if {campaign.goal} neighbors join "
                                "by the deadline; otherwise the hold is released and you pay nothing.")
        if campaign.status == CampaignStatus.OPEN:
            return said("Held", f"The campaign has closed and is being settled. If it met its goal, PayPal collects "
                                f"your {amount}; if not, the hold is released and you pay nothing.")
        if campaign.status in pledges.COLLECTING:
            return said("Being collected", f"The campaign met its goal, so PayPal is collecting your {amount}.")
        reason = RELEASED_BECAUSE.get(campaign.status, "The campaign is settled")
        return said("Being released", f"{reason}, so PayPal is releasing the hold: nothing will be charged.")
    if status == PledgeStatus.CAPTURED:
        if pledge.get("capture_status") == "PENDING":
            return said("Collection pending", "PayPal is reviewing the collection of your pledge; it has not confirmed "
                                             "that the payment is complete.")
        return said("Collected", f"The campaign met its goal, so PayPal collected your {amount} for its owner.")
    if status == PledgeStatus.VOIDED:
        reason = RELEASED_BECAUSE.get(campaign.status, LATE)
        return said("Released", f"{reason}, so PayPal released the hold: nothing was charged.")
    if status == PledgeStatus.WITHDRAWN:
        if pledge.get("authorization_id"):
            return said("Withdrawn", "It was withdrawn, and PayPal released the hold: nothing was charged.")
        return said("Withdrawn", "It was withdrawn before PayPal held anything: nothing was charged.")
    if status == PledgeStatus.DECLINED:
        return said("Declined", "PayPal declined the pledge, so nothing was held or charged.")
    if status == PledgeStatus.EXPIRED:
        return said("Expired", "PayPal's hold ran out before the pledge was collected, so nothing was charged.")
    if status == PledgeStatus.FAILED:
        return said("Not collected", "The campaign met its goal, but PayPal could not collect this pledge, so nothing "
                                     "was charged.")
    if status == PledgeStatus.REFUNDED:
        return said("Refunded", f"PayPal collected your {amount}, then refunded it.")
    raise ValueError(f"Unknown pledge status: {status!r}")
