import os
import secrets
import time
from functools import wraps

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

import db

TORN_API_URL = os.environ.get(
    'TORN_API_URL',
    'https://api.torn.com/user/?selections=profile&key={key}',
)
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', '').rstrip('/')
SESSION_TTL_SECONDS = int(os.environ.get('SESSION_TTL_SECONDS', '2592000'))
ADMIN_USER_IDS = {
    int(x.strip())
    for x in os.environ.get('ADMIN_USER_IDS', '').split(',')
    if x.strip().isdigit()
}
ALLOWED_SCRIPT_ORIGINS = [
    x.strip()
    for x in os.environ.get(
        'ALLOWED_SCRIPT_ORIGINS',
        'https://www.torn.com,https://torn.com',
    ).split(',')
    if x.strip()
]
WHEEL_PUBLIC_ENTRANTS = os.environ.get('WHEEL_PUBLIC_ENTRANTS', '1').strip().lower() not in {
    '0', 'false', 'no', 'off'
}


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(
        app,
        resources={r'/api/*': {'origins': ALLOWED_SCRIPT_ORIGINS + ['*']}},
        supports_credentials=False,
    )
    db.init_db()

    @app.get('/')
    def root():
        return jsonify(
            {
                'ok': True,
                'service': 'Torn Giveaway Overlay',
                'login': '/api/login',
                'state': '/api/giveaway/current',
                'history': '/api/giveaway/history',
            }
        )

    @app.get('/health')
    def health():
        return jsonify({'ok': True, 'ts': int(time.time())})

    def session_from_request():
        token = (
            request.headers.get('X-Session-Token')
            or request.headers.get('Authorization', '').replace('Bearer ', '').strip()
        )
        if not token:
            return None
        db.cleanup_sessions()
        return db.get_session(token)

    def require_auth(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            sess = session_from_request()
            if not sess:
                return jsonify({'ok': False, 'error': 'Authentication required'}), 401
            request.session = sess
            return fn(*args, **kwargs)

        return wrapper

    def require_admin(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            sess = session_from_request()
            if not sess:
                return jsonify({'ok': False, 'error': 'Authentication required'}), 401
            if str(sess.get('role')) != 'admin':
                return jsonify({'ok': False, 'error': 'Admin access required'}), 403
            request.session = sess
            return fn(*args, **kwargs)

        return wrapper

    def serialize_current(giveaway: dict | None, user_id: int | None = None):
        if not giveaway:
            return {
                'giveaway': None,
                'counts': {'total_entries': 0, 'entrant_count': 0, 'my_entries': 0},
                'entrants': [],
            }

        entrants = db.get_entrants(giveaway['id']) if WHEEL_PUBLIC_ENTRANTS else []
        total_entries = db.count_entries(giveaway['id'])
        entrant_count = len(entrants) if entrants else db.count_distinct_entrants(giveaway['id'])
        my_entries = db.count_entries_for_user(giveaway['id'], user_id) if user_id else 0

        return {
            'giveaway': giveaway,
            'counts': {
                'total_entries': total_entries,
                'entrant_count': entrant_count,
                'my_entries': my_entries,
            },
            'entrants': entrants,
        }

    @app.post('/api/login')
    def login():
        payload = request.get_json(silent=True) or {}
        api_key = str(payload.get('api_key') or '').strip()
        if not api_key:
            return jsonify({'ok': False, 'error': 'Missing API key'}), 400

        try:
            resp = requests.get(TORN_API_URL.format(key=api_key), timeout=20)
            data = resp.json()
        except Exception as exc:
            return jsonify({'ok': False, 'error': f'Failed to verify API key: {exc}'}), 502

        if not isinstance(data, dict):
            return jsonify({'ok': False, 'error': 'Unexpected Torn response'}), 502

        if data.get('error'):
            err = data.get('error') or {}
            return (
                jsonify(
                    {
                        'ok': False,
                        'error': err.get('error') or 'Invalid API key',
                        'code': err.get('code'),
                    }
                ),
                401,
            )

        player_id = int(data.get('player_id') or 0)
        name = str(data.get('name') or '').strip() or f'User {player_id}'
        if not player_id:
            return jsonify({'ok': False, 'error': 'Could not identify user'}), 401

        role = 'admin' if player_id in ADMIN_USER_IDS else 'user'
        db.upsert_user(player_id, name, role=role, api_key=api_key)
        token = secrets.token_urlsafe(32)
        db.create_session(token, player_id, name, SESSION_TTL_SECONDS)

        return jsonify(
            {
                'ok': True,
                'token': token,
                'user': {
                    'user_id': player_id,
                    'user_name': name,
                    'role': role,
                },
                'base_url': PUBLIC_BASE_URL,
            }
        )

    @app.post('/api/logout')
    @require_auth
    def logout():
        token = (
            request.headers.get('X-Session-Token')
            or request.headers.get('Authorization', '').replace('Bearer ', '').strip()
        )
        db.delete_session(token)
        return jsonify({'ok': True})

    @app.get('/api/me')
    @require_auth
    def me():
        return jsonify({'ok': True, 'user': request.session})

    @app.get('/api/giveaway/current')
    def giveaway_current():
        sess = session_from_request()
        giveaway = db.get_latest_giveaway(include_draft=True)
        user_id = int(sess['user_id']) if sess else None
        return jsonify({'ok': True, **serialize_current(giveaway, user_id)})

    @app.get('/api/giveaway/entrants')
    def giveaway_entrants_public():
        giveaway = db.get_latest_giveaway(include_draft=True)
        if not giveaway:
            return jsonify(
                {
                    'ok': True,
                    'entrants': [],
                    'counts': {'total_entries': 0, 'entrant_count': 0},
                }
            )
        entrants = db.get_entrants(giveaway['id'])
        return jsonify(
            {
                'ok': True,
                'entrants': entrants,
                'counts': {
                    'total_entries': db.count_entries(giveaway['id']),
                    'entrant_count': len(entrants),
                },
            }
        )

    @app.post('/api/giveaway/enter')
    @require_auth
    def giveaway_enter():
        giveaway = db.get_latest_giveaway(include_draft=True)
        try:
            my_entries = db.add_entry(giveaway, request.session)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400

        payload = serialize_current(giveaway, int(request.session['user_id']))
        payload['ok'] = True
        payload['message'] = 'Entry added'
        payload['counts']['my_entries'] = my_entries
        return jsonify(payload)

    @app.get('/api/giveaway/history')
    def giveaway_history():
        return jsonify({'ok': True, 'history': db.get_winner_history(20)})

    @app.post('/api/giveaway/admin/save')
    @require_admin
    def admin_save():
        payload = request.get_json(silent=True) or {}
        try:
            giveaway = db.create_or_update_giveaway(payload, request.session)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        return jsonify({'ok': True, 'giveaway': giveaway})

    @app.post('/api/giveaway/admin/status')
    @require_admin
    def admin_status():
        payload = request.get_json(silent=True) or {}
        giveaway_id = int(payload.get('id') or 0)
        status = str(payload.get('status') or '').strip().lower()

        if not giveaway_id:
            current = db.get_latest_giveaway(include_draft=True)
            giveaway_id = int(current['id']) if current else 0

        if not giveaway_id:
            return jsonify({'ok': False, 'error': 'No giveaway found'}), 404

        try:
            giveaway = db.set_giveaway_status(giveaway_id, status)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        return jsonify({'ok': True, 'giveaway': giveaway})

    @app.post('/api/giveaway/admin/draw')
    @require_admin
    def admin_draw():
        payload = request.get_json(silent=True) or {}
        giveaway_id = int(payload.get('id') or 0)

        if not giveaway_id:
            current = db.get_latest_giveaway(include_draft=True)
            giveaway_id = int(current['id']) if current else 0

        if not giveaway_id:
            return jsonify({'ok': False, 'error': 'No giveaway found'}), 404

        try:
            giveaway = db.draw_winner(giveaway_id)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        return jsonify({'ok': True, 'giveaway': giveaway})

    return app


app = create_app()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5000'))
    app.run(host='0.0.0.0', port=port, debug=True)
