import os
import sqlite3
import time
import secrets
from functools import wraps

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

APP_NAME = "Fries91's Giveaway"
ADMIN_PLAYER_ID = int(os.environ.get("ADMIN_PLAYER_ID", "3679030"))
DB_PATH = os.environ.get("DB_PATH", "giveaway.db")
TORN_API_BASE = os.environ.get("TORN_API_BASE", "https://api.torn.com")
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "12"))

app = Flask(__name__)
CORS(app, supports_credentials=False)


def now_ts():
    return int(time.time())


def db():
    folder = os.path.dirname(DB_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn, name):
    return bool(conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,)
    ).fetchone())


def cols(conn, name):
    if not table_exists(conn, name):
        return set()
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({name})").fetchall()}


def archive_table(conn, name):
    if table_exists(conn, name):
        conn.execute(f"ALTER TABLE {name} RENAME TO {name}_old_{now_ts()}")


def add_col(conn, table, col, sql):
    if col not in cols(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {sql}")


def ensure_users(conn):
    c = cols(conn, "users")
    if c and "player_id" not in c:
        archive_table(conn, "users")
        c = set()

    if not c:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                player_id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                api_key TEXT,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        return

    add_col(conn, "users", "name", "name TEXT NOT NULL DEFAULT 'Unknown'")
    add_col(conn, "users", "api_key", "api_key TEXT")
    add_col(conn, "users", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0")
    add_col(conn, "users", "created_at", "created_at INTEGER NOT NULL DEFAULT 0")
    add_col(conn, "users", "updated_at", "updated_at INTEGER NOT NULL DEFAULT 0")


def ensure_sessions(conn):
    c = cols(conn, "sessions")
    needed = {"token", "player_id", "expires_at", "created_at"}
    if c and not needed.issubset(c):
        archive_table(conn, "sessions")
        c = set()

    if not c:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                player_id INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            )
        """)


def ensure_giveaways(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS giveaways (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT 'Fries91''s Giveaway',
            prize_label TEXT NOT NULL DEFAULT 'Prize',
            total_pool INTEGER NOT NULL DEFAULT 0,
            base_payout INTEGER NOT NULL DEFAULT 50000000,
            entry_item_name TEXT NOT NULL DEFAULT 'Xanax',
            entry_item_value INTEGER NOT NULL DEFAULT 850000,
            player_percent INTEGER NOT NULL DEFAULT 60,
            rollover_percent INTEGER NOT NULL DEFAULT 20,
            reserve_percent INTEGER NOT NULL DEFAULT 20,
            rollover_pool INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'open',
            draw_at INTEGER,
            winner_player_id INTEGER,
            winner_name TEXT,
            created_by INTEGER,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            deleted_at INTEGER,
            draw_type TEXT NOT NULL DEFAULT 'rolling'
        )
    """)
    for col, sql in [
        ("title", "title TEXT NOT NULL DEFAULT 'Fries91''s Giveaway'"),
        ("prize_label", "prize_label TEXT NOT NULL DEFAULT 'Prize'"),
        ("total_pool", "total_pool INTEGER NOT NULL DEFAULT 0"),
        ("base_payout", "base_payout INTEGER NOT NULL DEFAULT 50000000"),
        ("entry_item_name", "entry_item_name TEXT NOT NULL DEFAULT 'Xanax'"),
        ("entry_item_value", "entry_item_value INTEGER NOT NULL DEFAULT 850000"),
        ("player_percent", "player_percent INTEGER NOT NULL DEFAULT 60"),
        ("rollover_percent", "rollover_percent INTEGER NOT NULL DEFAULT 20"),
        ("reserve_percent", "reserve_percent INTEGER NOT NULL DEFAULT 20"),
        ("rollover_pool", "rollover_pool INTEGER NOT NULL DEFAULT 0"),
        ("status", "status TEXT NOT NULL DEFAULT 'open'"),
        ("draw_at", "draw_at INTEGER"),
        ("winner_player_id", "winner_player_id INTEGER"),
        ("winner_name", "winner_name TEXT"),
        ("created_by", "created_by INTEGER"),
        ("created_at", "created_at INTEGER NOT NULL DEFAULT 0"),
        ("updated_at", "updated_at INTEGER NOT NULL DEFAULT 0"),
        ("deleted_at", "deleted_at INTEGER"),
        ("draw_type", "draw_type TEXT NOT NULL DEFAULT 'rolling'"),
    ]:
        add_col(conn, "giveaways", col, sql)


