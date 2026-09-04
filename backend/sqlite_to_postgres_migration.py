import os
import sys

# Ensure backend package is on path when run as: python -m backend.sqlite_to_postgres_migration
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import config
import models


"""
One-time migration script: copy data from the existing local SQLite DB (task.db)
into a PostgreSQL database.

Usage (from project root):

    # 1) Set target Postgres URL (example):
    #    postgresql+psycopg2://user:password@localhost:5432/team_task_app
    set TARGET_DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/dbname   (Windows PowerShell/cmd)

    # 2) Run the migration:
    python -m backend.sqlite_to_postgres_migration

This will:
  - Read from the existing SQLite DB defined by config.DATABASE_PATH
  - Create all tables in the target Postgres DB (if not present)
  - Copy rows table-by-table in a safe foreign-key order
"""


def migrate():
    target_url = os.getenv("TARGET_DATABASE_URL")
    if not target_url:
        raise RuntimeError(
            "TARGET_DATABASE_URL environment variable is required.\n"
            "Example: postgresql+psycopg2://user:password@localhost:5432/team_task_app"
        )

    # Source: existing SQLite file (always use explicit SQLite URL so it still works
    # even after you switch main DATABASE_URL to PostgreSQL).
    sqlite_url = f"sqlite:///{config.DATABASE_PATH}"

    sqlite_engine = create_engine(sqlite_url)
    pg_engine = create_engine(target_url)

    SQLiteSession = sessionmaker(bind=sqlite_engine)
    PGSession = sessionmaker(bind=pg_engine)

    # Ensure schema exists in Postgres
    models.Base.metadata.create_all(bind=pg_engine)

    src = SQLiteSession()
    dst = PGSession()

    # Order matters: parents first, then children with FKs.
    tables_in_order = [
        models.User,
        models.Team,
        models.TeamMember,
        models.TeamInvitation,
        models.Activity,
        models.Task,
        models.Comment,
        models.ActivityLog,
        models.ActivityMessage,
        models.TaskExtensionRequest,
        models.TaskCompletionRequest,
    ]

    try:
        for model in tables_in_order:
            rows = src.query(model).all()
            if not rows:
                continue
            # Detach objects from SQLite session and add to Postgres.
            for obj in rows:
                # Create a new instance to avoid carrying over session state
                data = {c.name: getattr(obj, c.name) for c in model.__table__.columns}
                dst.add(model(**data))
            dst.commit()
            print(f"Migrated {len(rows)} rows from table {model.__tablename__}")
    except Exception:
        dst.rollback()
        raise
    finally:
        src.close()
        dst.close()


if __name__ == "__main__":
    migrate()

