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
            updated_at INTEGER NOT NULL DEFAULT 0
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
                created_at INTEGER NOT NULL,
                UNIQUE(giveaway_id, player_id)
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


def get_entry_count(conn, giveaway_id):
    return int(conn.execute(
        "SELECT COUNT(*) AS c FROM entries WHERE giveaway_id=?",
        (giveaway_id,)
    ).fetchone()["c"])


def clean_giveaway(conn, g, private=False):
    entry_count = get_entry_count(conn, g["id"])
    base_payout = int(g["base_payout"] or 0)
    entry_item_value = int(g["entry_item_value"] or 0)
    computed_pool = base_payout + (entry_count * entry_item_value)

    pp = int(g["player_percent"] or 60)
    rp = int(g["rollover_percent"] or 20)
    ap = int(g["reserve_percent"] or 20)

    out = {
        "id": g["id"],
        "title": g["title"] or "Fries91's Giveaway",
        "prize_label": g["prize_label"] or "Prize",
        "base_payout": base_payout,
        "entry_item_name": g["entry_item_name"] or "Xanax",
        "entry_item_value": entry_item_value,
        "entry_count": entry_count,
        "entry_growth_total": entry_count * entry_item_value,
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
        "entry_is_free": True,
    }
    if private:
        out["reserve_percent"] = ap
        out["reserve_cut"] = computed_pool * ap // 100
        out["admin_player_id"] = ADMIN_PLAYER_ID
    return out


@app.get("/")
def root():
    return jsonify({"ok": True, "app": APP_NAME, "mode": "free-entry-giveaway"})


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
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        if not g:
            init_db()
            g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()

        entered = False
        user = None
        if s:
            entered = bool(conn.execute("SELECT id FROM entries WHERE giveaway_id=? AND player_id=?",
                                        (g["id"], s["player_id"])).fetchone())
            user = {"player_id": s["player_id"], "name": s["name"], "is_admin": private}

        payload = clean_giveaway(conn, g, private)
        payload["entered"] = entered
        payload["is_admin"] = private

    return jsonify({"ok": True, "giveaway": payload, "user": user})


@app.post("/api/enter")
@login_required
def enter(s):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        if not g or g["status"] != "open":
            return jsonify({"ok": False, "error": "Giveaway is not open"}), 400
        try:
            conn.execute("INSERT INTO entries (giveaway_id, player_id, name, created_at) VALUES (?, ?, ?, ?)",
                         (g["id"], s["player_id"], s["name"], now_ts()))
        except sqlite3.IntegrityError:
            return jsonify({"ok": True, "message": "You are already entered"})
    return jsonify({"ok": True, "message": "Entry saved"})


@app.get("/api/admin/entries")
@admin_required
def admin_entries(s):
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        rows = conn.execute("SELECT player_id, name, created_at FROM entries WHERE giveaway_id=? ORDER BY created_at ASC",
                            (g["id"],)).fetchall()
    return jsonify({"ok": True, "entries": [dict(r) for r in rows]})


@app.post("/api/admin/giveaway")
@admin_required
def admin_save(s):
    data = request.get_json(force=True, silent=True) or {}
    t = now_ts()
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
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
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        rows = conn.execute("SELECT player_id, name FROM entries WHERE giveaway_id=?", (g["id"],)).fetchall()
        if not rows:
            return jsonify({"ok": False, "error": "No entries to draw"}), 400
        winner = secrets.choice(rows)
        conn.execute("UPDATE giveaways SET status='drawn', winner_player_id=?, winner_name=?, updated_at=? WHERE id=?",
                     (winner["player_id"], winner["name"], now_ts(), g["id"]))
    return jsonify({"ok": True, "winner": {"player_id": winner["player_id"], "name": winner["name"]}})


@app.post("/api/admin/roll")
@admin_required
def admin_roll(s):
    data = request.get_json(force=True, silent=True) or {}
    t = now_ts()
    with db() as conn:
        conn.execute("""
            INSERT INTO giveaways
            (title, prize_label, total_pool, base_payout, entry_item_name, entry_item_value,
             player_percent, rollover_percent, reserve_percent, rollover_pool, status, draw_at,
             created_by, created_at, updated_at)
            VALUES (?, ?, 0, ?, ?, ?, 60, 20, 20, ?, 'open', NULL, ?, ?, ?)
        """, (
            (data.get("title") or "Fries91's Giveaway").strip(),
            (data.get("prize_label") or "Faction/Event Prize").strip(),
            int(data.get("base_payout") or 0),
            (data.get("entry_item_name") or "Xanax").strip(),
            int(data.get("entry_item_value") or 0),
            int(data.get("rollover_pool") or 0),
            s["player_id"],
            t,
            t,
        ))
    return jsonify({"ok": True})


@app.post("/api/admin/status")
@admin_required
def admin_status(s):
    data = request.get_json(force=True, silent=True) or {}
    status = (data.get("status") or "open").strip().lower()
    if status not in ("open", "closed", "drawn"):
        return jsonify({"ok": False, "error": "Invalid status"}), 400
    with db() as conn:
        g = conn.execute("SELECT * FROM giveaways ORDER BY id DESC LIMIT 1").fetchone()
        conn.execute("UPDATE giveaways SET status=?, updated_at=? WHERE id=?", (status, now_ts(), g["id"]))
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
