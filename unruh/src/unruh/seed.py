"""Seed-loader for Unruh's default routine.

Reads `seed_routine.json` (shipped in the package) and writes it
into the DB as `phase` nodes plus anchor `event` nodes connected
via `during` edges. Times in the JSON are HH:MM in the user's
local timezone; we stamp them to today's date in UTC at load time.

Idempotent enough to be safe to call without thinking: by default,
seeding skips phases that already exist with the same label.
Pass --replace to wipe existing phase + anchor-event nodes from
today before writing new ones (won't touch user-created events
or tasks).

Loadable two ways:
  - `python -m unruh seed-routine`      — CLI
  - `from unruh.seed import seed_today` — programmatic
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .db import get_conn
from . import schedule as sched

SEED_PATH = Path(__file__).parent / "seed_routine.json"


def _local_to_utc_today(hhmm: str, base_date: datetime | None = None) -> str:
    """Convert 'HH:MM' (system local TZ) on the given base date
    (default today) to an ISO-8601 UTC string. astimezone() reads
    the system TZ — same source server.js uses, per Decision 6.

    Wrap-around handling: an end-time HH:MM that's <= start-time
    HH:MM is interpreted as 'next day' (so 'late night' 23:00→06:00
    spans midnight)."""
    today = (base_date or datetime.now()).astimezone()
    h, m = (int(x) for x in hhmm.split(":"))
    local = today.replace(hour=h, minute=m, second=0, microsecond=0)
    return local.astimezone(timezone.utc).isoformat(timespec="seconds")


def _phase_end_today(start_hhmm: str, end_hhmm: str, base_date: datetime | None = None) -> str:
    """End-time variant that rolls into 'next day' when the end is
    not-later-than the start (the 'late night' 23:00→06:00 case).

    Uses timedelta(days=1) for the roll-over — `dt.replace(day=day+1)`
    raises on month-end boundaries (May 31 → June 31 is invalid). The
    seed-routine command was broken on the 31st of any 30-day month and
    on Feb 28/29 before this fix landed."""
    today = (base_date or datetime.now()).astimezone()
    sh, sm = (int(x) for x in start_hhmm.split(":"))
    eh, em = (int(x) for x in end_hhmm.split(":"))
    local_end = today.replace(hour=eh, minute=em, second=0, microsecond=0)
    if (eh, em) <= (sh, sm):
        local_end = local_end + timedelta(days=1)
    return local_end.astimezone(timezone.utc).isoformat(timespec="seconds")


def seed_today(*, replace: bool = False, seed_path: Path = SEED_PATH) -> dict:
    """Load the seed routine into the DB as phases + anchor events
    for today's date. Returns a summary {phases_added, events_added,
    skipped}.

    When `replace=True`, deletes existing phase nodes whose when_ts
    falls in today's window first, plus events created by previous
    seeds. User-created events / tasks are never touched.
    """
    data = json.loads(seed_path.read_text(encoding="utf-8"))
    now = datetime.now().astimezone()

    summary = {"phases_added": 0, "events_added": 0, "skipped": 0}

    with get_conn() as conn:
        # When replacing, drop today's phases + previously-seeded
        # anchor events (tagged via payload.seeded=True).
        if replace:
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat(timespec="seconds")
            today_end   = now.replace(hour=23, minute=59, second=59, microsecond=0).astimezone(timezone.utc).isoformat(timespec="seconds")
            conn.execute(
                "DELETE FROM nodes WHERE layer='schedule' AND type='phase' AND when_ts BETWEEN ? AND ?",
                (today_start, today_end),
            )
            conn.execute(
                """DELETE FROM nodes
                    WHERE layer='schedule' AND type='event'
                      AND when_ts BETWEEN ? AND ?
                      AND payload_json LIKE '%"seeded": true%' """,
                (today_start, today_end),
            )

        # Phases — map label → id so anchor events can attach via 'during'.
        phase_ids: dict[str, str] = {}
        for p in data.get("phases", []):
            existing = conn.execute(
                """SELECT id FROM nodes
                    WHERE layer='schedule' AND type='phase' AND label = ?
                      AND when_ts BETWEEN ? AND ?
                    LIMIT 1""",
                (
                    p["label"],
                    now.replace(hour=0, minute=0, second=0).astimezone(timezone.utc).isoformat(timespec="seconds"),
                    now.replace(hour=23, minute=59, second=59).astimezone(timezone.utc).isoformat(timespec="seconds"),
                ),
            ).fetchone()
            if existing:
                phase_ids[p["label"]] = existing["id"]
                summary["skipped"] += 1
                continue
            when_ts = _local_to_utc_today(p["time"], now)
            end_ts  = _phase_end_today(p["time"], p["end"], now)
            payload = {"seeded": True}
            if "texture" in p: payload["texture"] = p["texture"]
            node_id = sched.add_node(
                conn, type="phase", label=p["label"],
                when=when_ts, end=end_ts, payload=payload,
            )
            phase_ids[p["label"]] = node_id
            summary["phases_added"] += 1

        # Anchor events — attach to their phase via 'during'.
        for e in data.get("anchor_events", []):
            when_ts = _local_to_utc_today(e["time"], now)
            event_id = sched.add_node(
                conn, type="event", label=e["label"],
                when=when_ts, payload={"seeded": True},
            )
            summary["events_added"] += 1
            phase_label = e.get("during_phase")
            if phase_label and phase_label in phase_ids:
                sched.add_edge(
                    conn, src=event_id, dst=phase_ids[phase_label],
                    kind="during",
                )
    return summary


def cli_main(argv: list[str] | None = None) -> int:
    """Subcommand entry: `python -m unruh seed-routine [--replace]`."""
    parser = argparse.ArgumentParser(
        prog="unruh seed-routine",
        description="Load Unruh's default routine into the DB as phases + anchor events for today.",
    )
    parser.add_argument(
        "--replace", action="store_true",
        help="Delete today's existing phases and previously-seeded anchor events before writing. User-created events/tasks are never touched.",
    )
    args = parser.parse_args(argv)

    summary = seed_today(replace=args.replace)
    print(
        f"Seeded: {summary['phases_added']} phase(s) added, "
        f"{summary['events_added']} anchor event(s) added, "
        f"{summary['skipped']} phase(s) already present (skipped)."
    )
    if not args.replace and summary["skipped"]:
        print("Re-run with --replace to overwrite today's phases.")
    return 0