def ensure_entries(conn):
    c = cols(conn, "entries")
    needed = {"id", "giveaway_id", "player_id", "name", "created_at"}
    if c and not needed.issubset(c):
        archive_table(conn, "entries")
        c = set()

    if not c:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                reviewed_by INTEGER,
                reviewed_at INTEGER,
                points_spent INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                UNIQUE(giveaway_id, player_id)
            )
        """)
        return

    add_col(conn, "entries", "status", "status TEXT NOT NULL DEFAULT 'pending'")
    add_col(conn, "entries", "reviewed_by", "reviewed_by INTEGER")
    add_col(conn, "entries", "reviewed_at", "reviewed_at INTEGER")
    add_col(conn, "entries", "points_spent", "points_spent INTEGER NOT NULL DEFAULT 1")


def ensure_points(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS point_balances (
            player_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL DEFAULT 'Unknown',
            balance INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS point_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT 'Unknown',
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT 'adjustment',
            created_by INTEGER,
            created_at INTEGER NOT NULL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS point_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            claim_date TEXT NOT NULL,
            amount INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(player_id, claim_date)
        )
    """)


def init_db():
    with db() as conn:
        ensure_users(conn)
        ensure_sessions(conn)
        ensure_giveaways(conn)
        ensure_entries(conn)

        if "player_id" in cols(conn, "sessions") and "player_id" in cols(conn, "users"):
            conn.execute("DELETE FROM sessions WHERE player_id NOT IN (SELECT player_id FROM users)")

        t = now_ts()
        conn.execute("""
            UPDATE giveaways
            SET title=?
            WHERE title IS NULL OR title='' OR title='Rolling Giveaway' OR title='Torn Rolling Giveaway'
        """, ("Fries91's Giveaway",))
        conn.execute("UPDATE giveaways SET created_at=? WHERE created_at IS NULL OR created_at=0", (t,))
        conn.execute("UPDATE giveaways SET updated_at=? WHERE updated_at IS NULL OR updated_at=0", (t,))
        conn.execute("UPDATE giveaways SET draw_type='rolling' WHERE draw_type IS NULL OR draw_type=''")

        if not conn.execute("SELECT id FROM giveaways ORDER BY id DESC LIMIT 1").fetchone():
            conn.execute("""
                INSERT INTO giveaways
                (title, prize_label, total_pool, base_payout, entry_item_name, entry_item_value,
                 player_percent, rollover_percent, reserve_percent, rollover_pool, status, draw_at,
                 created_by, created_at, updated_at)
                VALUES (?, ?, 0, ?, ?, ?, 60, 20, 20, 0, 'open', NULL, ?, ?, ?)
            """, ("Fries91's Giveaway", "Faction/Event Prize", 50000000, "Xanax", 850000, ADMIN_PLAYER_ID, t, t))


init_db()


@app.errorhandler(Exception)
def all_errors(exc):
    app.logger.exception("Server error")
    return jsonify({"ok": False, "error": "Server error. Check Render logs.", "detail": str(exc)}), 500


def session():
    token = request.headers.get("X-Giveaway-Session", "").strip()
    if not token:
        return None
    with db() as conn:
        ensure_users(conn)
        ensure_sessions(conn)
        row = conn.execute("""
            SELECT s.token, s.player_id, s.expires_at, u.name, u.is_admin
            FROM sessions s
            JOIN users u ON u.player_id = s.player_id
            WHERE s.token = ?
        """, (token,)).fetchone()
        if not row or int(row["expires_at"]) < now_ts():
            return None
        return dict(row)


def login_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        s = session()
        if not s:
            return jsonify({"ok": False, "error": "Login required"}), 401
        return fn(s, *a, **kw)
    return wrap


def admin_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        s = session()
        if not s:
            return jsonify({"ok": False, "error": "Login required"}), 401
        if int(s["player_id"]) != ADMIN_PLAYER_ID:
            return jsonify({"ok": False, "error": "Admin only"}), 403
        return fn(s, *a, **kw)
    return wrap


