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


def table_columns(conn, table_name):
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"] for row in rows}


def add_column_if_missing(conn, table_name, column_name, column_sql):
    cols = table_columns(conn, table_name)
    if column_name not in cols:
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")


def init_db():
    with db() as conn:
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

        conn.execute("""
            CREATE TABLE IF NOT EXISTS giveaways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                prize_label TEXT NOT NULL DEFAULT 'Prize',
                total_pool INTEGER NOT NULL DEFAULT 0,
                player_percent INTEGER NOT NULL DEFAULT 60,
                rollover_percent INTEGER NOT NULL DEFAULT 20,
                reserve_percent INTEGER NOT NULL DEFAULT 20,
                rollover_pool INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'open',
                draw_at INTEGER,
                winner_player_id INTEGER,
                winner_name TEXT,
                created_by INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)

        # Safe migrations for old databases already on Render.
        add_column_if_missing(conn, "giveaways", "title", "title TEXT NOT NULL DEFAULT 'Fries91''s Giveaway'")
        add_column_if_missing(conn, "giveaways", "prize_label", "prize_label TEXT NOT NULL DEFAULT 'Prize'")
        add_column_if_missing(conn, "giveaways", "total_pool", "total_pool INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(conn, "giveaways", "player_percent", "player_percent INTEGER NOT NULL DEFAULT 60")
        add_column_if_missing(conn, "giveaways", "rollover_percent", "rollover_percent INTEGER NOT NULL DEFAULT 20")
        add_column_if_missing(conn, "giveaways", "reserve_percent", "reserve_percent INTEGER NOT NULL DEFAULT 20")
        add_column_if_missing(conn, "giveaways", "rollover_pool", "rollover_pool INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(conn, "giveaways", "status", "status TEXT NOT NULL DEFAULT 'open'")
        add_column_if_missing(conn, "giveaways", "draw_at", "draw_at INTEGER")
        add_column_if_missing(conn, "giveaways", "winner_player_id", "winner_player_id INTEGER")
        add_column_if_missing(conn, "giveaways", "winner_name", "winner_name TEXT")
        add_column_if_missing(conn, "giveaways", "created_by", "created_by INTEGER")
        add_column_if_missing(conn, "giveaways", "created_at", "created_at INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(conn, "giveaways", "updated_at", "updated_at INTEGER NOT NULL DEFAULT 0")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(giveaway_id, player_id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                player_id INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            )
        """)

        t = now_ts()

        # Clean up any old rows with zero timestamps.
        conn.execute("UPDATE giveaways SET created_at=? WHERE created_at IS NULL OR created_at=0", (t,))
        conn.execute("UPDATE giveaways SET updated_at=? WHERE updated_at IS NULL OR updated_at=0", (t,))

        cur = conn.execute("SELECT id FROM giveaways ORDER BY id DESC LIMIT 1")
        if not cur.fetchone():
            conn.execute("""
                INSERT INTO giveaways
                (title, prize_label, total_pool, player_percent, rollover_percent, reserve_percent,
                 rollover_pool, status, draw_at, created_by, created_at, updated_at)
                VALUES (?, ?, ?, 60, 20, 20, ?, 'open', NULL, ?, ?, ?)
            """, ("Fries91's Giveaway", "Faction/Event Prize", 0, 0, ADMIN_PLAYER_ID, t, t))


init_db()


@app.errorhandler(Exception)
def handle_exception(exc):
    # Keeps the overlay from getting plain HTML 500 pages.
    app.logger.exception("Unhandled server error")
    return jsonify({
        "ok": False,
        "error": "Server error. Check Render logs.",
        "detail": str(exc)
    }), 500


