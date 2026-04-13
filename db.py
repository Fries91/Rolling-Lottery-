from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

DB_PATH = os.environ.get("DB_PATH", "sinners_lottery.db")


# ============================================================
# CONNECTION HELPERS
# ============================================================

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_conn():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


# ============================================================
# INIT / MIGRATIONS
# ============================================================

def init_db() -> None:
    with db_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS lottery_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER NOT NULL DEFAULT 1,
                faction_id INTEGER NOT NULL DEFAULT 0,
                payment_receiver_id INTEGER NOT NULL DEFAULT 3679030,
                payment_receiver_name TEXT NOT NULL DEFAULT 'Fries91',
                ticket_price INTEGER NOT NULL DEFAULT 1000000,
                prize_percent INTEGER NOT NULL DEFAULT 75,
                max_tickets_per_member INTEGER NOT NULL DEFAULT 5,
                draw_day INTEGER NOT NULL DEFAULT 6,
                draw_hour INTEGER NOT NULL DEFAULT 20,
                draw_minute INTEGER NOT NULL DEFAULT 0,
                timezone TEXT NOT NULL DEFAULT 'America/Toronto',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS lottery_rounds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                week_key TEXT NOT NULL UNIQUE,
                starts_at TEXT NOT NULL,
                sales_close_at TEXT NOT NULL,
                draw_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                ticket_price INTEGER NOT NULL,
                prize_percent INTEGER NOT NULL,
                total_tickets INTEGER NOT NULL DEFAULT 0,
                gross_pool INTEGER NOT NULL DEFAULT 0,
                winner_user_id INTEGER,
                winner_name TEXT,
                winning_ticket_id INTEGER,
                winning_ticket_number INTEGER,
                winner_payout INTEGER NOT NULL DEFAULT 0,
                drawn_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS lottery_tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                round_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                ticket_number INTEGER NOT NULL,
                payment_amount INTEGER NOT NULL,
                payment_key TEXT NOT NULL UNIQUE,
                payment_ref TEXT,
                verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (round_id) REFERENCES lottery_rounds(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_lottery_tickets_round_id
            ON lottery_tickets(round_id);

            CREATE INDEX IF NOT EXISTS idx_lottery_tickets_round_user
            ON lottery_tickets(round_id, user_id);

            CREATE INDEX IF NOT EXISTS idx_lottery_rounds_status
            ON lottery_rounds(status);
            """
        )
        ensure_default_settings(conn)


def ensure_default_settings(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT id FROM lottery_settings WHERE id = 1").fetchone()
    if row is None:
        conn.execute(
            """
            INSERT INTO lottery_settings (
                id,
                enabled,
                faction_id,
                payment_receiver_id,
                payment_receiver_name,
                ticket_price,
                prize_percent,
                max_tickets_per_member,
                draw_day,
                draw_hour,
                draw_minute,
                timezone,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                1,
                1,
                0,
                3679030,
                "Fries91",
                1_000_000,
                75,
                5,
                6,   # Saturday
                20,  # 8 PM
                0,
                "America/Toronto",
            ),
        )


# ============================================================
# SETTINGS
# ============================================================

def get_settings(conn: sqlite3.Connection) -> dict:
    ensure_default_settings(conn)
    row = conn.execute("SELECT * FROM lottery_settings WHERE id = 1").fetchone()
    return dict(row)


def update_settings(conn: sqlite3.Connection, payload: dict) -> dict:
    current = get_settings(conn)

    allowed = {
        "enabled",
        "faction_id",
        "payment_receiver_id",
        "payment_receiver_name",
        "ticket_price",
        "prize_percent",
        "max_tickets_per_member",
        "draw_day",
        "draw_hour",
        "draw_minute",
        "timezone",
    }

    updates = {}
    for key, value in payload.items():
        if key in allowed:
            updates[key] = value

    if not updates:
        return current

    updates["updated_at"] = datetime.utcnow().isoformat()

    columns = ", ".join([f"{key} = ?" for key in updates.keys()])
    values = list(updates.values())
    values.append(1)

    conn.execute(
        f"""
        UPDATE lottery_settings
        SET {columns}
        WHERE id = ?
        """,
        values,
    )
    return get_settings(conn)


# ============================================================
# TIME / ROUND HELPERS
# ============================================================

def get_local_now(settings: dict) -> datetime:
    tz_name = settings.get("timezone") or "America/Toronto"
    return datetime.now(ZoneInfo(tz_name))


