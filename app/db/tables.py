"""The database's tables, as SQLAlchemy Core. The migrations in migrations/ create them; keep both in step.

Users sign in with Google; a session row holds only the SHA-256 of its cookie. The app writes surveys and their design
sheets, for anyone, and records the signed-in user and the browser (device) that ran each. A finished survey's state is
kept as zlib-compressed JSON (app.db.surveys): it runs to megabytes, and compresses about sevenfold. Launch kits, one
per survey concept, live and go with their survey.

Walk-in Founders: a campaign starts from a ready kit and keeps what its page shows (the business, the place, the
evidence), so it outlives its survey; its pledges are PayPal orders that only hold money until it settles, its payout
sends the net collected total to the owner, and PayPal's webhook events are kept once each. A pledge keeps only the
SHA-256 of its private receipt, as a session keeps only that of its cookie.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Dialect,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    UniqueConstraint,
)
from sqlalchemy.types import TypeDecorator

# Constraint and index names, spelled out in the migrations, so later migrations can find them on every database.
metadata = MetaData(naming_convention={
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
})


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    """A timezone-aware UTC timestamp on every database; SQLite stores no zone, so its values are marked UTC on read."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("Timestamps must be timezone-aware")
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _created() -> Column:
    return Column("created_at", UTCDateTime, nullable=False, default=utcnow)


def _updated() -> Column:
    return Column("updated_at", UTCDateTime, nullable=False, default=utcnow, onupdate=utcnow)


def _user() -> Column:
    return Column("user_id", String(32), ForeignKey("users.id"), index=True)


users = Table(
    "users", metadata,
    Column("id", String(32), primary_key=True),
    Column("subject", String(255), nullable=False, unique=True),  # "google:<sub>", or "dev:<email>" in development
    Column("email", String(320), nullable=False),
    Column("name", String(200), nullable=False),
    Column("picture", String(1024)),
    _created(),
    _updated(),
)

