"""Walk-in Founders' records: pledge campaigns, their pledges and payouts, and what is due for settling."""
from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import datetime, timedelta

from sqlalchemy import and_, exists, or_, select, update
from sqlalchemy.exc import IntegrityError

from .database import Database
from .tables import campaigns, payouts, pledges

KM_PER_DEGREE = 111.32
# How long settlement keeps asking PayPal about a capture it has not completed or itemized (an eCheck can take days).
CAPTURE_WATCH = timedelta(days=30)


def unfinished_capture():
    """Pledges collected whose capture PayPal has not completed yet, or whose net (after its fee) is not known yet."""
    return and_(
        pledges.c.status == "captured",
        or_(pledges.c.capture_status.is_(None), pledges.c.capture_status != "COMPLETED", pledges.c.net_cents.is_(None)),
    )


def accepting_clause(now: datetime):
    """Campaigns that still take pledges: open, and before both the deadline and an early close."""
    return and_(
        campaigns.c.status == "open",
        campaigns.c.deadline > now,
        or_(campaigns.c.closed_at.is_(None), campaigns.c.closed_at > now),
    )


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


class CampaignStore:
    def __init__(self, database: Database) -> None:
        self._engine = database.engine

    # Campaigns

    async def create(self, **values: object) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(campaigns.insert().values(**values))

    async def get(self, campaign_id: str) -> dict | None:
        async with self._engine.connect() as connection:
            row = (await connection.execute(select(campaigns).where(campaigns.c.id == campaign_id))).mappings().first()
        return dict(row) if row else None

    async def open_for(self, user_id: str, kit_token: str) -> dict | None:
        """The user's campaign for this kit that is not settled yet (status open), if any."""
        query = select(campaigns).where(
            campaigns.c.user_id == user_id, campaigns.c.kit_token == kit_token, campaigns.c.status == "open",
        ).order_by(campaigns.c.created_at.desc())
        async with self._engine.connect() as connection:
            row = (await connection.execute(query)).mappings().first()
        return dict(row) if row else None

    async def accepting_for_kit(self, kit_token: str, now: datetime, limit: int = 20) -> list[dict]:
        """The kit's campaigns that still take pledges, newest first."""
        query = (
            select(campaigns)
            .where(campaigns.c.kit_token == kit_token, accepting_clause(now))
            .order_by(campaigns.c.created_at.desc(), campaigns.c.id)
            .limit(limit)
        )
        async with self._engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(query)).mappings()]

    async def owned_by(self, user_id: str, limit: int = 100) -> list[dict]:
        query = (
            select(campaigns).where(campaigns.c.user_id == user_id)
            .order_by(campaigns.c.created_at.desc(), campaigns.c.id).limit(limit)
        )
        async with self._engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(query)).mappings()]

    async def newest(self, now: datetime, limit: int = 50) -> list[dict]:
        """Campaigns that still take pledges, newest first."""
        query = select(campaigns).where(accepting_clause(now)).order_by(campaigns.c.created_at.desc(), campaigns.c.id).limit(limit)
        async with self._engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(query)).mappings()]

    async def near(self, lat: float, lon: float, km: float, now: datetime, limit: int = 50) -> list[tuple[dict, float]]:
        """Campaigns that still take pledges within `km` of a point, nearest first, each with its distance."""
        dlat = km / KM_PER_DEGREE
        query = select(campaigns).where(
            accepting_clause(now), campaigns.c.lat >= lat - dlat, campaigns.c.lat <= lat + dlat,
        )
        cos = math.cos(math.radians(lat))
        if cos > 0.01 and km / (KM_PER_DEGREE * cos) < 180 - abs(lon):  # no pole or antimeridian inside the box
            dlon = km / (KM_PER_DEGREE * cos)
            query = query.where(campaigns.c.lon >= lon - dlon, campaigns.c.lon <= lon + dlon)
        async with self._engine.connect() as connection:
            rows = [dict(row) for row in (await connection.execute(query)).mappings()]
        found = [(row, distance_km(lat, lon, row["lat"], row["lon"])) for row in rows]
        found = [(row, distance) for row, distance in found if distance <= km]
        found.sort(key=lambda pair: (pair[1], pair[0]["id"]))
        return found[:limit]

    async def survey_ids(self) -> list[str]:
        """The surveys behind campaigns, kept from the purge of old surveys so their kits and links stay."""
        async with self._engine.connect() as connection:
            query = select(campaigns.c.survey_id).where(campaigns.c.survey_id.is_not(None)).distinct()
            return list((await connection.execute(query)).scalars())

    async def update(self, campaign_id: str, **values: object) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(update(campaigns).where(campaigns.c.id == campaign_id).values(**values))

    async def due(self, now: datetime) -> list[str]:
        """Campaigns to settle now: open ones past their close, funded or partial ones still collecting, settled ones
        with a hold left over (it came in late), and funded ones with a capture PayPal has not completed or itemized yet
        (for 30 days), oldest deadline first."""
        held = exists().where(pledges.c.campaign_id == campaigns.c.id, pledges.c.status == "authorized")
        unsettled = exists().where(
            pledges.c.campaign_id == campaigns.c.id, unfinished_capture(), pledges.c.captured_at > now - CAPTURE_WATCH,
        )
        closed = or_(campaigns.c.deadline <= now, campaigns.c.closed_at <= now)
        query = select(campaigns.c.id).where(or_(
            (campaigns.c.status == "open") & closed,
            campaigns.c.status == "funded",
            campaigns.c.status.in_(("partial", "collected")) & unsettled,
            (campaigns.c.status != "open") & held,
        )).order_by(campaigns.c.deadline, campaigns.c.id)
        async with self._engine.connect() as connection:
            return list((await connection.execute(query)).scalars())

    async def payouts_due(self) -> list[str]:
        """Funded campaigns ready to pay out and not paid out for good: settled (collected, or partial with nothing
        left to collect), with money collected and every capture completed and itemized, and no payout yet or one
        still pending."""
        finished = select(payouts.c.campaign_id).where(payouts.c.status != "pending")
        collected = exists().where(pledges.c.campaign_id == campaigns.c.id, pledges.c.status == "captured")
        waiting = exists().where(
            pledges.c.campaign_id == campaigns.c.id, or_(pledges.c.status == "authorized", unfinished_capture()),
        )
        query = select(campaigns.c.id).where(
            campaigns.c.status.in_(("collected", "partial")), campaigns.c.funded.is_(True), campaigns.c.id.not_in(finished),
            collected, ~waiting,
        ).order_by(campaigns.c.deadline, campaigns.c.id)
        async with self._engine.connect() as connection:
            return list((await connection.execute(query)).scalars())

    # Pledges

    async def add_pledge(self, **values: object) -> None:
        async with self._engine.begin() as connection:
            await connection.execute(pledges.insert().values(**values))

    async def pledges(self, campaign_ids: Iterable[str]) -> list[dict]:
        ids = list(campaign_ids)
        if not ids:
            return []
        query = select(pledges).where(pledges.c.campaign_id.in_(ids)).order_by(pledges.c.created_at, pledges.c.id)
        async with self._engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(query)).mappings()]

    async def pledge(self, **match: str) -> dict | None:
        """The pledge whose columns equal `match`, such as campaign_id and order_id."""
        query = select(pledges).where(*(pledges.c[column] == value for column, value in match.items()))
        async with self._engine.connect() as connection:
            row = (await connection.execute(query)).mappings().first()
        return dict(row) if row else None

    async def pledge_in(self, campaign_id: str, reference: str) -> dict | None:
        """A campaign's pledge by its PayPal order id or by our own id (the custom_id, in the redirect flow's return
        link)."""
        query = select(pledges).where(
            pledges.c.campaign_id == campaign_id, or_(pledges.c.order_id == reference, pledges.c.id == reference),
        )
        async with self._engine.connect() as connection:
            row = (await connection.execute(query)).mappings().first()
        return dict(row) if row else None

    async def pledge_by_authorization(self, authorization_id: str) -> dict | None:
        """The pledge holding this authorization, original or renewed."""
        query = select(pledges).where(or_(
            pledges.c.authorization_id == authorization_id, pledges.c.reauthorization_id == authorization_id,
        ))
        async with self._engine.connect() as connection:
            row = (await connection.execute(query)).mappings().first()
        return dict(row) if row else None

    async def update_pledge(self, pledge_id: str, *, only: tuple[str, ...] = (), **values: object) -> bool:
        """Changes a pledge; with `only`, just while its status is one of them. False when nothing changed."""
        query = update(pledges).where(pledges.c.id == pledge_id)
        if only:
            query = query.where(pledges.c.status.in_(only))
        async with self._engine.begin() as connection:
            result = await connection.execute(query.values(**values))
        return result.rowcount == 1

    async def save(self, campaign_id: str, campaign: dict, changes: dict[str, dict]) -> None:
        """Stores a settlement in one transaction: the campaign's new values and each changed pledge's."""
        async with self._engine.begin() as connection:
            if campaign:
                await connection.execute(update(campaigns).where(campaigns.c.id == campaign_id).values(**campaign))
            for pledge_id, values in changes.items():
                await connection.execute(update(pledges).where(pledges.c.id == pledge_id).values(**values))

    # Payouts

    async def payout(self, campaign_id: str) -> dict | None:
        async with self._engine.connect() as connection:
            row = (await connection.execute(select(payouts).where(payouts.c.campaign_id == campaign_id))).mappings().first()
        return dict(row) if row else None

    async def payouts_of(self, campaign_ids: Iterable[str]) -> dict[str, dict]:
        ids = list(campaign_ids)
        if not ids:
            return {}
        async with self._engine.connect() as connection:
            rows = (await connection.execute(select(payouts).where(payouts.c.campaign_id.in_(ids)))).mappings()
            return {row["campaign_id"]: dict(row) for row in rows}

    async def start_payout(self, campaign_id: str, **values: object) -> dict:
        """The campaign's payout: recorded now as pending with these values, or the one recorded before (a campaign is
        paid out once)."""
        try:
            async with self._engine.begin() as connection:
                await connection.execute(payouts.insert().values(campaign_id=campaign_id, status="pending", **values))
        except IntegrityError:
            pass
        found = await self.payout(campaign_id)
        if found is None:
            raise LookupError(f"Campaign {campaign_id} is gone")
        return found

    async def payout_by_batch(self, batch_id: str) -> dict | None:
        async with self._engine.connect() as connection:
            row = (await connection.execute(select(payouts).where(payouts.c.batch_id == batch_id))).mappings().first()
        return dict(row) if row else None

    async def update_payout(self, campaign_id: str, *, unless: tuple[str, ...] = (), **values: object) -> bool:
        """Changes a payout; with `unless`, not while its status is one of them. False when nothing changed."""
        query = update(payouts).where(payouts.c.campaign_id == campaign_id)
        if unless:
            query = query.where(payouts.c.status.not_in(unless))
        async with self._engine.begin() as connection:
            result = await connection.execute(query.values(**values))
        return result.rowcount == 1
