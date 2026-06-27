"""Schedule node → `.ics` bytes + "add to Google" URL (build spec §2).

The outbound half: deterministic artifacts built **in code** from a node's
stored fields, so the Familiar never types a date, a UID, an RRULE, or a
URL — it passes a node `id` and gets back a correct file/link (the
exact-machine-values spine, §3). Pure functions, no DB, no network.

Local → UTC at this one boundary (mirror of the §1.2 ingest seam): Unruh
stores `when_ts`/`end_ts` as the ward's local wall-clock with no offset, but
an external calendar needs a real instant, so a timed event's DTSTART/DTEND
and the Google `dates=…Z` are converted UP to UTC here — using the system's
local offset, which is the ward's zone (thalamus spawns Unruh with
TZ=wardTimeZone). All-day events stay date-only (no instant to convert).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

_PRODID = "-//Proto-Familiar//Unruh//EN"


def _parse_local(s: str | None) -> datetime | None:
    """Parse a stored local-naive (or stray offset-bearing) ISO timestamp to
    a naive-local datetime. Mirrors db._parse_iso: an offset value is shifted
    to local and the tzinfo dropped, so the result is always naive-local."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def _utc_basic(dt: datetime) -> str:
    """Naive-local datetime → iCal basic UTC string '20260702T140000Z'. The
    naive value is interpreted in the system local zone (the ward's, via
    TZ=wardTimeZone) and converted to UTC."""
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _date_basic(dt: datetime) -> str:
    """Naive datetime → iCal DATE string '20260702' (all-day, no instant)."""
    return dt.strftime("%Y%m%d")


def _escape_text(v: str) -> str:
    """Escape a TEXT value for an `.ics` line (RFC 5545)."""
    return (
        (v or "")
        .replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _fold(line: str) -> str:
    """Fold a content line to ≤75 octets with CRLF + space continuations."""
    out = []
    while len(line.encode("utf-8")) > 75:
        # Walk back to a boundary that keeps the first chunk ≤75 bytes.
        cut = 75
        while len(line[:cut].encode("utf-8")) > 75:
            cut -= 1
        out.append(line[:cut])
        line = " " + line[cut:]
    out.append(line)
    return "\r\n".join(out)


def _resolve_window(node: dict[str, Any]) -> tuple[datetime | None, datetime | None, bool]:
    """(start, end, all_day) for a node, defaulting a missing end so the
    artifact always carries a range (Google requires one): +1h for a timed
    event, +1 day for an all-day event."""
    all_day = bool((node.get("payload") or {}).get("all_day"))
    start = _parse_local(node.get("when"))
    end = _parse_local(node.get("end"))
    if start and not end:
        end = start + (timedelta(days=1) if all_day else timedelta(hours=1))
    return start, end, all_day


def build_ics(node: dict[str, Any], *, now: datetime | None = None) -> str:
    """A single-VEVENT VCALENDAR string for a schedule node. `now` (UTC)
    stamps DTSTAMP; default is the current instant."""
    payload = node.get("payload") or {}
    start, end, all_day = _resolve_window(node)
    dtstamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:{_PRODID}", "BEGIN:VEVENT"]
    lines.append(f"UID:{node.get('id', 'unruh')}@proto-familiar")
    lines.append(f"DTSTAMP:{dtstamp}")
    if start:
        if all_day:
            lines.append(f"DTSTART;VALUE=DATE:{_date_basic(start)}")
            if end:
                lines.append(f"DTEND;VALUE=DATE:{_date_basic(end)}")
        else:
            lines.append(f"DTSTART:{_utc_basic(start)}")
            if end:
                lines.append(f"DTEND:{_utc_basic(end)}")
    lines.append(f"SUMMARY:{_escape_text(node.get('label', ''))}")
    if payload.get("location"):
        lines.append(f"LOCATION:{_escape_text(payload['location'])}")
    if payload.get("description"):
        lines.append(f"DESCRIPTION:{_escape_text(payload['description'])}")
    lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"


def build_google_url(node: dict[str, Any]) -> str:
    """A calendar.google.com "render?action=TEMPLATE" prefilled-event URL."""
    payload = node.get("payload") or {}
    start, end, all_day = _resolve_window(node)
    params = [("action", "TEMPLATE"), ("text", node.get("label", ""))]
    if start and end:
        if all_day:
            params.append(("dates", f"{_date_basic(start)}/{_date_basic(end)}"))
        else:
            params.append(("dates", f"{_utc_basic(start)}/{_utc_basic(end)}"))
    if payload.get("description"):
        params.append(("details", payload["description"]))
    if payload.get("location"):
        params.append(("location", payload["location"]))
    query = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params)
    return f"https://calendar.google.com/calendar/render?{query}"


def export_node(node: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """The full export artifact for a node: {ok, ics, google_url}."""
    return {
        "ok": True,
        "ics": build_ics(node, now=now),
        "google_url": build_google_url(node),
    }