def get_week_window(now_local: datetime, draw_day: int, draw_hour: int, draw_minute: int) -> tuple[datetime, datetime, datetime]:
    """
    Week opens Sunday 12:00 AM.
    Draw is Saturday at configured time.
    draw_day: Python weekday format, Monday=0 ... Sunday=6
    You chose Saturday, so default draw_day = 5 in Python terms.
    To match your earlier planning using Saturday, we normalize below.
    """
    # Your settings were planned with Saturday = 6 in custom logic.
    # Normalize to Python weekday:
    # custom: Sunday=0, Monday=1 ... Saturday=6
    # python: Monday=0 ... Sunday=6
    custom_weekday = (now_local.weekday() + 1) % 7  # Sunday=0 ... Saturday=6

    start_of_week = (now_local - timedelta(days=custom_weekday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    draw_at = start_of_week + timedelta(days=draw_day)
    draw_at = draw_at.replace(hour=draw_hour, minute=draw_minute, second=0, microsecond=0)

    sales_close_at = draw_at
    return start_of_week, sales_close_at, draw_at


def make_week_key(start_of_week: datetime) -> str:
    return start_of_week.strftime("%Y-%m-%d")


def get_or_create_current_round(conn: sqlite3.Connection) -> dict:
    settings = get_settings(conn)
    now_local = get_local_now(settings)

    start_of_week, sales_close_at, draw_at = get_week_window(
        now_local=now_local,
        draw_day=int(settings["draw_day"]),
        draw_hour=int(settings["draw_hour"]),
        draw_minute=int(settings["draw_minute"]),
    )
    week_key = make_week_key(start_of_week)

    row = conn.execute(
        "SELECT * FROM lottery_rounds WHERE week_key = ?",
        (week_key,),
    ).fetchone()

    if row is None:
        conn.execute(
            """
            INSERT INTO lottery_rounds (
                week_key,
                starts_at,
                sales_close_at,
                draw_at,
                status,
                ticket_price,
                prize_percent,
                total_tickets,
                gross_pool,
                winner_payout,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                week_key,
                start_of_week.isoformat(),
                sales_close_at.isoformat(),
                draw_at.isoformat(),
                "open",
                int(settings["ticket_price"]),
                int(settings["prize_percent"]),
            ),
        )
        row = conn.execute(
            "SELECT * FROM lottery_rounds WHERE week_key = ?",
            (week_key,),
        ).fetchone()

    return dict(row)


def get_round_by_id(conn: sqlite3.Connection, round_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM lottery_rounds WHERE id = ?",
        (round_id,),
    ).fetchone()
    return row_to_dict(row)


def get_latest_drawn_round(conn: sqlite3.Connection) -> dict | None:
    row = conn.execute(
        """
        SELECT *
        FROM lottery_rounds
        WHERE status = 'drawn'
        ORDER BY draw_at DESC
        LIMIT 1
        """
    ).fetchone()
    return row_to_dict(row)


def set_round_status(conn: sqlite3.Connection, round_id: int, status: str) -> None:
    conn.execute(
        """
        UPDATE lottery_rounds
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (status, round_id),
    )


def maybe_lock_current_round(conn: sqlite3.Connection) -> dict:
    current_round = get_or_create_current_round(conn)
    settings = get_settings(conn)
    now_local = get_local_now(settings)

    draw_at = datetime.fromisoformat(current_round["draw_at"])
    if current_round["status"] == "open" and now_local >= draw_at:
        set_round_status(conn, int(current_round["id"]), "locked")
        current_round = get_round_by_id(conn, int(current_round["id"])) or current_round

    return current_round


# ============================================================
# ROUND TOTALS / PAYOUTS
# ============================================================

def calculate_round_totals(conn: sqlite3.Connection, round_id: int) -> dict:
    round_row = get_round_by_id(conn, round_id)
    if not round_row:
        raise ValueError("Round not found.")

    totals = conn.execute(
        """
        SELECT
            COUNT(*) AS total_tickets,
            COALESCE(SUM(payment_amount), 0) AS gross_pool
        FROM lottery_tickets
        WHERE round_id = ?
        """,
        (round_id,),
    ).fetchone()

    total_tickets = int(totals["total_tickets"] or 0)
    gross_pool = int(totals["gross_pool"] or 0)
    prize_percent = int(round_row["prize_percent"])
    winner_payout = (gross_pool * prize_percent) // 100

    conn.execute(
        """
        UPDATE lottery_rounds
        SET total_tickets = ?,
            gross_pool = ?,
            winner_payout = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (total_tickets, gross_pool, winner_payout, round_id),
    )

    return {
        "total_tickets": total_tickets,
        "gross_pool": gross_pool,
        "winner_payout": winner_payout,
    }


# ============================================================
# TICKETS
# ============================================================

def get_user_ticket_count(conn: sqlite3.Connection, round_id: int, user_id: int) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS c
        FROM lottery_tickets
        WHERE round_id = ? AND user_id = ?
        """,
        (round_id, user_id),
    ).fetchone()
    return int(row["c"] or 0)


def get_next_ticket_number(conn: sqlite3.Connection, round_id: int) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(ticket_number), 0) AS max_ticket
        FROM lottery_tickets
        WHERE round_id = ?
        """,
        (round_id,),
    ).fetchone()
    return int(row["max_ticket"] or 0) + 1


def add_verified_tickets(
    conn: sqlite3.Connection,
    round_id: int,
    user_id: int,
    user_name: str,
    quantity: int,
    payment_amount_total: int,
    payment_key_prefix: str,
    payment_ref: str | None = None,
) -> list[int]:
    if quantity < 1:
        raise ValueError("Quantity must be at least 1.")

    round_row = get_round_by_id(conn, round_id)
    if not round_row:
        raise ValueError("Round not found.")

    ticket_price = int(round_row["ticket_price"])
    expected_total = ticket_price * quantity
    if payment_amount_total != expected_total:
        raise ValueError("Payment amount does not match ticket total.")

    next_num = get_next_ticket_number(conn, round_id)
    ticket_numbers: list[int] = []

    for i in range(quantity):
        ticket_number = next_num + i
        ticket_key = f"{payment_key_prefix}:ticket:{ticket_number}"

        conn.execute(
            """
            INSERT INTO lottery_tickets (
                round_id,
                user_id,
                user_name,
                ticket_number,
                payment_amount,
                payment_key,
                payment_ref,
                verified_at,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                round_id,
                user_id,
                user_name,
                ticket_number,
                ticket_price,
                ticket_key,
                payment_ref,
            ),
        )
        ticket_numbers.append(ticket_number)

    calculate_round_totals(conn, round_id)
    return ticket_numbers


