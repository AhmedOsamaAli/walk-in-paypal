"""Walk-in Founders' columns hold the longest value the code writes into them, in app/db/tables.py and in migration 0003
alike. The tests run on SQLite, which ignores VARCHAR lengths; Postgres, in production, refuses a longer value, so a
column too short fails only there (PayPal's capture status PARTIALLY_REFUNDED, 18 characters, once met a String(16))."""
from __future__ import annotations

import asyncio
import re
import typing
import uuid

from sqlalchemy import String, inspect

from app.db import Database
from app.db.tables import campaigns, kits, payouts, paypal_events, pledges, surveys, users
from app.payments import paypal, receipts
from app.payments import pledges as rules
from app.payments.records import CURRENCY, EMAIL
from app.routes.campaigns import PLEDGE_REF, PledgeRequest
from app.routes.hooks import CAPTURE_REFUSED
from app.settlement import CAPTURE_OUTCOME

FOUNDERS = (campaigns, pledges, payouts, paypal_events)
# Every status PayPal documents for a capture (Payments v2), and for a payout's item and batch (Payouts v1).
CAPTURE_STATUSES = ("COMPLETED", "DECLINED", "PARTIALLY_REFUNDED", "PENDING", "REFUNDED", "FAILED")
PAYOUT_STATUSES = (*paypal.PAYOUT_ITEM_STATUS, *paypal.PAYOUT_BATCH_STATUS)
# Why a pledge could not be settled: the issue codes the code names, the long ones PayPal's Orders and Payments APIs
# give, error names without an issue, and the errors settlement records itself.
ISSUES = (
    *rules.ISSUE_TEXT, *rules.CAPTURED_ISSUES, *rules.VOIDED_ISSUES, *(code for _, code in CAPTURE_REFUSED.values()),
    "PAYER_ACCOUNT_LOCKED_OR_CLOSED", "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED", "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING",
    "TRANSACTION_RECEIVING_LIMIT_EXCEEDED", "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING", "MAX_AUTHORIZATION_COUNT_EXCEEDED",
    "UNPROCESSABLE_ENTITY", "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "HTTP_503", "RemoteProtocolError",
)
PAYOUT_ERRORS = ("RECEIVER_UNREGISTERED", "PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE", "x" * 200)


def longest(pattern: str) -> int:
    """The longest text an id pattern such as ^[A-Za-z0-9_-]{1,64}$ allows."""
    return int(re.search(r"\{1,(\d+)\}\$$", pattern)[1])


PAYPAL_ID = longest(paypal.RESOURCE_ID.pattern)  # any PayPal id the code takes: order, payer, hold, capture, payout
EMAIL_ADDRESS = "o" * 64 + "@" + "a" * 63 + "." + "b" * 52 + ".com"  # the longest email EMAIL lets receive a payout

# Every String column of the Founders tables, and what the code writes into it: the values themselves, or the length
# of the longest (a column it copies from, a pattern it checks, or what it cuts the text to).
WRITTEN: dict[str, dict[str, list | int]] = {
    "campaigns": {
        "id": [uuid.uuid4().hex[:16]],
        "kit_token": kits.c.token.type.length,
        "survey_id": surveys.c.id.type.length,
        "user_id": users.c.id.type.length,
        "status": list(rules.CampaignStatus),
        "title": rules.TITLE_LIMIT,
        "currency": [CURRENCY, *paypal.ZERO_DECIMAL],
        "payout_email": [EMAIL_ADDRESS],
    },
    "pledges": {
        "id": [uuid.uuid4().hex],
        "campaign_id": [uuid.uuid4().hex[:16]],
        "order_id": longest(PLEDGE_REF),
        "flow": list(typing.get_args(PledgeRequest.model_fields["flow"].annotation)),
        "status": list(rules.PledgeStatus),
        "payer_id": PAYPAL_ID,
        "authorization_id": PAYPAL_ID,
        "reauthorization_id": PAYPAL_ID,
        "capture_id": PAYPAL_ID,
        "capture_status": [*CAPTURE_STATUSES, *CAPTURE_OUTCOME, *(code for _, code in CAPTURE_REFUSED.values())],
        "error": list(ISSUES),
        "receipt_hash": [receipts.mint()[1]],
    },
    "payouts": {
        "campaign_id": [uuid.uuid4().hex[:16]],
        "status": [*paypal.PAYOUT_ITEM_STATUS.values(), *paypal.PAYOUT_BATCH_STATUS.values()],
        "currency": [CURRENCY, *paypal.ZERO_DECIMAL],
        "email": [EMAIL_ADDRESS],
        "batch_id": PAYPAL_ID,
        "item_id": PAYPAL_ID,
        "paypal_status": list(PAYOUT_STATUSES),
        "error": list(PAYOUT_ERRORS),  # PayPal's reason, or the error cut to 200 characters
    },
    "paypal_events": {
        "id": 64,  # PayPal's event id, cut to 64 characters (app.db.events)
        "event_type": [*paypal.WEBHOOK_EVENTS, "x" * 64],
        "resource_id": 64,
    },
}


def string_columns(table) -> dict[str, int]:
    return {column.name: column.type.length for column in table.columns if isinstance(column.type, String)}


def test_every_founders_column_holds_the_longest_value_the_code_writes():
    assert EMAIL.match(EMAIL_ADDRESS) and len(EMAIL_ADDRESS) == 185
    for table in FOUNDERS:
        declared = string_columns(table)
        assert set(declared) == set(WRITTEN[table.name]), f"{table.name}: say what the code writes into each column"
        for name, values in WRITTEN[table.name].items():
            needed = values if isinstance(values, int) else max(len(str(value)) for value in values)
            assert declared[name] is not None and declared[name] >= needed, (
                f"{table.name}.{name} is String({declared[name]}), but the code writes {needed} characters")
    assert string_columns(pledges)["capture_status"] >= len("PARTIALLY_REFUNDED")


def test_migration_0003_declares_the_same_lengths_as_the_tables(database_url):
    async def reflect() -> dict[str, dict[str, int]]:
        database = Database(database_url)
        await database.migrate()
        async with database.engine.connect() as connection:
            found = await connection.run_sync(lambda sync: {
                table.name: {column["name"]: column["type"].length for column in inspect(sync).get_columns(table.name)
                             if isinstance(column["type"], String)}
                for table in FOUNDERS
            })
        await database.dispose()
        return found

    assert asyncio.run(reflect()) == {table.name: string_columns(table) for table in FOUNDERS}