def count_entries(conn, giveaway_id, status=None):
    if status:
        return int(conn.execute(
            "SELECT COUNT(*) AS c FROM entries WHERE giveaway_id=? AND status=?",
            (giveaway_id, status)
        ).fetchone()["c"])
    return int(conn.execute(
        "SELECT COUNT(*) AS c FROM entries WHERE giveaway_id=?",
        (giveaway_id,)
    ).fetchone()["c"])


def sum_entry_points(conn, giveaway_id, status=None):
    if status:
        return int(conn.execute(
            "SELECT COALESCE(SUM(points_spent), 0) AS c FROM entries WHERE giveaway_id=? AND status=?",
            (giveaway_id, status)
        ).fetchone()["c"] or 0)
    return int(conn.execute(
        "SELECT COALESCE(SUM(points_spent), 0) AS c FROM entries WHERE giveaway_id=?",
        (giveaway_id,)
    ).fetchone()["c"] or 0)


def clean_giveaway(conn, g, private=False):
    approved_count = count_entries(conn, g["id"], "approved")
    approved_points = sum_entry_points(conn, g["id"], "approved")
    pending_points = sum_entry_points(conn, g["id"], "pending")
    pending_count = count_entries(conn, g["id"], "pending")
    rejected_count = count_entries(conn, g["id"], "rejected")
    total_entry_count = count_entries(conn, g["id"])

    base_payout = int(g["base_payout"] or 0)
    entry_item_value = int(g["entry_item_value"] or 0)
    computed_pool = base_payout + (approved_points * entry_item_value)

    pp = int(g["player_percent"] or 60)
    rp = int(g["rollover_percent"] or 20)
    ap = int(g["reserve_percent"] or 20)

    out = {
        "id": g["id"],
        "title": g["title"] or "Fries91's Giveaway",
        "prize_label": g["prize_label"] or "Prize",
        "draw_type": g["draw_type"] if "draw_type" in g.keys() else "rolling",
        "base_payout": base_payout,
        "entry_item_name": g["entry_item_name"] or "Xanax",
        "entry_item_value": entry_item_value,
        "entry_count": approved_count,
        "approved_entry_count": approved_count,
        "pending_entry_count": pending_count,
        "rejected_entry_count": rejected_count,
        "total_entry_count": total_entry_count,
        "approved_points_total": approved_points,
        "pending_points_total": pending_points,
        "entry_growth_total": approved_points * entry_item_value,
        "total_pool": computed_pool,
        "player_percent": pp,
        "rollover_percent": rp,
        "status": g["status"] or "open",
        "draw_at": g["draw_at"],
        "winner_player_id": g["winner_player_id"],
        "winner_name": g["winner_name"],
        "rollover_pool": int(g["rollover_pool"] or 0),
        "player_cut": computed_pool * pp // 100,
        "rollover_cut": computed_pool * rp // 100,
        "next_starting_jackpot": computed_pool * rp // 100,
        "rolling_jackpot": computed_pool,
        "entry_is_free": True,
        "approval_required": True,
    }
    if private:
        out["reserve_percent"] = ap
        out["reserve_cut"] = computed_pool * ap // 100
        out["admin_player_id"] = ADMIN_PLAYER_ID
    return out


def get_point_balance(conn, player_id, name=None):
    ensure_points(conn)
    row = conn.execute(
        "SELECT player_id, name, balance, updated_at FROM point_balances WHERE player_id=?",
        (player_id,)
    ).fetchone()
    if not row:
        t = now_ts()
        conn.execute(
            "INSERT INTO point_balances (player_id, name, balance, updated_at) VALUES (?, ?, 0, ?)",
            (player_id, name or f"Player {player_id}", t)
        )
        row = conn.execute(
            "SELECT player_id, name, balance, updated_at FROM point_balances WHERE player_id=?",
            (player_id,)
        ).fetchone()
    return dict(row)