def clean_giveaway(row, include_private=False):
    total = int(row["total_pool"] or 0)
    player_percent = int(row["player_percent"] or 60)
    rollover_percent = int(row["rollover_percent"] or 20)
    reserve_percent = int(row["reserve_percent"] or 20)

    player_cut = total * player_percent // 100
    rollover_cut = total * rollover_percent // 100
    reserve_cut = total * reserve_percent // 100

    payload = {
        "id": row["id"],
        "title": row["title"] or "Fries91's Giveaway",
        "prize_label": row["prize_label"] or "Prize",
        "total_pool": total,
        "player_percent": player_percent,
        "rollover_percent": rollover_percent,
        "status": row["status"] or "open",
        "draw_at": row["draw_at"],
        "winner_player_id": row["winner_player_id"],
        "winner_name": row["winner_name"],
        "rollover_pool": int(row["rollover_pool"] or 0),
        "player_cut": player_cut,
        "rollover_cut": rollover_cut,
        "entry_is_free": True,
    }
    if include_private:
        payload["reserve_percent"] = reserve_percent
        payload["reserve_cut"] = reserve_cut
        payload["admin_player_id"] = ADMIN_PLAYER_ID
    return payload


def get_session():
    token = request.headers.get("X-Giveaway-Session", "").strip()
    if not token:
        return None
    with db() as conn:
        row = conn.execute("""
            SELECT s.token, s.player_id, s.expires_at, u.name, u.is_admin
            FROM sessions s
            JOIN users u ON u.player_id = s.player_id
            WHERE s.token = ?
        """, (token,)).fetchone()
        if not row or int(row["expires_at"]) < now_ts():
            return None
        return dict(row)


def require_login(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = get_session()
        if not session:
            return jsonify({"ok": False, "error": "Login required"}), 401
        return fn(session, *args, **kwargs)
    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = get_session()
        if not session:
            return jsonify({"ok": False, "error": "Login required"}), 401
        if int(session["player_id"]) != ADMIN_PLAYER_ID:
            return jsonify({"ok": False, "error": "Admin only"}), 403
        return fn(session, *args, **kwargs)
    return wrapper


@app.get("/")
def root():
    return jsonify({"ok": True, "app": APP_NAME, "mode": "free-entry-giveaway"})


@app.get("/api/health")
def health():
    with db() as conn:
        g_count = conn.execute("SELECT COUNT(*) AS c FROM giveaways").fetchone()["c"]
    return jsonify({"ok": True, "app": APP_NAME, "time": now_ts(), "giveaways": int(g_count)})


@app.post("/api/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    api_key = (data.get("api_key") or "").strip()
    if not api_key:
        return jsonify({"ok": False, "error": "API key required"}), 400

    url = f"{TORN_API_BASE}/user/?selections=profile&key={api_key}"
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT)
        profile = r.json()
    except Exception as exc:
        return jsonify({"ok": False, "error": f"Could not reach Torn API: {exc}"}), 502

    if profile.get("error"):
        return jsonify({"ok": False, "error": profile["error"].get("error", "Torn API error")}), 400

    player_id = int(profile.get("player_id") or profile.get("id") or 0)
    name = profile.get("name") or f"Player {player_id}"
    if not player_id:
        return jsonify({"ok": False, "error": "Could not read player id from Torn API"}), 400

    is_admin = 1 if player_id == ADMIN_PLAYER_ID else 0
    token = secrets.token_urlsafe(32)
    t = now_ts()
    expires = t + (60 * 60 * 24 * 30)

    with db() as conn:
        conn.execute("""
            INSERT INTO users (player_id, name, api_key, is_admin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(player_id) DO UPDATE SET
                name=excluded.name,
                api_key=excluded.api_key,
                is_admin=excluded.is_admin,
                updated_at=excluded.updated_at
        """, (player_id, name, api_key, is_admin, t, t))
        conn.execute(
            "INSERT INTO sessions (token, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (token, player_id, expires, t)
        )

    return jsonify({"ok": True, "token": token, "user": {"player_id": player_id, "name": name, "is_admin": bool(is_admin)}})


@app.get("/api/state")
def state():
    session = get_session()
    include_private = bool(session and int(session["player_id"]) == ADMIN_PLAYER_ID)

    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        if not g:
            t = now_ts()
            conn.execute("""
                INSERT INTO giveaways
                (title, prize_label, total_pool, player_percent, rollover_percent, reserve_percent,
                 rollover_pool, status, draw_at, created_by, created_at, updated_at)
                VALUES (?, ?, ?, 60, 20, 20, ?, 'open', NULL, ?, ?, ?)
            """, ("Fries91's Giveaway", "Faction/Event Prize", 0, 0, ADMIN_PLAYER_ID, t, t))
            g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()

        count = conn.execute("SELECT COUNT(*) AS c FROM entries WHERE giveaway_id = ?", (g["id"],)).fetchone()["c"]
        entered = False
        if session:
            entered = bool(conn.execute(
                "SELECT id FROM entries WHERE giveaway_id = ? AND player_id = ?",
                (g["id"], session["player_id"])
            ).fetchone())

    payload = clean_giveaway(g, include_private=include_private)
    payload["entry_count"] = int(count)
    payload["entered"] = entered
    payload["is_admin"] = include_private
    return jsonify({"ok": True, "giveaway": payload})


@app.post("/api/enter")
@require_login
def enter(session):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        if not g or g["status"] != "open":
            return jsonify({"ok": False, "error": "Giveaway is not open"}), 400
        try:
            conn.execute("""
                INSERT INTO entries (giveaway_id, player_id, name, created_at)
                VALUES (?, ?, ?, ?)
            """, (g["id"], session["player_id"], session["name"], now_ts()))
        except sqlite3.IntegrityError:
            return jsonify({"ok": True, "message": "You are already entered"})
    return jsonify({"ok": True, "message": "Entry saved"})


@app.get("/api/admin/entries")
@require_admin
def admin_entries(session):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        rows = conn.execute("""
            SELECT player_id, name, created_at
            FROM entries
            WHERE giveaway_id = ?
            ORDER BY created_at ASC
        """, (g["id"],)).fetchall()
    return jsonify({"ok": True, "entries": [dict(r) for r in rows]})


@app.post("/api/admin/giveaway")
@require_admin
def admin_update_giveaway(session):
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "Fries91's Giveaway").strip()
    prize_label = (data.get("prize_label") or "Faction/Event Prize").strip()
    total_pool = int(data.get("total_pool") or 0)
    rollover_pool = int(data.get("rollover_pool") or 0)
    draw_at = data.get("draw_at")
    draw_ts = int(draw_at) if str(draw_at or "").isdigit() else None
    t = now_ts()

    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        conn.execute("""
            UPDATE giveaways
            SET title=?, prize_label=?, total_pool=?, rollover_pool=?, draw_at=?, updated_at=?
            WHERE id=?
        """, (title, prize_label, total_pool, rollover_pool, draw_ts, t, g["id"]))
    return jsonify({"ok": True})


