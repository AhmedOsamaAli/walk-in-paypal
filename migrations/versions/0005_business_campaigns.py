"""Let a campaign start from the owner's description without inventing a survey or kit."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("campaigns") as batch:
        batch.alter_column("kit_token", existing_type=sa.String(64), nullable=True)
        batch.alter_column("survey_id", existing_type=sa.String(32), nullable=True)
        batch.alter_column("idx", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    connection = op.get_bind()
    count = connection.scalar(sa.text("SELECT COUNT(*) FROM campaigns WHERE kit_token IS NULL"))
    if count:
        raise RuntimeError("Cannot remove business campaigns while campaigns without a kit exist.")
    with op.batch_alter_table("campaigns") as batch:
        batch.alter_column("kit_token", existing_type=sa.String(64), nullable=False)
        batch.alter_column("survey_id", existing_type=sa.String(32), nullable=False)
        batch.alter_column("idx", existing_type=sa.Integer(), nullable=False)