def add_points(conn, player_id, name, amount, reason, created_by=None):
    ensure_points(conn)
    player_id = int(player_id)
    amount = int(amount)
    if amount == 0:
        raise ValueError("Amount cannot be 0")

    safe_name = (name or f"Player {player_id}").strip() or f"Player {player_id}"
    t = now_ts()

    row = conn.execute(
        "SELECT balance FROM point_balances WHERE player_id=?",
        (player_id,)
    ).fetchone()

    if not row:
        current = 0
        conn.execute(
            "INSERT INTO point_balances (player_id, name, balance, updated_at) VALUES (?, ?, 0, ?)",
            (player_id, safe_name, t)
        )
    else:
        current = int(row["balance"] or 0)

    new_balance = current + amount
    if new_balance < 0:
        raise ValueError("Not enough points")

    conn.execute(
        "UPDATE point_balances SET name=?, balance=?, updated_at=? WHERE player_id=?",
        (safe_name, new_balance, t, player_id)
    )
    conn.execute(
        "INSERT INTO point_ledger (player_id, name, delta, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (player_id, safe_name, amount, reason or "adjustment", created_by, t)
    )
    return new_balance


def today_key():
    return time.strftime("%Y-%m-%d", time.gmtime(now_ts()))


@app.get("/")
def root():
    return jsonify({"ok": True, "app": APP_NAME, "mode": "true-rolling-jackpot"})


@app.get("/api/health")
def health():
    with db() as conn:
        return jsonify({
            "ok": True,
            "app": APP_NAME,
            "time": now_ts(),
            "admin": ADMIN_PLAYER_ID,
            "users_columns": sorted(list(cols(conn, "users"))),
            "sessions_columns": sorted(list(cols(conn, "sessions"))),
            "entries_columns": sorted(list(cols(conn, "entries"))),
            "giveaways_columns": sorted(list(cols(conn, "giveaways"))),
        })


