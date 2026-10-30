"""Upgrade the deployed schema with existing records: no renumbering, erased holds, kits or survey data."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, select, text

from app.db import Database
from app.db.database import MIGRATIONS
from app.db.tables import campaigns, kits, pledges, surveys
from app.payments.records import TEST_MODE


def test_0003_to_0005_preserves_existing_campaigns_pledges_and_kits(database_url):
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.attributes["url"] = database_url
    command.upgrade(config, "0003")
    now = datetime.now(UTC)

    async def seed_and_read():
        database = Database(database_url)
        async with database.engine.begin() as connection:
            await connection.execute(surveys.insert().values(
                id="kept-survey", status="complete", intent="explore", label="Existing site",
                lat=30.26, lon=-97.72, request={"minutes": 10}, events=[], state=b"existing-state",
            ))
            await connection.execute(kits.insert().values(
                token="kept-kit", survey_id="kept-survey", idx=0, status="ready", name="Existing business",
                payload={"poster": {"name": "Existing business"}, "dossier": {"sections": ["cover"]}},
            ))
            await connection.execute(campaigns.insert().values(
                id="kept-campaign", kit_token="kept-kit", survey_id="kept-survey", idx=0, status="open",
                title="Existing campaign", offer={"perks": ["The actual perk"]}, amount_cents=2500,
                currency="USD", goal_count=40, deadline=now + timedelta(days=10), lat=30.26, lon=-97.72,
                payout_email="owner@example.com",
            ))
            await connection.execute(pledges.insert().values(
                id="kept-pledge", campaign_id="kept-campaign", order_id="EXISTINGORDER", flow="buttons",
                amount_cents=2500, status="authorized", authorization_id="EXISTINGHOLD", payer_id="EXISTINGPAYER",
            ))
            old = MetaData()
            await connection.run_sync(old.reflect)
            before = {name: [dict(row) for row in (await connection.execute(select(old.tables[name]))).mappings()]
                      for name in ("surveys", "kits", "campaigns", "pledges")}
        await database.dispose()
        return before

    before = asyncio.run(seed_and_read())
    command.upgrade(config, "head")

    async def verify():
        database = Database(database_url)
        async with database.engine.begin() as connection:
            current = MetaData()
            await connection.run_sync(current.reflect)
            for name, rows in before.items():
                after = [dict(row) for row in (await connection.execute(select(current.tables[name]))).mappings()]
                if name == "pledges":
                    assert after[0].pop("receipt_hash") is None
                assert after == rows
            assert (await connection.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0005"
            for name in ("kit_token", "survey_id", "idx"):
                assert current.tables["campaigns"].c[name].nullable
            assert any(index.unique and [column.name for column in index.columns] == ["receipt_hash"]
                       for index in current.tables["pledges"].indexes)
        await database.dispose()

    asyncio.run(verify())


def test_the_public_payment_disclosure_does_not_claim_demo_funds_are_real():
    assert TEST_MODE == "Demo payments — no real money."
