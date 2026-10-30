"""Walk-in Founders' receipts: each pledge keeps the SHA-256 of its private receipt, never the receipt, so whoever holds
the receipt can follow the pledge and withdraw it later from any device or assistant.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-29

Pledges made before receipts have none (null): their supporters follow and withdraw them on the campaign's page.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("pledges") as batch:
        batch.add_column(sa.Column("receipt_hash", sa.String(64), nullable=True))
        batch.create_index(batch.f("ix_pledges_receipt_hash"), ["receipt_hash"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("pledges") as batch:
        batch.drop_index(batch.f("ix_pledges_receipt_hash"))
        batch.drop_column("receipt_hash")