@app.post("/api/login")
def api_login():
    data = request.get_json(force=True, silent=True) or {}
    key = (data.get("api_key") or "").strip()
    if not key:
        return jsonify({"ok": False, "error": "API key required"}), 400

    try:
        r = requests.get(f"{TORN_API_BASE}/user/?selections=profile&key={key}", timeout=REQUEST_TIMEOUT)
        prof = r.json()
    except Exception as exc:
        return jsonify({"ok": False, "error": f"Could not reach Torn API: {exc}"}), 502

    if prof.get("error"):
        return jsonify({"ok": False, "error": prof["error"].get("error", "Torn API error")}), 400

    pid = int(prof.get("player_id") or prof.get("id") or 0)
    name = prof.get("name") or f"Player {pid}"
    if not pid:
        return jsonify({"ok": False, "error": "Could not read player id from Torn API"}), 400

    is_admin = 1 if pid == ADMIN_PLAYER_ID else 0
    token = secrets.token_urlsafe(32)
    t = now_ts()

    with db() as conn:
        ensure_users(conn)
        ensure_sessions(conn)
        conn.execute("""
            INSERT INTO users (player_id, name, api_key, is_admin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(player_id) DO UPDATE SET
                name=excluded.name,
                api_key=excluded.api_key,
                is_admin=excluded.is_admin,
                updated_at=excluded.updated_at
        """, (pid, name, key, is_admin, t, t))
        conn.execute("INSERT INTO sessions (token, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                     (token, pid, t + 60 * 60 * 24 * 30, t))

    return jsonify({"ok": True, "token": token, "user": {"player_id": pid, "name": name, "is_admin": bool(is_admin)}})


@app.get("/api/state")
def state():
    s = session()
    private = bool(s and int(s["player_id"]) == ADMIN_PLAYER_ID)

    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()
        if not g:
            init_db()
            g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()

        user_entry = None
        user = None
        if s:
            erow = conn.execute(
                "SELECT id, status, points_spent, created_at, reviewed_at FROM entries WHERE giveaway_id=? AND player_id=?",
                (g["id"], s["player_id"])
            ).fetchone()
            if erow:
                user_entry = dict(erow)
            user = {"player_id": s["player_id"], "name": s["name"], "is_admin": private}

        payload = clean_giveaway(conn, g, private)
        payload["entered"] = bool(user_entry)
        payload["entry_status"] = user_entry["status"] if user_entry else None
        payload["user_entry"] = user_entry

    return jsonify({"ok": True, "giveaway": payload, "user": user})


@app.post("/api/enter")
@login_required
def enter(s):
    data = request.get_json(force=True, silent=True) or {}
    draw_id = int(data.get("draw_id") or 0)
    points_spent = int(data.get("points_spent") or 0)

    if points_spent <= 0:
        return jsonify({"ok": False, "error": "Enter at least 1 point"}), 400

    with db() as conn:
        ensure_points(conn)
        bal = get_point_balance(conn, int(s["player_id"]), s["name"])
        if int(bal["balance"] or 0) < points_spent:
            return jsonify({"ok": False, "error": "Not enough points"}), 400

        if draw_id:
            g = conn.execute("SELECT * FROM giveaways WHERE id=? AND deleted_at IS NULL", (draw_id,)).fetchone()
        else:
            g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()

        if not g or g["status"] != "open":
            return jsonify({"ok": False, "error": "Draw is not open"}), 400

        try:
            conn.execute("""
                INSERT INTO entries (giveaway_id, player_id, name, status, points_spent, created_at)
                VALUES (?, ?, ?, 'pending', ?, ?)
            """, (g["id"], s["player_id"], s["name"], points_spent, now_ts()))
        except sqlite3.IntegrityError:
            return jsonify({"ok": True, "message": "You already have an entry request for this draw"})

    return jsonify({"ok": True, "message": "Entry request submitted for admin approval"})

@app.get("/api/admin/entries")
@admin_required
def admin_entries(s):
    draw_id = int(request.args.get("draw_id") or 0)
    with db() as conn:
        if draw_id:
            g = conn.execute("SELECT * FROM giveaways WHERE id=? AND deleted_at IS NULL", (draw_id,)).fetchone()
        else:
            g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()

        if not g:
            return jsonify({"ok": True, "entries": []})

        rows = conn.execute("""
            SELECT id, player_id, name, status, points_spent, created_at, reviewed_by, reviewed_at
            FROM entries
            WHERE giveaway_id=?
            ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                created_at ASC
        """, (g["id"],)).fetchall()

    return jsonify({"ok": True, "draw_id": g["id"], "entries": [dict(r) for r in rows]})

@app.post("/api/admin/entry-status")
@admin_required
def admin_entry_status(s):
    data = request.get_json(force=True, silent=True) or {}
    entry_id = int(data.get("entry_id") or 0)
    new_status = (data.get("status") or "").strip().lower()

    if new_status not in ("pending", "approved", "rejected"):
        return jsonify({"ok": False, "error": "Invalid entry status"}), 400
    if not entry_id:
        return jsonify({"ok": False, "error": "Missing entry id"}), 400

    with db() as conn:
        ensure_points(conn)
        row = conn.execute(
            "SELECT id, player_id, name, status, points_spent FROM entries WHERE id=?",
            (entry_id,)
        ).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Entry not found"}), 404

        old_status = row["status"]
        points_spent = int(row["points_spent"] or 1)

        try:
            # Deduct points only when moving into approved.
            if old_status != "approved" and new_status == "approved":
                add_points(conn, int(row["player_id"]), row["name"], -points_spent, "draw entry approved", int(s["player_id"]))

            # Refund points when moving out of approved.
            if old_status == "approved" and new_status != "approved":
                add_points(conn, int(row["player_id"]), row["name"], points_spent, "draw entry unapproved/refunded", int(s["player_id"]))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

        conn.execute("""
            UPDATE entries
            SET status=?, reviewed_by=?, reviewed_at=?
            WHERE id=?
        """, (new_status, s["player_id"], now_ts(), entry_id))

    return jsonify({"ok": True})

@app.post("/api/admin/giveaway")
@admin_required
def admin_save(s):
    data = request.get_json(force=True, silent=True) or {}
    t = now_ts()
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()
        conn.execute("""
            UPDATE giveaways
            SET title=?, prize_label=?, base_payout=?, entry_item_name=?, entry_item_value=?,
                rollover_pool=?, draw_at=?, updated_at=?
            WHERE id=?
        """, (
            (data.get("title") or "Fries91's Giveaway").strip(),
            (data.get("prize_label") or "Faction/Event Prize").strip(),
            int(data.get("base_payout") or 0),
            (data.get("entry_item_name") or "Xanax").strip(),
            int(data.get("entry_item_value") or 0),
            int(data.get("rollover_pool") or 0),
            int(data["draw_at"]) if str(data.get("draw_at") or "").isdigit() else None,
            t,
            g["id"],
        ))
    return jsonify({"ok": True})


@app.post("/api/admin/draw")
@admin_required
def admin_draw(s):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()
        rows = conn.execute("""
            SELECT player_id, name, points_spent
            FROM entries
            WHERE giveaway_id=? AND status='approved'
        """, (g["id"],)).fetchall()
        if not rows:
            return jsonify({"ok": False, "error": "No approved entries to draw"}), 400

        pool = []
        for row in rows:
            weight = max(1, int(row["points_spent"] or 1))
            for _ in range(weight):
                pool.append(row)

        winner = secrets.choice(pool)
        conn.execute("UPDATE giveaways SET status='drawn', winner_player_id=?, winner_name=?, updated_at=? WHERE id=?",
                     (winner["player_id"], winner["name"], now_ts(), g["id"]))
    return jsonify({"ok": True, "winner": {"player_id": winner["player_id"], "name": winner["name"]}})

@app.post("/api/admin/roll")
@admin_required
def admin_roll(s):
    # True rolling jackpot:
    # the next giveaway starting jackpot is ONLY the previous giveaway's 20% rollover.
    data = request.get_json(force=True, silent=True) or {}
    t = now_ts()

    with db() as conn:
        current = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()
        current_payload = clean_giveaway(conn, current, True)
        next_base_payout = int(current_payload.get("rollover_cut") or 0)

        conn.execute("""
            INSERT INTO giveaways
            (title, prize_label, total_pool, base_payout, entry_item_name, entry_item_value,
             player_percent, rollover_percent, reserve_percent, rollover_pool, status, draw_at,
             created_by, created_at, updated_at)
            VALUES (?, ?, 0, ?, ?, ?, 60, 20, 20, 0, 'open', NULL, ?, ?, ?)
        """, (
            (data.get("title") or current["title"] or "Fries91's Giveaway").strip(),
            (data.get("prize_label") or current["prize_label"] or "Faction/Event Prize").strip(),
            next_base_payout,
            (data.get("entry_item_name") or current["entry_item_name"] or "Xanax").strip(),
            int(data.get("entry_item_value") or current["entry_item_value"] or 0),
            s["player_id"],
            t,
            t,
        ))

    return jsonify({"ok": True, "next_base_payout": next_base_payout})

@app.post("/api/admin/status")
@admin_required
def admin_status(s):
    data = request.get_json(force=True, silent=True) or {}
    status = (data.get("status") or "open").strip().lower()
    if status not in ("open", "closed", "drawn"):
        return jsonify({"ok": False, "error": "Invalid status"}), 400
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways WHERE deleted_at IS NULL AND draw_type='rolling' ORDER BY id DESC LIMIT 1").fetchone()
        conn.execute("UPDATE giveaways SET status=?, updated_at=? WHERE id=?", (status, now_ts(), g["id"]))
    return jsonify({"ok": True})


@app.get("/api/points")
@login_required
def api_points(s):
    with db() as conn:
        bal = get_point_balance(conn, int(s["player_id"]), s["name"])
        ledger = conn.execute("""
            SELECT delta, reason, created_at
            FROM point_ledger
            WHERE player_id=?
            ORDER BY id DESC
            LIMIT 20
        """, (s["player_id"],)).fetchall()

        claimed_today = bool(conn.execute(
            "SELECT id FROM point_claims WHERE player_id=? AND claim_date=?",
            (s["player_id"], today_key())
        ).fetchone())

    return jsonify({
        "ok": True,
        "points": bal,
        "claimed_today": claimed_today,
        "daily_claim_amount": 1,
        "ledger": [dict(r) for r in ledger]
    })


@app.post("/api/points/claim-daily")
@login_required
def api_claim_daily(s):
    with db() as conn:
        ensure_points(conn)
        day = today_key()
        if conn.execute(
            "SELECT id FROM point_claims WHERE player_id=? AND claim_date=?",
            (s["player_id"], day)
        ).fetchone():
            return jsonify({"ok": False, "error": "Daily points already claimed"}), 400

        conn.execute(
            "INSERT INTO point_claims (player_id, claim_date, amount, created_at) VALUES (?, ?, ?, ?)",
            (s["player_id"], day, 1, now_ts())
        )
        new_balance = add_points(conn, int(s["player_id"]), s["name"], 1, "daily free claim", None)

    return jsonify({"ok": True, "balance": new_balance})


@app.get("/api/admin/points")
@admin_required
def admin_points_list(s):
    with db() as conn:
        ensure_points(conn)
        rows = conn.execute("""
            SELECT player_id, name, balance, updated_at
            FROM point_balances
            ORDER BY balance DESC, updated_at DESC
            LIMIT 100
        """).fetchall()
    return jsonify({"ok": True, "balances": [dict(r) for r in rows]})


@app.post("/api/admin/points")
@admin_required
def admin_points_adjust(s):
    data = request.get_json(force=True, silent=True) or {}
    player_id = int(data.get("player_id") or 0)
    name = (data.get("name") or f"Player {player_id}").strip()
    amount = int(data.get("amount") or 0)
    reason = (data.get("reason") or "admin adjustment").strip()

    if not player_id:
        return jsonify({"ok": False, "error": "Missing player id"}), 400
    if amount == 0:
        return jsonify({"ok": False, "error": "Amount cannot be 0"}), 400

    try:
        with db() as conn:
            new_balance = add_points(conn, player_id, name, amount, reason, int(s["player_id"]))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    return jsonify({"ok": True, "player_id": player_id, "balance": new_balance})


@app.get("/api/draws")
def api_draws():
    s = session()
    private = bool(s and int(s["player_id"]) == ADMIN_PLAYER_ID)

    with db() as conn:
        ensure_giveaways(conn)
        ensure_entries(conn)
        rows = conn.execute("""
            SELECT *
            FROM giveaways
            WHERE deleted_at IS NULL
            ORDER BY id DESC
        """).fetchall()

        draws = [clean_giveaway(conn, r, private) for r in rows]

    return jsonify({"ok": True, "draws": draws})


@app.post("/api/admin/draws")
@admin_required
def admin_create_draw(s):
    data = request.get_json(force=True, silent=True) or {}
    t = now_ts()
    draw_type = (data.get("draw_type") or "event").strip().lower()
    if draw_type not in ("rolling", "event"):
        draw_type = "event"

    with db() as conn:
        ensure_giveaways(conn)
        conn.execute("""
            INSERT INTO giveaways
            (title, prize_label, total_pool, base_payout, entry_item_name, entry_item_value,
             player_percent, rollover_percent, reserve_percent, rollover_pool, status, draw_at,
             created_by, created_at, updated_at, draw_type)
            VALUES (?, ?, 0, ?, ?, ?, 60, 20, 20, ?, ?, ?, ?, ?, ?, ?)
        """, (
            (data.get("title") or "Other Event Draw").strip(),
            (data.get("prize_label") or "Event Prize").strip(),
            int(data.get("base_payout") or 0),
            (data.get("entry_item_name") or "Free Points/Event").strip(),
            int(data.get("entry_item_value") or 0),
            int(data.get("rollover_pool") or 0),
            (data.get("status") or "open").strip().lower(),
            int(data["draw_at"]) if str(data.get("draw_at") or "").isdigit() else None,
            int(s["player_id"]),
            t,
            t,
            draw_type,
        ))
        new_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]

    return jsonify({"ok": True, "draw_id": int(new_id)})

