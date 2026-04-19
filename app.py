from __future__ import annotations

import os
import random
import threading
import time
from datetime import datetime
from typing import Any

from flask import Flask, jsonify, request, session

try:
    from flask_cors import CORS
except Exception:  # pragma: no cover
    CORS = None

from db import (
    db_conn,
    get_settings,
    update_settings,
    init_db,
    get_or_create_current_round,
    get_round_by_id,
    get_latest_drawn_round,
    maybe_lock_current_round,
    calculate_round_totals,
    get_user_ticket_count,
    add_verified_tickets,
    get_wheel_entries,
    get_history,
    get_admin_round_state,
    get_round_tickets,
    save_draw_result,
    set_round_status,
)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-me-in-render")

if CORS is not None:
    CORS(app, supports_credentials=True, resources={r"/api/*": {"origins": "*"}})

init_db()

ADMIN_USER_ID = int(os.environ.get("ADMIN_USER_ID", "3679030"))
ADMIN_USER_NAME = os.environ.get("ADMIN_USER_NAME", "Fries91")
ENABLE_DRAW_WATCHER = os.environ.get("ENABLE_DRAW_WATCHER", "1") == "1"
DRAW_WATCHER_INTERVAL = int(os.environ.get("DRAW_WATCHER_INTERVAL", "30"))


def ok(payload: dict[str, Any] | None = None, status: int = 200):
    body = {"ok": True}
    if payload:
        body.update(payload)
    return jsonify(body), status


def fail(message: str, status: int = 400, **extra):
    body = {"ok": False, "error": message}
    if extra:
        body.update(extra)
    return jsonify(body), status


def now_iso() -> str:
    return datetime.utcnow().isoformat()


def clamp_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def get_session_user() -> dict[str, Any] | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    return {
        "user_id": int(session.get("user_id")),
        "user_name": str(session.get("user_name") or ""),
        "faction_id": int(session.get("faction_id") or 0),
        "is_admin": bool(int(session.get("is_admin") or 0)),
    }


def get_request_user() -> dict[str, Any] | None:
    sess_user = get_session_user()
    if sess_user:
        return sess_user

    header_user_id = request.headers.get("X-User-Id")
    if not header_user_id:
        return None

    user_id = clamp_int(header_user_id, 0)
    if user_id <= 0:
        return None

    user_name = (request.headers.get("X-User-Name") or "").strip() or f"User{user_id}"
    faction_id = clamp_int(request.headers.get("X-Faction-Id"), 0)
    is_admin = request.headers.get("X-Is-Admin", "0").strip() in {"1", "true", "True"}
    if user_id == ADMIN_USER_ID:
        is_admin = True

    return {
        "user_id": user_id,
        "user_name": user_name,
        "faction_id": faction_id,
        "is_admin": is_admin,
    }


def require_user():
    user = get_request_user()
    if not user:
        return None, fail("Not logged in.", 401)
    return user, None


def require_admin():
    user, err = require_user()
    if err:
        return None, err
    if not user["is_admin"] and int(user["user_id"]) != ADMIN_USER_ID:
        return None, fail("Admin only.", 403)
    return user, None


def is_lottery_user(_user: dict[str, Any], _settings: dict[str, Any]) -> bool:
    return True


