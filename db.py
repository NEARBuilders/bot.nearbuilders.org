import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")


def get_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


def setup_db():
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS bot_users (
                    user_id        BIGINT PRIMARY KEY,
                    username       TEXT,
                    first_name     TEXT,
                    started_at     TIMESTAMPTZ DEFAULT NOW(),
                    updated_at     TIMESTAMPTZ DEFAULT NOW(),
                    completed_at   TIMESTAMPTZ DEFAULT NULL
                );

                CREATE TABLE IF NOT EXISTS nomination_log (
                    id                   SERIAL PRIMARY KEY,
                    nominated_user_id    BIGINT,
                    nominated_username   TEXT,
                    nominated_by_user_id BIGINT NOT NULL,
                    group_chat_id        BIGINT NOT NULL,
                    created_at           TIMESTAMPTZ DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS pending_nominations (
                    username             TEXT PRIMARY KEY,
                    nominated_by_user_id BIGINT NOT NULL,
                    group_chat_id        BIGINT NOT NULL,
                    created_at           TIMESTAMPTZ DEFAULT NOW()
                );
            """)

            # Migrate existing bot_users if completed_at column is missing
            cur.execute("""
                ALTER TABLE bot_users
                ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;
            """)

            # Migrate existing nomination_log if nominated_username column is missing
            cur.execute("""
                ALTER TABLE nomination_log
                ADD COLUMN IF NOT EXISTS nominated_username TEXT;
            """)

            # Migrate existing nomination_log if nominated_user_id is NOT NULL constrained
            cur.execute("""
                ALTER TABLE nomination_log
                ALTER COLUMN nominated_user_id DROP NOT NULL;
            """)

        conn.commit()
    print("Database tables ready.")


def has_started_bot(user_id: int) -> bool:
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM bot_users WHERE user_id = %s", (user_id,)
            )
            return cur.fetchone() is not None


def has_pending_nomination(username: str) -> bool:
    """Check if a username has a pending nomination (no user ID yet)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pending_nominations WHERE LOWER(username) = LOWER(%s)",
                (username,)
            )
            return cur.fetchone() is not None


def register_user(user_id: int, username: str | None, first_name: str | None):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO bot_users (user_id, username, first_name)
                VALUES (%s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE
                    SET username = EXCLUDED.username,
                        first_name = EXCLUDED.first_name,
                        updated_at = NOW()
            """, (user_id, username, first_name))
        conn.commit()


def log_nomination(nominated_by_user_id: int, group_chat_id: int,
                   nominated_user_id: int | None = None,
                   nominated_username: str | None = None):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO nomination_log
                    (nominated_user_id, nominated_username, nominated_by_user_id, group_chat_id)
                VALUES (%s, %s, %s, %s)
            """, (nominated_user_id, nominated_username, nominated_by_user_id, group_chat_id))
        conn.commit()


def add_pending_nomination(username: str, nominated_by_user_id: int, group_chat_id: int):
    """Store a nomination for a user we don't have a user_id for yet."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO pending_nominations (username, nominated_by_user_id, group_chat_id)
                VALUES (LOWER(%s), %s, %s)
                ON CONFLICT (username) DO UPDATE
                    SET nominated_by_user_id = EXCLUDED.nominated_by_user_id,
                        group_chat_id = EXCLUDED.group_chat_id,
                        created_at = NOW()
            """, (username, nominated_by_user_id, group_chat_id))
        conn.commit()


def claim_pending_nomination(user_id: int, username: str) -> dict | None:
    """
    When a user /starts the bot, check if there's a pending nomination for their username.
    If found, register them properly, log it, and clear the pending record.
    Returns the nomination dict or None.
    """
    if not username:
        return None
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM pending_nominations WHERE LOWER(username) = LOWER(%s)",
                (username,)
            )
            row = cur.fetchone()
            if not row:
                return None
            nomination = dict(row)

            # Log with the now-known user_id
            cur.execute("""
                INSERT INTO nomination_log
                    (nominated_user_id, nominated_username, nominated_by_user_id, group_chat_id)
                VALUES (%s, %s, %s, %s)
            """, (user_id, username, nomination["nominated_by_user_id"], nomination["group_chat_id"]))

            # Clear the pending record
            cur.execute(
                "DELETE FROM pending_nominations WHERE LOWER(username) = LOWER(%s)",
                (username,)
            )
        conn.commit()
    return nomination


def mark_completed(user_id: int):
    """Mark a user as having completed and submitted their profile."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE bot_users SET completed_at = NOW(), updated_at = NOW()
                WHERE user_id = %s
            """, (user_id,))
        conn.commit()


def has_completed(user_id: int) -> bool:
    """Check if a user has already submitted their profile."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT completed_at FROM bot_users WHERE user_id = %s",
                (user_id,)
            )
            row = cur.fetchone()
            return bool(row and row["completed_at"])


def get_user_by_username(username: str) -> dict | None:
    """Look up a user by their Telegram username (without @)."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_id, username, first_name FROM bot_users WHERE LOWER(username) = LOWER(%s)",
                (username,)
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_nomination(nominated_user_id: int) -> dict | None:
    """Return the most recent nomination record for a user."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT nominated_by_user_id, group_chat_id
                FROM nomination_log
                WHERE nominated_user_id = %s
                ORDER BY created_at DESC
                LIMIT 1
            """, (nominated_user_id,))
            row = cur.fetchone()
            return dict(row) if row else None
