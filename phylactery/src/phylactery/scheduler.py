"""Consolidation scheduler (Pillar H).

Phylactery's own internal lifecycle worker — a self-paced, volume-gated
background thread that mirrors entity-core's 5-minute cron without being a
fixed beat. On each tick it runs, in order and each guarded independently:

  1. cheap-code hygiene  (dedup + unambiguous node merge — pure SQL)
  2. tier consolidation  (daily→weekly→monthly→yearly via the LLM)
  3. graduation audit     (Familiar-led, signed-off rule — graduation.py)

Volume gate: real work only runs when there is enough new material since the
last pass (or enough time has elapsed), so an idle Familiar doesn't burn the
designated connection on empty passes.

Off-switch: PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1 disables the whole worker.
The thread is a daemon, so it never blocks clean shutdown (stdio EOF exits
the process and the daemon goes with it).
"""

from __future__ import annotations

import os
import sys
import threading
from datetime import datetime, timezone

from phylactery.db import get_conn, now_iso

# Self-paced, not a fixed beat: we wake on this cadence but only do work when
# the volume gate says it's worth a pass.
_TICK_SECONDS = 300            # 5-minute wake cadence
_MIN_NEW_NARRATIVE = 5         # run a pass once this many records changed
_MIN_HOURS_BETWEEN = 6.0       # …or at least this often regardless of volume

_thread: threading.Thread | None = None
_stop = threading.Event()


def _disabled() -> bool:
    return os.environ.get("PROTO_FAMILIAR_CONSOLIDATE_DISABLED", "") == "1"


def _hours_since(iso: str | None, now: datetime) -> float:
    if not iso:
        return 1e9
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return 1e9
    return (now - dt).total_seconds() / 3600.0


def _last_run(conn) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key='consolidate_last_run'").fetchone()
    return row["value"] if row else None


def _records_changed_since(conn, iso: str | None) -> int:
    if not iso:
        return 1 << 30
    row = conn.execute(
        "SELECT COUNT(*) n FROM memories WHERE kind='narrative' AND updated_at > ?", (iso,)
    ).fetchone()
    return int(row["n"]) if row else 0


def _should_run(conn, now: datetime) -> bool:
    last = _last_run(conn)
    if _hours_since(last, now) >= _MIN_HOURS_BETWEEN:
        return True
    return _records_changed_since(conn, last) >= _MIN_NEW_NARRATIVE


def run_pass(force: bool = False) -> dict:
    """One lifecycle pass. Safe to call directly (tests / manual trigger)."""
    from phylactery import consolidate as consol
    from phylactery import graduation as grad

    conn = get_conn()
    try:
        now = datetime.now(timezone.utc)
        if not force and not _should_run(conn, now):
            return {"ok": True, "skipped": True, "reason": "volume gate"}

        result = {"ok": True}

        # 1. Cheap-code hygiene — never raises into the pass.
        try:
            result["hygiene"] = consol.run_hygiene(conn=conn)
        except Exception as e:
            result["hygiene"] = {"ok": False, "error": str(e)}

        # 2. Tier consolidation (needs the designated connection).
        cfg = consol._llm_config()
        if cfg:
            try:
                result["consolidation"] = consol.run_consolidation(conn=conn)
            except Exception as e:
                result["consolidation"] = {"ok": False, "error": str(e)}
            # 3. Graduation audit — rides the same designated connection.
            try:
                result["graduation"] = grad.run_graduation_audit(conn, cfg, consol._call_llm, now)
            except Exception as e:
                result["graduation"] = {"ok": False, "error": str(e)}
        else:
            result["consolidation"] = {"ok": False, "error": "no LLM configured"}
            result["graduation"] = {"ok": False, "error": "no LLM configured"}

        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('consolidate_last_run', ?)",
                (now_iso(),),
            )
        return result
    finally:
        conn.close()


def _loop() -> None:
    # First pass is deferred one tick so boot isn't competing with first-turn
    # enrichment for the DB.
    while not _stop.wait(_TICK_SECONDS):
        if _disabled():
            continue
        try:
            res = run_pass()
            if not res.get("skipped"):
                print(f"[phylactery] consolidation pass: {res}", file=sys.stderr)
        except Exception as e:
            print(f"[phylactery] consolidation pass failed (continuing): {e}", file=sys.stderr)


def start() -> None:
    """Start the scheduler thread once. No-op if disabled or already running."""
    global _thread
    if _disabled():
        print("[phylactery] consolidation scheduler DISABLED (PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1)", file=sys.stderr)
        return
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="phylactery-consolidate", daemon=True)
    _thread.start()
    print("[phylactery] consolidation scheduler started (5-min tick, volume-gated)", file=sys.stderr)


def stop() -> None:
    _stop.set()