def build_me_payload(user: dict[str, Any], round_row: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    with db_conn() as conn:
        ticket_count = get_user_ticket_count(conn, int(round_row["id"]), int(user["user_id"]))
    max_tickets = int(settings["max_tickets_per_member"])
    return {
        "user_id": int(user["user_id"]),
        "user_name": str(user["user_name"]),
        "faction_id": int(user.get("faction_id") or 0),
        "ticket_count": ticket_count,
        "tickets_left": max(0, max_tickets - ticket_count),
        "is_faction_member": True,
        "is_admin": bool(user["is_admin"] or int(user["user_id"]) == ADMIN_USER_ID),
    }


def get_last_winner_payload(conn) -> dict[str, Any] | None:
    last = get_latest_drawn_round(conn)
    if not last:
        return None
    return {
        "round_id": int(last["id"]),
        "week_key": last["week_key"],
        "winner_user_id": last["winner_user_id"],
        "winner_name": last["winner_name"],
        "winning_ticket_number": last["winning_ticket_number"],
        "winner_payout": int(last["winner_payout"] or 0),
        "rollover_amount": int(last.get("rollover_amount") or 0),
        "admin_fee_amount": int(last.get("admin_fee_amount") or 0),
        "drawn_at": last["drawn_at"],
    }


def entry_key(user_id: int, quantity: int, entry_ref: str | None) -> str:
    ref = (entry_ref or "").strip() or f"free-entry-{user_id}-{quantity}"
    return f"free:{user_id}:{quantity}:{ref}"


def run_draw_for_round(conn, round_row: dict[str, Any]) -> dict[str, Any]:
    round_id = int(round_row["id"])
    current = get_round_by_id(conn, round_id)
    if not current:
        raise ValueError("Round not found.")

    if current["status"] == "drawn":
        return current

    if current["status"] == "cancelled":
        raise ValueError("Round is cancelled.")

    if current["status"] == "open":
        set_round_status(conn, round_id, "locked")
        current = get_round_by_id(conn, round_id)
        if not current:
            raise ValueError("Could not reload locked round.")

    calculate_round_totals(conn, round_id)
    tickets = get_round_tickets(conn, round_id)

    if not tickets:
        set_round_status(conn, round_id, "drawn")
        updated = get_round_by_id(conn, round_id)
        if not updated:
            raise ValueError("Failed to finalize empty round.")
        return updated

    winner_ticket = random.choice(tickets)
    return save_draw_result(
        conn=conn,
        round_id=round_id,
        winner_user_id=int(winner_ticket["user_id"]),
        winner_name=str(winner_ticket["user_name"]),
        winning_ticket_id=int(winner_ticket["id"]),
        winning_ticket_number=int(winner_ticket["ticket_number"]),
    )


def ensure_round_progression() -> None:
    with db_conn() as conn:
        current_round = maybe_lock_current_round(conn)
        if str(current_round["status"]) == "locked":
            run_draw_for_round(conn, current_round)


_draw_thread_started = False


def draw_watcher_loop():
    while True:
        try:
            ensure_round_progression()
        except Exception as exc:
            print(f"[lottery] draw watcher error: {exc}")
        time.sleep(max(5, DRAW_WATCHER_INTERVAL))


def maybe_start_draw_watcher():
    global _draw_thread_started
    if _draw_thread_started or not ENABLE_DRAW_WATCHER:
        return
    threading.Thread(target=draw_watcher_loop, daemon=True).start()
    _draw_thread_started = True
    print("[lottery] draw watcher started")


maybe_start_draw_watcher()


@app.before_request
def _before_request():
    if request.path.startswith("/api/"):
        try:
            ensure_round_progression()
        except Exception as exc:
            print(f"[lottery] pre-request progression error: {exc}")


@app.get("/")
def index():
    return jsonify({"name": "Sinner's Lottery API", "ok": True, "time": now_iso(), "mode": "free-entry"})


@app.get("/api/health")
def api_health():
    with db_conn() as conn:
        settings = get_settings(conn)
        current_round = get_or_create_current_round(conn)
        totals = calculate_round_totals(conn, int(current_round["id"]))
        current_round = get_round_by_id(conn, int(current_round["id"])) or current_round
    return ok({"time": now_iso(), "settings": settings, "current_round": current_round, "totals": totals, "mode": "free-entry"})


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    user_id = clamp_int(data.get("user_id"), 0)
    user_name = str(data.get("user_name") or "").strip()
    faction_id = clamp_int(data.get("faction_id"), 0)
    if user_id <= 0:
        return fail("Missing or invalid user_id.")
    if not user_name:
        user_name = f"User{user_id}"
    is_admin = user_id == ADMIN_USER_ID
    session["user_id"] = user_id
    session["user_name"] = user_name
    session["faction_id"] = faction_id
    session["is_admin"] = 1 if is_admin else 0
    return ok({"user": {"user_id": user_id, "user_name": user_name, "faction_id": faction_id, "is_admin": is_admin}})


@app.post("/api/logout")
def api_logout():
    session.clear()
    return ok({"message": "Logged out."})


@app.get("/api/me")
def api_me():
    user = get_request_user()
    if not user:
        return fail("Not logged in.", 401)
    return ok({"user": user})


@app.get("/api/lottery/state")
def api_lottery_state():
    user, err = require_user()
    if err:
        return err
    with db_conn() as conn:
        settings = get_settings(conn)
        current_round = get_or_create_current_round(conn)
        totals = calculate_round_totals(conn, int(current_round["id"]))
        current_round = get_round_by_id(conn, int(current_round["id"])) or current_round
        last_winner = get_last_winner_payload(conn)
    me = build_me_payload(user, current_round, settings)
    return ok(
        {
            "settings": {
                "enabled": int(settings["enabled"]),
                "ticket_price": int(settings["ticket_price"]),
                "winner_percent": int(settings["winner_percent"]),
                "rollover_percent": int(settings["rollover_percent"]),
                "admin_fee_percent": int(settings["admin_fee_percent"]),
                "max_tickets_per_member": int(settings["max_tickets_per_member"]),
                "draw_day": int(settings["draw_day"]),
                "draw_hour": int(settings["draw_hour"]),
                "draw_minute": int(settings["draw_minute"]),
                "timezone": settings["timezone"],
                "payment_receiver_id": int(settings["payment_receiver_id"]),
                "payment_receiver_name": settings["payment_receiver_name"],
            },
            "round": current_round,
            "totals": totals,
            "me": me,
            "last_winner": last_winner,
        }
    )


@app.get("/api/lottery/wheel")
def api_lottery_wheel():
    user, err = require_user()
    if err:
        return err
    with db_conn() as conn:
        settings = get_settings(conn)
        if not is_lottery_user(user, settings):
            return fail("Not allowed.", 403)
        current_round = get_or_create_current_round(conn)
        entries = get_wheel_entries(conn, int(current_round["id"]))
    return ok({"round_id": int(current_round["id"]), "entries": [{"ticket_id": int(e["ticket_id"]), "ticket_number": int(e["ticket_number"]), "user_id": int(e["user_id"]), "label": e["user_name"]} for e in entries]})


@app.post("/api/lottery/buy")
def api_lottery_buy():
    user, err = require_user()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    quantity = clamp_int(data.get("quantity"), 0)
    if quantity < 1:
        return fail("Quantity must be at least 1.")
    with db_conn() as conn:
        settings = get_settings(conn)
        if not int(settings["enabled"]):
            return fail("Lottery is disabled.", 403)
        current_round = maybe_lock_current_round(conn)
        if current_round["status"] != "open":
            return fail("Entries are closed for this round.", 409)
        max_tickets = int(settings["max_tickets_per_member"])
        current_count = get_user_ticket_count(conn, int(current_round["id"]), int(user["user_id"]))
        if current_count + quantity > max_tickets:
            return fail("Ticket limit exceeded.", 409, current_tickets=current_count, max_tickets=max_tickets)
        ticket_price = int(settings["ticket_price"])
        display_value = ticket_price * quantity
        return ok(
            {
                "round_id": int(current_round["id"]),
                "quantity": quantity,
                "amount_due": display_value,
                "ticket_price": ticket_price,
                "message": f"Confirm {quantity} free entr{'y' if quantity == 1 else 'ies'}. Display value: ${display_value:,}.",
                "mode": "free-entry",
            }
        )


@app.post("/api/lottery/verify-payment")
def api_lottery_verify_payment():
    user, err = require_user()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    quantity = clamp_int(data.get("quantity"), 0)
    entry_ref = str(data.get("payment_ref") or "").strip() or None
    if quantity < 1:
        return fail("Quantity must be at least 1.")
    with db_conn() as conn:
        settings = get_settings(conn)
        if not int(settings["enabled"]):
            return fail("Lottery is disabled.", 403)
        current_round = maybe_lock_current_round(conn)
        if current_round["status"] != "open":
            return fail("Entries are closed for this round.", 409)
        max_tickets = int(settings["max_tickets_per_member"])
        current_count = get_user_ticket_count(conn, int(current_round["id"]), int(user["user_id"]))
        if current_count + quantity > max_tickets:
            return fail("Ticket limit exceeded.", 409, current_tickets=current_count, max_tickets=max_tickets)

        display_total = int(settings["ticket_price"]) * quantity
        key_prefix = entry_key(int(user["user_id"]), quantity, entry_ref)
        try:
            ticket_numbers = add_verified_tickets(
                conn=conn,
                round_id=int(current_round["id"]),
                user_id=int(user["user_id"]),
                user_name=str(user["user_name"]),
                quantity=quantity,
                payment_amount_total=display_total,
                payment_key_prefix=key_prefix,
                payment_ref=entry_ref or "free-entry-confirmed",
            )
        except Exception as exc:
            return fail(str(exc), 409)

        totals = calculate_round_totals(conn, int(current_round["id"]))
        updated_round = get_round_by_id(conn, int(current_round["id"])) or current_round
        return ok(
            {
                "round_id": int(updated_round["id"]),
                "added_tickets": quantity,
                "ticket_numbers": ticket_numbers,
                "gross_pool": int(totals["gross_pool"]),
                "winner_payout": int(totals["winner_payout"]),
                "rollover_amount": int(totals["rollover_amount"]),
                "admin_fee_amount": int(totals["admin_fee_amount"]),
                "total_tickets": int(totals["total_tickets"]),
                "payment_ref": entry_ref or "free-entry-confirmed",
                "mode": "free-entry",
            }
        )


@app.get("/api/lottery/history")
def api_lottery_history():
    user, err = require_user()
    if err:
        return err
    with db_conn() as conn:
        settings = get_settings(conn)
        if not is_lottery_user(user, settings):
            return fail("Not allowed.", 403)
        rows = get_history(conn, limit=20)
    return ok({"history": rows})


@app.get("/api/lottery/admin/state")
def api_lottery_admin_state():
    _, err = require_admin()
    if err:
        return err
    with db_conn() as conn:
        current_round = get_or_create_current_round(conn)
        calculate_round_totals(conn, int(current_round["id"]))
        payload = get_admin_round_state(conn, int(current_round["id"]))
        settings = get_settings(conn)
    return ok({"settings": settings, "round": payload["round"], "entrants": payload["entrants"], "tickets": payload["tickets"]})


@app.post("/api/lottery/admin/force-draw")
def api_lottery_admin_force_draw():
    _, err = require_admin()
    if err:
        return err
    with db_conn() as conn:
        current_round = get_or_create_current_round(conn)
        if current_round["status"] == "cancelled":
            return fail("Current round is cancelled.", 409)
        result = run_draw_for_round(conn, current_round)
    return ok({"message": "Draw completed.", "round": result})


@app.post("/api/lottery/admin/cancel-round")
def api_lottery_admin_cancel_round():
    _, err = require_admin()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason") or "").strip()
    with db_conn() as conn:
        current_round = get_or_create_current_round(conn)
        if current_round["status"] == "drawn":
            return fail("Cannot cancel a drawn round.", 409)
        set_round_status(conn, int(current_round["id"]), "cancelled")
        updated = get_round_by_id(conn, int(current_round["id"])) or current_round
    return ok({"message": "Round cancelled.", "reason": reason, "round": updated})


@app.post("/api/lottery/admin/settings")
def api_lottery_admin_settings():
    _, err = require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    allowed_payload = {
        "enabled": clamp_int(data.get("enabled"), 1),
        "payment_receiver_id": clamp_int(data.get("payment_receiver_id"), ADMIN_USER_ID),
        "payment_receiver_name": str(data.get("payment_receiver_name") or ADMIN_USER_NAME).strip() or ADMIN_USER_NAME,
        "ticket_price": clamp_int(data.get("ticket_price"), 850_000),
        "winner_percent": clamp_int(data.get("winner_percent"), 50),
        "rollover_percent": clamp_int(data.get("rollover_percent"), 35),
        "admin_fee_percent": clamp_int(data.get("admin_fee_percent"), 15),
        "max_tickets_per_member": clamp_int(data.get("max_tickets_per_member"), 5),
        "draw_day": clamp_int(data.get("draw_day"), 6),
        "draw_hour": clamp_int(data.get("draw_hour"), 20),
        "draw_minute": clamp_int(data.get("draw_minute"), 0),
        "timezone": str(data.get("timezone") or "America/Toronto").strip() or "America/Toronto",
    }

    if allowed_payload["ticket_price"] <= 0:
        return fail("ticket_price must be greater than 0.")
    if not (1 <= allowed_payload["max_tickets_per_member"] <= 100):
        return fail("max_tickets_per_member must be between 1 and 100.")
    if not (0 <= allowed_payload["draw_hour"] <= 23):
        return fail("draw_hour must be between 0 and 23.")
    if not (0 <= allowed_payload["draw_minute"] <= 59):
        return fail("draw_minute must be between 0 and 59.")
    if not (0 <= allowed_payload["draw_day"] <= 6):
        return fail("draw_day must be between 0 and 6.")
    total_percent = allowed_payload["winner_percent"] + allowed_payload["rollover_percent"] + allowed_payload["admin_fee_percent"]
    if total_percent != 100:
        return fail("winner_percent + rollover_percent + admin_fee_percent must equal 100.")
    with db_conn() as conn:
        saved = update_settings(conn, allowed_payload)
    return ok({"message": "Settings updated.", "settings": saved})


@app.errorhandler(404)
def not_found(_e):
    return fail("Not found.", 404)


@app.errorhandler(405)
def method_not_allowed(_e):
    return fail("Method not allowed.", 405)


@app.errorhandler(500)
def internal_error(e):
    print(f"[lottery] internal error: {e}")
    return fail("Internal server error.", 500)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