def get_round_tickets(conn: sqlite3.Connection, round_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT *
        FROM lottery_tickets
        WHERE round_id = ?
        ORDER BY ticket_number ASC
        """,
        (round_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_wheel_entries(conn: sqlite3.Connection, round_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id AS ticket_id, ticket_number, user_id, user_name
        FROM lottery_tickets
        WHERE round_id = ?
        ORDER BY RANDOM()
        """,
        (round_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_round_entrants_summary(conn: sqlite3.Connection, round_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            user_id,
            user_name,
            COUNT(*) AS ticket_count,
            COALESCE(SUM(payment_amount), 0) AS total_paid
        FROM lottery_tickets
        WHERE round_id = ?
        GROUP BY user_id, user_name
        ORDER BY ticket_count DESC, user_name COLLATE NOCASE ASC
        """,
        (round_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ============================================================
# WINNER / DRAW STORAGE
# ============================================================

def save_draw_result(
    conn: sqlite3.Connection,
    round_id: int,
    winner_user_id: int,
    winner_name: str,
    winning_ticket_id: int,
    winning_ticket_number: int,
) -> dict:
    round_row = get_round_by_id(conn, round_id)
    if not round_row:
        raise ValueError("Round not found.")

    gross_pool = int(round_row["gross_pool"])
    prize_percent = int(round_row["prize_percent"])
    winner_payout = (gross_pool * prize_percent) // 100

    conn.execute(
        """
        UPDATE lottery_rounds
        SET status = 'drawn',
            winner_user_id = ?,
            winner_name = ?,
            winning_ticket_id = ?,
            winning_ticket_number = ?,
            winner_payout = ?,
            drawn_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            winner_user_id,
            winner_name,
            winning_ticket_id,
            winning_ticket_number,
            winner_payout,
            round_id,
        ),
    )

    updated = get_round_by_id(conn, round_id)
    if not updated:
        raise ValueError("Failed to reload updated round.")
    return updated


# ============================================================
# HISTORY / ADMIN HELPERS
# ============================================================

def get_history(conn: sqlite3.Connection, limit: int = 10) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            id,
            week_key,
            starts_at,
            sales_close_at,
            draw_at,
            status,
            total_tickets,
            gross_pool,
            winner_user_id,
            winner_name,
            winning_ticket_number,
            winner_payout,
            drawn_at
        FROM lottery_rounds
        ORDER BY draw_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_admin_round_state(conn: sqlite3.Connection, round_id: int) -> dict:
    round_row = get_round_by_id(conn, round_id)
    if not round_row:
        raise ValueError("Round not found.")

    entrants = get_round_entrants_summary(conn, round_id)
    tickets = get_round_tickets(conn, round_id)

    return {
        "round": round_row,
        "entrants": entrants,
        "tickets": tickets,
    }


# ============================================================
# BASIC TEST RUN
# ============================================================

if __name__ == "__main__":
    init_db()
    with db_conn() as conn:
        current = get_or_create_current_round(conn)
        print("DB initialized.")
        print("Current round:", current["week_key"], current["status"])