sessions = Table(
    "sessions", metadata,
    Column("token_hash", String(64), primary_key=True),  # SHA-256 of the walkin_session cookie, never the cookie
    Column("user_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    _created(),
    Column("expires_at", UTCDateTime, nullable=False, index=True),
)

surveys = Table(
    "surveys", metadata,
    Column("id", String(32), primary_key=True),
    Column("created_at", UTCDateTime, nullable=False, default=utcnow, index=True),
    _updated(),
    Column("status", String(16), nullable=False),  # running | complete | failed
    Column("intent", String(16), nullable=False),  # explore | open | improve
    Column("label", String(200), nullable=False),
    Column("lat", Float, nullable=False),
    Column("lon", Float, nullable=False),
    Column("request", JSON, nullable=False),  # the site and the owner's brief, as asked
    Column("events", JSON, nullable=False),  # every event as streamed: [event, data, seconds since the start]
    # The finished run (app.survey.snapshot) as zlib-compressed JSON, so it can still be designed after a restart.
    Column("state", LargeBinary),
    _user(),  # who ran it, when signed in (or who signed in later in the same browser)
    Column("device_id", String(32), index=True),  # the browser that ran it: its walkin_device cookie
    Column("headline", String(200)),  # the top concept's name, or the top gap, for My places
)

designs = Table(
    "designs", metadata,
    Column("survey_id", String(32), ForeignKey("surveys.id", ondelete="CASCADE"), primary_key=True),
    Column("idx", Integer, primary_key=True),  # the concept's position in the survey's concepts
    Column("sheet", JSON, nullable=False),
    _created(),
)

kits = Table(
    "kits", metadata,
    Column("token", String(64), primary_key=True),  # random, in the kit's link: anyone with the link can open the kit
    Column("survey_id", String(32), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
    Column("idx", Integer, nullable=False),  # the concept's position in the survey's concepts
    Column("status", String(16), nullable=False),  # building | ready | failed
    Column("name", String(200)),  # the business's name, for the kit's page and My places
    Column("payload", JSON),  # app.survey.kit.build_kit's kit, dossier included, once ready
    Column("error", String(500)),  # why the last build failed, in plain words
    _created(),
    _updated(),
    UniqueConstraint("survey_id", "idx"),  # one kit per concept
)

campaigns = Table(
    "campaigns", metadata,
    Column("id", String(32), primary_key=True),
    # The kit it started from and the survey and concept behind it: no foreign keys, so a campaign outlives a survey
    # that is purged or deleted with its user's account.
    Column("kit_token", String(64), nullable=True, index=True),
    Column("survey_id", String(32), nullable=True),
    Column("idx", Integer, nullable=True),
    # The owner, the signed-in user who started it; null once they delete their account.
    Column("user_id", String(32), ForeignKey("users.id", ondelete="SET NULL"), index=True),
    Column("status", String(16), nullable=False, index=True),  # open | funded | partial | collected | expired | cancelled
    Column("title", String(200), nullable=False),
    # The page: pitch, perks, how it works, the owner's perk line, and the business, place, concept and evidence as
    # they were when it started.
    Column("offer", JSON, nullable=False),
    Column("amount_cents", Integer, nullable=False),  # each pledge
    Column("currency", String(3), nullable=False),
    Column("goal_count", Integer, nullable=False),  # supporters needed
    Column("deadline", UTCDateTime, nullable=False),
    Column("lat", Float, nullable=False),  # the storefront, for finding campaigns near a place
    Column("lon", Float, nullable=False),
    Column("payout_email", String(320), nullable=False),  # the PayPal account that receives the money
    Column("closed_at", UTCDateTime),  # when the owner closed or cancelled it before the deadline
    Column("funded", Boolean),  # decided once it closes: whether it met its goal; null until then
    Column("report", JSON),  # the last settlement's report, in plain words
    _created(),
    _updated(),
)

pledges = Table(
    "pledges", metadata,
    Column("id", String(32), primary_key=True),  # the order's custom_id
    Column("campaign_id", String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("order_id", String(64), nullable=False, unique=True),  # the PayPal order (intent AUTHORIZE)
    Column("flow", String(16), nullable=False),  # buttons | redirect
    Column("amount_cents", Integer, nullable=False),
    # created | authorized | declined | captured | voided | withdrawn | expired | failed | refunded
    Column("status", String(16), nullable=False, index=True),
    Column("payer_id", String(64)),
    Column("authorization_id", String(64), index=True),  # the original hold: voids always go to it
    Column("authorized_at", UTCDateTime),
    Column("expires_at", UTCDateTime),
    Column("reauthorization_id", String(64), index=True),  # the renewed hold, captured instead of the original
    Column("reauthorized_at", UTCDateTime),
    Column("capture_id", String(64), index=True),
    # COMPLETED, PENDING while PayPal reviews it, or what became of it since: DECLINED, FAILED, REFUNDED,
    # PARTIALLY_REFUNDED (18 characters)
    Column("capture_status", String(32)),
    Column("net_cents", Integer),  # the capture after PayPal's fee (seller_receivable_breakdown.net_amount)
    Column("captured_at", UTCDateTime),
    Column("error", String(64)),  # PayPal's code for why the last settlement could not finish it
    # The SHA-256 of the pledge's private receipt (app.payments.receipts), never the receipt itself; null for pledges
    # made before receipts.
    Column("receipt_hash", String(64), unique=True, index=True),
    _created(),
    _updated(),
)

payouts = Table(
    "payouts", metadata,
    # One per campaign: the campaign's id is the payout's sender_batch_id, which PayPal never pays twice.
    Column("campaign_id", String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), primary_key=True),
    Column("status", String(16), nullable=False, index=True),  # pending | paid | failed
    Column("amount_cents", Integer, nullable=False),  # the net collected total
    Column("currency", String(3), nullable=False),
    Column("email", String(320), nullable=False),  # the receiver, as it was when the payout was sent
    Column("batch_id", String(64), index=True),  # PayPal's payout_batch_id, once PayPal has the payout
    Column("item_id", String(64)),  # PayPal's payout_item_id
    Column("paypal_status", String(16)),  # the item's transaction_status, else the batch's batch_status
    Column("error", String(200)),  # why it failed, or why the last attempt did not reach PayPal
    _created(),
    _updated(),
)

paypal_events = Table(
    "paypal_events", metadata,
    Column("id", String(64), primary_key=True),  # PayPal's event id, so a redelivered webhook is handled once
    Column("event_type", String(64), nullable=False),
    Column("resource_id", String(64)),
    Column("received_at", UTCDateTime, nullable=False, default=utcnow),
    Column("payload", JSON, nullable=False),
)