@app.post("/api/admin/draws/delete")
@admin_required
def admin_delete_draw(s):
    data = request.get_json(force=True, silent=True) or {}
    draw_id = int(data.get("draw_id") or 0)

    if not draw_id:
        return jsonify({"ok": False, "error": "Missing draw id"}), 400

    with db() as conn:
        ensure_giveaways(conn)
        row = conn.execute(
            "SELECT id FROM giveaways WHERE id=? AND deleted_at IS NULL",
            (draw_id,)
        ).fetchone()

        if not row:
            return jsonify({"ok": False, "error": "Draw not found"}), 404

        conn.execute(
            "UPDATE giveaways SET status='deleted', deleted_at=?, updated_at=? WHERE id=?",
            (now_ts(), now_ts(), draw_id)
        )

    return jsonify({"ok": True})


@app.post("/api/admin/draws/status")
@admin_required
def admin_draw_status(s):
    data = request.get_json(force=True, silent=True) or {}
    draw_id = int(data.get("draw_id") or 0)
    status = (data.get("status") or "open").strip().lower()

    if not draw_id:
        return jsonify({"ok": False, "error": "Missing draw id"}), 400
    if status not in ("open", "closed", "drawn"):
        return jsonify({"ok": False, "error": "Invalid status"}), 400

    with db() as conn:
        ensure_giveaways(conn)
        conn.execute(
            "UPDATE giveaways SET status=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
            (status, now_ts(), draw_id)
        )

    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