@app.post("/api/admin/draw")
@require_admin
def admin_draw(session):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        entries = conn.execute("SELECT player_id, name FROM entries WHERE giveaway_id = ?", (g["id"],)).fetchall()
        if not entries:
            return jsonify({"ok": False, "error": "No entries to draw"}), 400

        winner = secrets.choice(entries)
        t = now_ts()
        conn.execute("""
            UPDATE giveaways
            SET status='drawn', winner_player_id=?, winner_name=?, updated_at=?
            WHERE id=?
        """, (winner["player_id"], winner["name"], t, g["id"]))

    return jsonify({"ok": True, "winner": {"player_id": winner["player_id"], "name": winner["name"]}})


@app.post("/api/admin/roll")
@require_admin
def admin_roll(session):
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "Fries91's Giveaway").strip()
    prize_label = (data.get("prize_label") or "Faction/Event Prize").strip()
    total_pool = int(data.get("total_pool") or 0)
    rollover_pool = int(data.get("rollover_pool") or 0)
    t = now_ts()

    with db() as conn:
        conn.execute("""
            INSERT INTO giveaways
            (title, prize_label, total_pool, player_percent, rollover_percent, reserve_percent,
             rollover_pool, status, draw_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, 60, 20, 20, ?, 'open', NULL, ?, ?, ?)
        """, (title, prize_label, total_pool, rollover_pool, session["player_id"], t, t))

    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
