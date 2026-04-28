import os
import random
import sqlite3
import threading
import time
from contextlib import contextmanager

DB_PATH = os.environ.get('GIVEAWAY_DB_PATH', 'giveaway.db')
_lock = threading.RLock()


def now_ts() -> int:
    return int(time.time())


def connect() -> sqlite3.Connection:
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


_CONN = connect()


@contextmanager
def tx():
    with _lock:
        cur = _CONN.cursor()
        try:
            yield cur
            _CONN.commit()
        except Exception:
            _CONN.rollback()
            raise
        finally:
            cur.close()


def init_db() -> None:
    with tx() as cur:
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                user_name TEXT NOT NULL,
                api_key_masked TEXT DEFAULT '',
                role TEXT NOT NULL DEFAULT 'user',
                created_ts INTEGER NOT NULL,
                last_seen_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                created_ts INTEGER NOT NULL,
                expires_ts INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                entry_requirement TEXT NOT NULL DEFAULT '1 free entry',
                reward TEXT NOT NULL DEFAULT '',
                rules TEXT NOT NULL DEFAULT '',
                start_ts INTEGER NOT NULL DEFAULT 0,
                end_ts INTEGER NOT NULL DEFAULT 0,
                max_entries_per_user INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                winner_user_id INTEGER,
                winner_name TEXT,
                drawn_ts INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER,
                created_by_name TEXT,
                created_ts INTEGER NOT NULL,
                updated_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS giveaway_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                entered_ts INTEGER NOT NULL,
                UNIQUE(giveaway_id, user_id, entered_ts),
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaway_winners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER,
                user_name TEXT NOT NULL,
                reward TEXT NOT NULL DEFAULT '',
                drawn_ts INTEGER NOT NULL,
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway_id ON giveaway_entries(giveaway_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_user_id ON giveaway_entries(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_winners_giveaway_id ON giveaway_winners(giveaway_id);
            """
        )
        cur.execute('PRAGMA table_info(giveaways)')
        giveaway_cols = {row['name'] for row in cur.fetchall()}
        if 'drawn_ts' not in giveaway_cols:
            cur.execute('ALTER TABLE giveaways ADD COLUMN drawn_ts INTEGER NOT NULL DEFAULT 0')


def mask_key(api_key: str) -> str:
    if not api_key:
        return ''
    if len(api_key) <= 6:
        return '*' * len(api_key)
    return f"{api_key[:3]}{'*' * max(0, len(api_key) - 6)}{api_key[-3:]}"


def upsert_user(user_id: int, user_name: str, role: str = 'user', api_key: str = '') -> None:
    ts = now_ts()
    masked = mask_key(api_key)
    with tx() as cur:
        cur.execute(
            """
            INSERT INTO users (user_id, user_name, api_key_masked, role, created_ts, last_seen_ts)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                user_name=excluded.user_name,
                api_key_masked=CASE WHEN excluded.api_key_masked='' THEN users.api_key_masked ELSE excluded.api_key_masked END,
                role=excluded.role,
                last_seen_ts=excluded.last_seen_ts
            """,
            (user_id, user_name, masked, role, ts, ts),
        )


def create_session(token: str, user_id: int, user_name: str, ttl_seconds: int) -> None:
    ts = now_ts()
    with tx() as cur:
        cur.execute(
            'INSERT INTO sessions (token, user_id, user_name, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)',
            (token, user_id, user_name, ts, ts + ttl_seconds),
        )


def get_session(token: str):
    if not token:
        return None
    with tx() as cur:
        cur.execute(
            'SELECT s.token, s.user_id, s.user_name, s.created_ts, s.expires_ts, u.role FROM sessions s LEFT JOIN users u ON u.user_id=s.user_id WHERE s.token=?',
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        if int(row['expires_ts']) < now_ts():
            cur.execute('DELETE FROM sessions WHERE token=?', (token,))
            return None
        return dict(row)


def delete_session(token: str) -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE token=?', (token,))


def cleanup_sessions() -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE expires_ts < ?', (now_ts(),))


def get_latest_giveaway(include_draft: bool = True):
    q = 'SELECT * FROM giveaways'
    if not include_draft:
        q += " WHERE status != 'draft'"
    q += ' ORDER BY id DESC LIMIT 1'
    with tx() as cur:
        cur.execute(q)
        row = cur.fetchone()
        return dict(row) if row else None


def get_giveaway(giveaway_id: int):
    with tx() as cur:
        cur.execute('SELECT * FROM giveaways WHERE id=?', (giveaway_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {'1', 'true', 'yes', 'y', 'on'}


def create_or_update_giveaway(payload: dict, actor: dict):
    ts = now_ts()
    giveaway_id = int(payload.get('id') or 0)
    new_round = truthy(payload.get('new_round'))
    clear_entries = truthy(payload.get('clear_entries'))

    # New round = new giveaway id, so entrants from the old round are not active anymore.
    if new_round:
        giveaway_id = 0

    title = str(payload.get('title') or '').strip()[:120]
    entry_requirement = str(payload.get('entry_requirement') or '1 free entry').strip()[:200]
    reward = str(payload.get('reward') or '').strip()[:200]
    rules = str(payload.get('rules') or '').strip()[:4000]
    start_ts = int(payload.get('start_ts') or 0)
    end_ts = int(payload.get('end_ts') or 0)
    max_entries = max(1, min(100, int(payload.get('max_entries_per_user') or 1)))
    status = str(payload.get('status') or 'draft').strip().lower()

    if not title:
        raise ValueError('Giveaway title is required')
    if not reward:
        raise ValueError('Reward is required')
    if start_ts and end_ts and end_ts <= start_ts:
        raise ValueError('End time must be after start time')
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        status = 'draft'

    with tx() as cur:
        if giveaway_id:
            cur.execute(
                """
                UPDATE giveaways
                SET title=?, entry_requirement=?, reward=?, rules=?, start_ts=?, end_ts=?,
                    max_entries_per_user=?, status=?,
                    winner_user_id=CASE WHEN ?='drawn' THEN winner_user_id ELSE NULL END,
                    winner_name=CASE WHEN ?='drawn' THEN winner_name ELSE NULL END,
                    drawn_ts=CASE WHEN ?='drawn' THEN drawn_ts ELSE 0 END,
                    updated_ts=?
                WHERE id=?
                """,
                (
                    title, entry_requirement, reward, rules, start_ts, end_ts,
                    max_entries, status, status, status, status, ts, giveaway_id,
                ),
            )
            if cur.rowcount == 0:
                raise ValueError('Giveaway not found')
            if clear_entries:
                cur.execute('DELETE FROM giveaway_entries WHERE giveaway_id=?', (giveaway_id,))
                cur.execute(
                    'UPDATE giveaways SET winner_user_id=NULL, winner_name=NULL, drawn_ts=0, updated_ts=? WHERE id=?',
                    (ts, giveaway_id),
                )
        else:
            if new_round:
                cur.execute(
                    "UPDATE giveaways SET status='closed', updated_ts=? WHERE status IN ('draft', 'open')",
                    (ts,),
                )
            cur.execute(
                """
                INSERT INTO giveaways (
                    title, entry_requirement, reward, rules,
                    start_ts, end_ts, max_entries_per_user, status,
                    winner_user_id, winner_name, drawn_ts,
                    created_by, created_by_name, created_ts, updated_ts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)
                """,
                (
                    title,
                    entry_requirement,
                    reward,
                    rules,
                    start_ts,
                    end_ts,
                    max_entries,
                    status,
                    actor['user_id'],
                    actor['user_name'],
                    ts,
                    ts,
                ),
            )
            giveaway_id = cur.lastrowid

    return get_giveaway(giveaway_id)

def set_giveaway_status(giveaway_id: int, status: str):
    status = status.lower().strip()
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        raise ValueError('invalid status')

    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')

    ts = now_ts()
    with tx() as cur:
        if status == 'drawn':
            cur.execute('UPDATE giveaways SET status=?, updated_ts=? WHERE id=?', (status, ts, giveaway_id))
        else:
            cur.execute(
                "UPDATE giveaways SET status=?, winner_user_id=NULL, winner_name=NULL, drawn_ts=0, updated_ts=? WHERE id=?",
                (status, ts, giveaway_id),
            )
    return get_giveaway(giveaway_id)


def count_entries_for_user(giveaway_id: int, user_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=? AND user_id=?',
            (giveaway_id, user_id),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_entries(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=?', (giveaway_id,))
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_distinct_entrants(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(DISTINCT user_id) AS c FROM giveaway_entries WHERE giveaway_id=?',
            (giveaway_id,),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def get_entrants(giveaway_id: int, limit: int = 1000):
    with tx() as cur:
        cur.execute(
            "SELECT user_id, user_name, MIN(entered_ts) AS first_entered_ts, COUNT(*) AS entries "
            "FROM giveaway_entries WHERE giveaway_id=? "
            "GROUP BY user_id, user_name "
            "ORDER BY first_entered_ts ASC, user_name ASC LIMIT ?",
            (giveaway_id, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def get_weighted_entries(giveaway_id: int):
    with tx() as cur:
        cur.execute(
            'SELECT user_id, user_name FROM giveaway_entries WHERE giveaway_id=? ORDER BY id ASC',
            (giveaway_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def add_entry(giveaway: dict, actor: dict):
    if not giveaway:
        raise ValueError('No active giveaway')

    now = now_ts()
    if giveaway['status'] != 'open':
        raise ValueError('Giveaway is not open')
    if giveaway['start_ts'] and now < int(giveaway['start_ts']):
        raise ValueError('Giveaway has not started yet')
    if giveaway['end_ts'] and now > int(giveaway['end_ts']):
        raise ValueError('Giveaway has already ended')

    current = count_entries_for_user(giveaway['id'], actor['user_id'])
    allowed = max(1, int(giveaway['max_entries_per_user'] or 1))
    if current >= allowed:
        raise ValueError('Entry limit reached for this giveaway')

    with tx() as cur:
        cur.execute(
            'INSERT INTO giveaway_entries (giveaway_id, user_id, user_name, entered_ts) VALUES (?, ?, ?, ?)',
            (giveaway['id'], actor['user_id'], actor['user_name'], now),
        )

    return count_entries_for_user(giveaway['id'], actor['user_id'])


def draw_winner(giveaway_id: int):
    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')
    if giveaway['status'] not in {'open', 'closed'}:
        raise ValueError('Giveaway must be open or closed before drawing')

    rows = get_weighted_entries(giveaway_id)
    if not rows:
        raise ValueError('No entries to draw from')

    winner = dict(random.choice(rows))
    ts = now_ts()

    with tx() as cur:
        cur.execute(
            "UPDATE giveaways SET status='drawn', winner_user_id=?, winner_name=?, drawn_ts=?, updated_ts=? WHERE id=?",
            (winner['user_id'], winner['user_name'], ts, ts, giveaway_id),
        )
        cur.execute(
            'INSERT INTO giveaway_winners (giveaway_id, user_id, user_name, reward, drawn_ts) VALUES (?, ?, ?, ?, ?)',
            (giveaway_id, winner['user_id'], winner['user_name'], giveaway.get('reward') or '', ts),
        )

    return get_giveaway(giveaway_id)


def get_winner_history(limit: int = 20):
    with tx() as cur:
        cur.execute(
            'SELECT gw.*, g.title FROM giveaway_winners gw LEFT JOIN giveaways g ON g.id=gw.giveaway_id ORDER BY gw.id DESC LIMIT ?',
            (limit,),
        )
        return [dict(r) for r in cur.fetchall()]        except Exception:
            _CONN.rollback()
            raise
        finally:
            cur.close()


def init_db() -> None:
    with tx() as cur:
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                user_name TEXT NOT NULL,
                api_key_masked TEXT DEFAULT '',
                role TEXT NOT NULL DEFAULT 'user',
                created_ts INTEGER NOT NULL,
                last_seen_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                created_ts INTEGER NOT NULL,
                expires_ts INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                entry_requirement TEXT NOT NULL DEFAULT '1 free entry',
                reward TEXT NOT NULL DEFAULT '',
                rules TEXT NOT NULL DEFAULT '',
                start_ts INTEGER NOT NULL DEFAULT 0,
                end_ts INTEGER NOT NULL DEFAULT 0,
                max_entries_per_user INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                winner_user_id INTEGER,
                winner_name TEXT,
                drawn_ts INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER,
                created_by_name TEXT,
                created_ts INTEGER NOT NULL,
                updated_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS giveaway_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                entered_ts INTEGER NOT NULL,
                UNIQUE(giveaway_id, user_id, entered_ts),
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaway_winners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER,
                user_name TEXT NOT NULL,
                reward TEXT NOT NULL DEFAULT '',
                drawn_ts INTEGER NOT NULL,
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway_id ON giveaway_entries(giveaway_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_user_id ON giveaway_entries(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_winners_giveaway_id ON giveaway_winners(giveaway_id);
            """
        )
        cur.execute('PRAGMA table_info(giveaways)')
        giveaway_cols = {row['name'] for row in cur.fetchall()}
        if 'drawn_ts' not in giveaway_cols:
            cur.execute('ALTER TABLE giveaways ADD COLUMN drawn_ts INTEGER NOT NULL DEFAULT 0')


def mask_key(api_key: str) -> str:
    if not api_key:
        return ''
    if len(api_key) <= 6:
        return '*' * len(api_key)
    return f"{api_key[:3]}{'*' * max(0, len(api_key) - 6)}{api_key[-3:]}"


def upsert_user(user_id: int, user_name: str, role: str = 'user', api_key: str = '') -> None:
    ts = now_ts()
    masked = mask_key(api_key)
    with tx() as cur:
        cur.execute(
            """
            INSERT INTO users (user_id, user_name, api_key_masked, role, created_ts, last_seen_ts)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                user_name=excluded.user_name,
                api_key_masked=CASE WHEN excluded.api_key_masked='' THEN users.api_key_masked ELSE excluded.api_key_masked END,
                role=excluded.role,
                last_seen_ts=excluded.last_seen_ts
            """,
            (user_id, user_name, masked, role, ts, ts),
        )


def create_session(token: str, user_id: int, user_name: str, ttl_seconds: int) -> None:
    ts = now_ts()
    with tx() as cur:
        cur.execute(
            'INSERT INTO sessions (token, user_id, user_name, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)',
            (token, user_id, user_name, ts, ts + ttl_seconds),
        )


def get_session(token: str):
    if not token:
        return None
    with tx() as cur:
        cur.execute(
            'SELECT s.token, s.user_id, s.user_name, s.created_ts, s.expires_ts, u.role FROM sessions s LEFT JOIN users u ON u.user_id=s.user_id WHERE s.token=?',
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        if int(row['expires_ts']) < now_ts():
            cur.execute('DELETE FROM sessions WHERE token=?', (token,))
            return None
        return dict(row)


def delete_session(token: str) -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE token=?', (token,))


def cleanup_sessions() -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE expires_ts < ?', (now_ts(),))


def get_latest_giveaway(include_draft: bool = True):
    q = 'SELECT * FROM giveaways'
    if not include_draft:
        q += " WHERE status != 'draft'"
    q += ' ORDER BY id DESC LIMIT 1'
    with tx() as cur:
        cur.execute(q)
        row = cur.fetchone()
        return dict(row) if row else None


def get_giveaway(giveaway_id: int):
    with tx() as cur:
        cur.execute('SELECT * FROM giveaways WHERE id=?', (giveaway_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {'1', 'true', 'yes', 'y', 'on'}


def create_or_update_giveaway(payload: dict, actor: dict):
    ts = now_ts()
    giveaway_id = int(payload.get('id') or 0)
    new_round = truthy(payload.get('new_round'))
    clear_entries = truthy(payload.get('clear_entries'))

    # New round = new giveaway id, so entrants from the old round are not active anymore.
    if new_round:
        giveaway_id = 0

    title = str(payload.get('title') or '').strip()[:120]
    entry_requirement = str(payload.get('entry_requirement') or '1 free entry').strip()[:200]
    reward = str(payload.get('reward') or '').strip()[:200]
    rules = str(payload.get('rules') or '').strip()[:4000]
    start_ts = int(payload.get('start_ts') or 0)
    end_ts = int(payload.get('end_ts') or 0)
    max_entries = max(1, min(100, int(payload.get('max_entries_per_user') or 1)))
    status = str(payload.get('status') or 'draft').strip().lower()

    if not title:
        raise ValueError('Giveaway title is required')
    if not reward:
        raise ValueError('Reward is required')
    if start_ts and end_ts and end_ts <= start_ts:
        raise ValueError('End time must be after start time')
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        status = 'draft'

    with tx() as cur:
        if giveaway_id:
            cur.execute(
                """
                UPDATE giveaways
                SET title=?, entry_requirement=?, reward=?, rules=?, start_ts=?, end_ts=?,
                    max_entries_per_user=?, status=?,
                    winner_user_id=CASE WHEN ?='drawn' THEN winner_user_id ELSE NULL END,
                    winner_name=CASE WHEN ?='drawn' THEN winner_name ELSE NULL END,
                    drawn_ts=CASE WHEN ?='drawn' THEN drawn_ts ELSE 0 END,
                    updated_ts=?
                WHERE id=?
                """,
                (
                    title, entry_requirement, reward, rules, start_ts, end_ts,
                    max_entries, status, status, status, status, ts, giveaway_id,
                ),
            )
            if cur.rowcount == 0:
                raise ValueError('Giveaway not found')
            if clear_entries:
                cur.execute('DELETE FROM giveaway_entries WHERE giveaway_id=?', (giveaway_id,))
                cur.execute(
                    'UPDATE giveaways SET winner_user_id=NULL, winner_name=NULL, drawn_ts=0, updated_ts=? WHERE id=?',
                    (ts, giveaway_id),
                )
        else:
            if new_round:
                cur.execute(
                    "UPDATE giveaways SET status='closed', updated_ts=? WHERE status IN ('draft', 'open')",
                    (ts,),
                )
            cur.execute(
                """
                INSERT INTO giveaways (
                    title, entry_requirement, reward, rules,
                    start_ts, end_ts, max_entries_per_user, status,
                    winner_user_id, winner_name, drawn_ts,
                    created_by, created_by_name, created_ts, updated_ts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)
                """,
                (
                    title,
                    entry_requirement,
                    reward,
                    rules,
                    start_ts,
                    end_ts,
                    max_entries,
                    status,
                    actor['user_id'],
                    actor['user_name'],
                    ts,
                    ts,
                ),
            )
            giveaway_id = cur.lastrowid

    return get_giveaway(giveaway_id)

def set_giveaway_status(giveaway_id: int, status: str):
    status = status.lower().strip()
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        raise ValueError('invalid status')

    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')

    ts = now_ts()
    with tx() as cur:
        if status == 'drawn':
            cur.execute('UPDATE giveaways SET status=?, updated_ts=? WHERE id=?', (status, ts, giveaway_id))
        else:
            cur.execute(
                "UPDATE giveaways SET status=?, winner_user_id=NULL, winner_name=NULL, drawn_ts=0, updated_ts=? WHERE id=?",
                (status, ts, giveaway_id),
            )
    return get_giveaway(giveaway_id)


def count_entries_for_user(giveaway_id: int, user_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=? AND user_id=?',
            (giveaway_id, user_id),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_entries(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=?', (giveaway_id,))
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_distinct_entrants(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(DISTINCT user_id) AS c FROM giveaway_entries WHERE giveaway_id=?',
            (giveaway_id,),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def get_entrants(giveaway_id: int, limit: int = 1000):
    with tx() as cur:
        cur.execute(
            "SELECT user_id, user_name, MIN(entered_ts) AS first_entered_ts, COUNT(*) AS entries "
            "FROM giveaway_entries WHERE giveaway_id=? "
            "GROUP BY user_id, user_name "
            "ORDER BY first_entered_ts ASC, user_name ASC LIMIT ?",
            (giveaway_id, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def get_weighted_entries(giveaway_id: int):
    with tx() as cur:
        cur.execute(
            'SELECT user_id, user_name FROM giveaway_entries WHERE giveaway_id=? ORDER BY id ASC',
            (giveaway_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def add_entry(giveaway: dict, actor: dict):
    if not giveaway:
        raise ValueError('No active giveaway')

    now = now_ts()
    if giveaway['status'] != 'open':
        raise ValueError('Giveaway is not open')
    if giveaway['start_ts'] and now < int(giveaway['start_ts']):
        raise ValueError('Giveaway has not started yet')
    if giveaway['end_ts'] and now > int(giveaway['end_ts']):
        raise ValueError('Giveaway has already ended')

    current = count_entries_for_user(giveaway['id'], actor['user_id'])
    allowed = max(1, int(giveaway['max_entries_per_user'] or 1))
    if current >= allowed:
        raise ValueError('Entry limit reached for this giveaway')

    with tx() as cur:
        cur.execute(
            'INSERT INTO giveaway_entries (giveaway_id, user_id, user_name, entered_ts) VALUES (?, ?, ?, ?)',
            (giveaway['id'], actor['user_id'], actor['user_name'], now),
        )

    return count_entries_for_user(giveaway['id'], actor['user_id'])


def draw_winner(giveaway_id: int):
    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')
    if giveaway['status'] not in {'open', 'closed'}:
        raise ValueError('Giveaway must be open or closed before drawing')

    rows = get_weighted_entries(giveaway_id)
    if not rows:
        raise ValueError('No entries to draw from')

    winner = dict(random.choice(rows))
    ts = now_ts()

    with tx() as cur:
        cur.execute(
            "UPDATE giveaways SET status='drawn', winner_user_id=?, winner_name=?, drawn_ts=?, updated_ts=? WHERE id=?",
            (winner['user_id'], winner['user_name'], ts, ts, giveaway_id),
        )
        cur.execute(
            'INSERT INTO giveaway_winners (giveaway_id, user_id, user_name, reward, drawn_ts) VALUES (?, ?, ?, ?, ?)',
            (giveaway_id, winner['user_id'], winner['user_name'], giveaway.get('reward') or '', ts),
        )

    return get_giveaway(giveaway_id)


def get_winner_history(limit: int = 20):
    with tx() as cur:
        cur.execute(
            'SELECT gw.*, g.title FROM giveaway_winners gw LEFT JOIN giveaways g ON g.id=gw.giveaway_id ORDER BY gw.id DESC LIMIT ?',
            (limit,),
        )
        return [dict(r) for r in cur.fetchall()]        except Exception:
            _CONN.rollback()
            raise
        finally:
            cur.close()


def init_db() -> None:
    with tx() as cur:
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                user_name TEXT NOT NULL,
                api_key_masked TEXT DEFAULT '',
                role TEXT NOT NULL DEFAULT 'user',
                created_ts INTEGER NOT NULL,
                last_seen_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                created_ts INTEGER NOT NULL,
                expires_ts INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                entry_requirement TEXT NOT NULL DEFAULT '1 free entry',
                reward TEXT NOT NULL DEFAULT '',
                rules TEXT NOT NULL DEFAULT '',
                start_ts INTEGER NOT NULL DEFAULT 0,
                end_ts INTEGER NOT NULL DEFAULT 0,
                max_entries_per_user INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                winner_user_id INTEGER,
                winner_name TEXT,
                drawn_ts INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER,
                created_by_name TEXT,
                created_ts INTEGER NOT NULL,
                updated_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS giveaway_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                entered_ts INTEGER NOT NULL,
                UNIQUE(giveaway_id, user_id, entered_ts),
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS giveaway_winners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                giveaway_id INTEGER NOT NULL,
                user_id INTEGER,
                user_name TEXT NOT NULL,
                reward TEXT NOT NULL DEFAULT '',
                drawn_ts INTEGER NOT NULL,
                FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_giveaway_id ON giveaway_entries(giveaway_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_entries_user_id ON giveaway_entries(user_id);
            CREATE INDEX IF NOT EXISTS idx_giveaway_winners_giveaway_id ON giveaway_winners(giveaway_id);
            """
        )
        cur.execute('PRAGMA table_info(giveaways)')
        giveaway_cols = {row['name'] for row in cur.fetchall()}
        if 'drawn_ts' not in giveaway_cols:
            cur.execute('ALTER TABLE giveaways ADD COLUMN drawn_ts INTEGER NOT NULL DEFAULT 0')


def mask_key(api_key: str) -> str:
    if not api_key:
        return ''
    if len(api_key) <= 6:
        return '*' * len(api_key)
    return f"{api_key[:3]}{'*' * max(0, len(api_key) - 6)}{api_key[-3:]}"


def upsert_user(user_id: int, user_name: str, role: str = 'user', api_key: str = '') -> None:
    ts = now_ts()
    masked = mask_key(api_key)
    with tx() as cur:
        cur.execute(
            """
            INSERT INTO users (user_id, user_name, api_key_masked, role, created_ts, last_seen_ts)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                user_name=excluded.user_name,
                api_key_masked=CASE WHEN excluded.api_key_masked='' THEN users.api_key_masked ELSE excluded.api_key_masked END,
                role=excluded.role,
                last_seen_ts=excluded.last_seen_ts
            """,
            (user_id, user_name, masked, role, ts, ts),
        )


def create_session(token: str, user_id: int, user_name: str, ttl_seconds: int) -> None:
    ts = now_ts()
    with tx() as cur:
        cur.execute(
            'INSERT INTO sessions (token, user_id, user_name, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)',
            (token, user_id, user_name, ts, ts + ttl_seconds),
        )


def get_session(token: str):
    if not token:
        return None
    with tx() as cur:
        cur.execute(
            'SELECT s.token, s.user_id, s.user_name, s.created_ts, s.expires_ts, u.role FROM sessions s LEFT JOIN users u ON u.user_id=s.user_id WHERE s.token=?',
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        if int(row['expires_ts']) < now_ts():
            cur.execute('DELETE FROM sessions WHERE token=?', (token,))
            return None
        return dict(row)


def delete_session(token: str) -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE token=?', (token,))


def cleanup_sessions() -> None:
    with tx() as cur:
        cur.execute('DELETE FROM sessions WHERE expires_ts < ?', (now_ts(),))


def get_latest_giveaway(include_draft: bool = True):
    q = 'SELECT * FROM giveaways'
    if not include_draft:
        q += " WHERE status != 'draft'"
    q += ' ORDER BY id DESC LIMIT 1'
    with tx() as cur:
        cur.execute(q)
        row = cur.fetchone()
        return dict(row) if row else None


def get_giveaway(giveaway_id: int):
    with tx() as cur:
        cur.execute('SELECT * FROM giveaways WHERE id=?', (giveaway_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def create_or_update_giveaway(payload: dict, actor: dict):
    ts = now_ts()
    giveaway_id = int(payload.get('id') or 0)
    title = str(payload.get('title') or '').strip()[:120]
    entry_requirement = str(payload.get('entry_requirement') or '1 free entry').strip()[:200]
    reward = str(payload.get('reward') or '').strip()[:200]
    rules = str(payload.get('rules') or '').strip()[:4000]
    start_ts = int(payload.get('start_ts') or 0)
    end_ts = int(payload.get('end_ts') or 0)
    max_entries = max(1, min(100, int(payload.get('max_entries_per_user') or 1)))
    status = str(payload.get('status') or 'draft').strip().lower()

    if not title:
        raise ValueError('Giveaway title is required')
    if not reward:
        raise ValueError('Reward is required')
    if start_ts and end_ts and end_ts <= start_ts:
        raise ValueError('End time must be after start time')
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        status = 'draft'

    with tx() as cur:
        if giveaway_id:
            cur.execute(
                """
                UPDATE giveaways
                SET title=?, entry_requirement=?, reward=?, rules=?, start_ts=?, end_ts=?,
                    max_entries_per_user=?, status=?,
                    drawn_ts=CASE WHEN ?='drawn' THEN drawn_ts ELSE 0 END,
                    updated_ts=?
                WHERE id=?
                """,
                (title, entry_requirement, reward, rules, start_ts, end_ts, max_entries, status, status, ts, giveaway_id),
            )
        else:
            cur.execute(
                """
                INSERT INTO giveaways (
                    title, entry_requirement, reward, rules,
                    start_ts, end_ts, max_entries_per_user, status,
                    created_by, created_by_name, created_ts, updated_ts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    title,
                    entry_requirement,
                    reward,
                    rules,
                    start_ts,
                    end_ts,
                    max_entries,
                    status,
                    actor['user_id'],
                    actor['user_name'],
                    ts,
                    ts,
                ),
            )
            giveaway_id = cur.lastrowid
    return get_giveaway(giveaway_id)


def set_giveaway_status(giveaway_id: int, status: str):
    status = status.lower().strip()
    if status not in {'draft', 'open', 'closed', 'drawn'}:
        raise ValueError('invalid status')

    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')

    ts = now_ts()
    with tx() as cur:
        if status == 'drawn':
            cur.execute('UPDATE giveaways SET status=?, updated_ts=? WHERE id=?', (status, ts, giveaway_id))
        else:
            cur.execute(
                "UPDATE giveaways SET status=?, winner_user_id=NULL, winner_name=NULL, drawn_ts=0, updated_ts=? WHERE id=?",
                (status, ts, giveaway_id),
            )
    return get_giveaway(giveaway_id)


def count_entries_for_user(giveaway_id: int, user_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=? AND user_id=?',
            (giveaway_id, user_id),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_entries(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=?', (giveaway_id,))
        row = cur.fetchone()
        return int(row['c'] or 0)


def count_distinct_entrants(giveaway_id: int) -> int:
    with tx() as cur:
        cur.execute(
            'SELECT COUNT(DISTINCT user_id) AS c FROM giveaway_entries WHERE giveaway_id=?',
            (giveaway_id,),
        )
        row = cur.fetchone()
        return int(row['c'] or 0)


def get_entrants(giveaway_id: int, limit: int = 1000):
    with tx() as cur:
        cur.execute(
            "SELECT user_id, user_name, MIN(entered_ts) AS first_entered_ts, COUNT(*) AS entries "
            "FROM giveaway_entries WHERE giveaway_id=? "
            "GROUP BY user_id, user_name "
            "ORDER BY first_entered_ts ASC, user_name ASC LIMIT ?",
            (giveaway_id, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def get_weighted_entries(giveaway_id: int):
    with tx() as cur:
        cur.execute(
            'SELECT user_id, user_name FROM giveaway_entries WHERE giveaway_id=? ORDER BY id ASC',
            (giveaway_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def add_entry(giveaway: dict, actor: dict):
    if not giveaway:
        raise ValueError('No active giveaway')

    now = now_ts()
    if giveaway['status'] != 'open':
        raise ValueError('Giveaway is not open')
    if giveaway['start_ts'] and now < int(giveaway['start_ts']):
        raise ValueError('Giveaway has not started yet')
    if giveaway['end_ts'] and now > int(giveaway['end_ts']):
        raise ValueError('Giveaway has already ended')

    current = count_entries_for_user(giveaway['id'], actor['user_id'])
    allowed = max(1, int(giveaway['max_entries_per_user'] or 1))
    if current >= allowed:
        raise ValueError('Entry limit reached for this giveaway')

    with tx() as cur:
        cur.execute(
            'INSERT INTO giveaway_entries (giveaway_id, user_id, user_name, entered_ts) VALUES (?, ?, ?, ?)',
            (giveaway['id'], actor['user_id'], actor['user_name'], now),
        )

    return count_entries_for_user(giveaway['id'], actor['user_id'])


def draw_winner(giveaway_id: int):
    giveaway = get_giveaway(giveaway_id)
    if not giveaway:
        raise ValueError('Giveaway not found')
    if giveaway['status'] not in {'open', 'closed'}:
        raise ValueError('Giveaway must be open or closed before drawing')

    rows = get_weighted_entries(giveaway_id)
    if not rows:
        raise ValueError('No entries to draw from')

    winner = dict(random.choice(rows))
    ts = now_ts()

    with tx() as cur:
        cur.execute(
            "UPDATE giveaways SET status='drawn', winner_user_id=?, winner_name=?, drawn_ts=?, updated_ts=? WHERE id=?",
            (winner['user_id'], winner['user_name'], ts, ts, giveaway_id),
        )
        cur.execute(
            'INSERT INTO giveaway_winners (giveaway_id, user_id, user_name, reward, drawn_ts) VALUES (?, ?, ?, ?, ?)',
            (giveaway_id, winner['user_id'], winner['user_name'], giveaway.get('reward') or '', ts),
        )

    return get_giveaway(giveaway_id)


def get_winner_history(limit: int = 20):
    with tx() as cur:
        cur.execute(
            'SELECT gw.*, g.title FROM giveaway_winners gw LEFT JOIN giveaways g ON g.id=gw.giveaway_id ORDER BY gw.id DESC LIMIT ?',
            (limit,),
        )
        return [dict(r) for r in cur.fetchall()]
