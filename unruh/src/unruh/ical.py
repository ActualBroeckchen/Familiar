"""iCalendar (.ics) parsing → the normalized-event contract.

This is the single place an `.ics` feed is parsed. It is **pure** —
no network, no DB — so it unit-tests against fixture `.ics` strings
(network + secrets live in Node, per the build spec §1.5). The Node
link/gogcli/gcalcli adapters fetch bytes; this turns them into the
shared normalized-event shape that `gcal.py` maps to schedule nodes.

Normalized event (the seam — defined once, here; §1.1):

    {
      "uid":           "abc123@google.com",   # stable idempotency key
      "summary":       "Dentist",
      "start":         "2026-07-02T14:00:00Z" | "2026-07-02T14:00:00",
      "end":           "<iso>" | None,
      "all_day":       False,
      "recurrence":    {"freq": "weekly", "interval": 1, ...} | None,
      "location":      "12 High St" | None,
      "description":   "bring referral letter" | None,
      "status":        "confirmed" | "cancelled",
      "last_modified": "<iso>" | None,
      "expanded_from": "<parent-uid>" | None,  # set on §1.4 fallback occurrences
    }

`start`/`end` are emitted as the calendar's own instant — UTC ("…Z"),
zone-resolved (TZID → real offset), or naive floating/all-day local.
The local-naive conversion happens later, in code, at the DB write
boundary (`db.to_local_naive`) — never here, never the model (§1.2).

Recurrence handling (§1.4):
  - An RRULE that fits the `recurrence.js` subset (FREQ/INTERVAL, the
    one weekly BYDAY that equals the anchor, monthly BYMONTHDAY==anchor
    or a single BYDAY+BYSETPOS, optional UNTIL) is mapped to a
    `recurrence` dict and stays ONE anchor event.
  - Anything outside that subset (multi-BYDAY, BYMONTHDAY lists, COUNT,
    EXDATE, …) is **expanded** to individual occurrences within a 90-day
    horizon, each with a stable synthetic uid "<uid>#<YYYY-MM-DD>" so the
    next sync reconciles them idempotently. The series is never silently
    dropped.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

try:  # py3.9+; present on every supported runtime
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - defensive
    ZoneInfo = None  # type: ignore


# How far ahead an un-mappable recurring series is materialised (§1.4).
# Occurrence-horizon, NOT tied to the sync cadence — each sync refreshes
# the horizon forward and the stable per-occurrence uids reconcile.
FALLBACK_HORIZON_DAYS = 90
# Hard cap on fallback occurrences per series, so a pathological rule
# (e.g. FREQ=SECONDLY) can never balloon the node set.
FALLBACK_MAX_OCCURRENCES = 366

# iCal weekday codes → JS getDay() convention (0=Sunday … 6=Saturday).
# This is the convention recurrence.js actually consumes for monthly
# BYSETPOS expansion (it compares against Date.getDay()), so the mapped
# `byweekday` must match it — exact-machine-value discipline: produce the
# value the real consumer reads, not the one a doc aspires to.
_ICAL_DAY_TO_JS = {"SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6}
_JS_DAY_FROM_PY = lambda d: (d.weekday() + 1) % 7  # py Mon=0 → JS Sun=0


# ── Line unfolding + property parsing ──────────────────────────────────


def _unfold(text: str) -> list[str]:
    """Undo RFC-5545 line folding: a CRLF followed by a space or tab is a
    continuation of the previous logical line. Tolerates bare LF too (real
    feeds are sloppy)."""
    raw = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines: list[str] = []
    for ln in raw:
        if ln[:1] in (" ", "\t") and lines:
            lines[-1] += ln[1:]
        else:
            lines.append(ln)
    return lines


def _unescape(v: str) -> str:
    """Unescape TEXT-value backslash escapes (\\n \\, \\; \\\\)."""
    out = []
    i = 0
    while i < len(v):
        c = v[i]
        if c == "\\" and i + 1 < len(v):
            nxt = v[i + 1]
            out.append({"n": "\n", "N": "\n", ",": ",", ";": ";", "\\": "\\"}.get(nxt, nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _split_prop(line: str) -> tuple[str, dict[str, str], str]:
    """Split "NAME;PARAM=x;PARAM2=y:value" → (NAME, {param:val}, value)."""
    if ":" not in line:
        return line.upper(), {}, ""
    head, value = line.split(":", 1)
    parts = head.split(";")
    name = parts[0].upper()
    params: dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v
    return name, params, value


# ── DTSTART / DTEND → datetime ─────────────────────────────────────────


def _parse_dt(value: str, params: dict[str, str]) -> tuple[datetime | None, bool]:
    """Parse an iCal date/date-time property value to a datetime, plus an
    `all_day` flag.

    - VALUE=DATE or an 8-char value → all-day, naive midnight.
    - "…Z" → UTC-aware.
    - TZID=… → zone-resolved aware (falls back to naive floating if the
      zone is unknown — bounded, logged by the caller path).
    - otherwise → naive floating local.
    """
    v = (value or "").strip()
    if not v:
        return None, False
    is_date = params.get("VALUE", "").upper() == "DATE" or (len(v) == 8 and "T" not in v)
    if is_date:
        try:
            d = datetime.strptime(v[:8], "%Y%m%d")
            return d, True
        except ValueError:
            return None, False
    # date-time forms: 20260702T140000 [Z]
    utc = v.endswith("Z")
    core = v[:-1] if utc else v
    try:
        dt = datetime.strptime(core, "%Y%m%dT%H%M%S")
    except ValueError:
        try:
            dt = datetime.fromisoformat(core)  # tolerate already-ISO inputs
        except ValueError:
            return None, False
    if utc:
        from datetime import timezone
        return dt.replace(tzinfo=timezone.utc), False
    tzid = params.get("TZID")
    if tzid and ZoneInfo is not None:
        try:
            return dt.replace(tzinfo=ZoneInfo(tzid)), False
        except Exception:
            return dt, False  # unknown zone → treat as floating local
    return dt, False  # floating local


# ── RRULE ──────────────────────────────────────────────────────────────


def _parse_rrule(value: str) -> dict[str, Any]:
    """Parse "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE" → a dict of upper-cased
    parts with list-valued BY* fields."""
    out: dict[str, Any] = {}
    for part in (value or "").split(";"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.upper()
        if k in ("BYDAY", "BYMONTHDAY", "BYSETPOS", "BYMONTH"):
            out[k] = [x for x in v.split(",") if x]
        else:
            out[k] = v.upper() if k == "FREQ" else v
    return out


def _parse_byday(tokens: list[str]) -> list[tuple[int | None, int]]:
    """["MO", "-1FR"] → [(None, 1), (-1, 5)] as (ordinal, js-weekday)."""
    out: list[tuple[int | None, int]] = []
    for t in tokens:
        t = t.strip().upper()
        code = t[-2:]
        if code not in _ICAL_DAY_TO_JS:
            continue
        ord_str = t[:-2]
        ordinal = int(ord_str) if ord_str and ord_str.lstrip("+-").isdigit() else None
        out.append((ordinal, _ICAL_DAY_TO_JS[code]))
    return out


def map_rrule_to_subset(rrule: dict[str, Any], dtstart: datetime) -> dict[str, Any] | None:
    """Map an RRULE to the `recurrence.js` subset, or None if it doesn't fit
    (the caller then expands it as individual occurrences, §1.4).

    Mappable:
      FREQ in {DAILY,WEEKLY,MONTHLY,YEARLY}; optional INTERVAL; optional UNTIL.
      WEEKLY: no BYDAY, or a single BYDAY equal to the anchor's weekday.
      MONTHLY: a single BYMONTHDAY equal to the anchor day; OR a single
               BYDAY + single BYSETPOS in {1,2,3,4,-1}.
      DAILY / YEARLY: no BY* parts.
    COUNT, EXDATE, and every richer BY* combination fall through to None.
    """
    freq = str(rrule.get("FREQ", "")).lower()
    if freq not in ("daily", "weekly", "monthly", "yearly"):
        return None
    if "COUNT" in rrule:
        return None  # subset has no occurrence-count cap → expand instead
    out: dict[str, Any] = {"freq": freq}
    interval = rrule.get("INTERVAL")
    if interval is not None:
        try:
            iv = int(interval)
            if iv > 1:
                out["interval"] = iv
        except (TypeError, ValueError):
            return None

    byday = _parse_byday(rrule.get("BYDAY", []))
    bymonthday = rrule.get("BYMONTHDAY", [])
    bysetpos = rrule.get("BYSETPOS", [])

    if freq in ("daily", "yearly"):
        if byday or bymonthday or bysetpos or rrule.get("BYMONTH"):
            return None
    elif freq == "weekly":
        if bymonthday or bysetpos:
            return None
        if byday:
            if len(byday) != 1 or byday[0][0] is not None:
                return None
            if byday[0][1] != _JS_DAY_FROM_PY(dtstart):
                return None  # a different/extra weekday → not a simple weekly step
    elif freq == "monthly":
        if bysetpos:
            if len(bysetpos) != 1 or len(byday) != 1 or bymonthday:
                return None
            try:
                pos = int(bysetpos[0])
            except (TypeError, ValueError):
                return None
            if pos not in (1, 2, 3, 4, -1):
                return None
            out["bysetpos"] = pos
            out["byweekday"] = byday[0][1]
        elif bymonthday:
            if len(bymonthday) != 1 or byday:
                return None
            try:
                if int(bymonthday[0]) != dtstart.day:
                    return None  # a different day-of-month than the anchor
            except (TypeError, ValueError):
                return None
        elif byday:
            return None  # BYDAY without BYSETPOS isn't in the monthly subset

    until = rrule.get("UNTIL")
    if until:
        dt, _ = _parse_dt(str(until), {})
        if dt is not None:
            out["until"] = dt.date().isoformat()
    return out


def _add_months(d: datetime, n: int) -> datetime:
    """Add n months, clamping the day to the target month's last day."""
    month_index = d.month - 1 + n
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    last = _days_in_month(year, month)
    return d.replace(year=year, month=month, day=min(d.day, last))


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - timedelta(days=1)).day


def _nth_weekday(year: int, month: int, js_weekday: int, pos: int) -> date | None:
    """Date of the nth (1..4, or -1=last) js-weekday in month, or None."""
    if pos == -1:
        last = _days_in_month(year, month)
        for day in range(last, last - 7, -1):
            d = date(year, month, day)
            if _JS_DAY_FROM_PY(d) == js_weekday:
                return d
        return None
    if 1 <= pos <= 4:
        for day in range(1, 8):
            d = date(year, month, day)
            if _JS_DAY_FROM_PY(d) == js_weekday:
                target = d + timedelta(days=(pos - 1) * 7)
                return target if target.month == month else None
    return None


def expand_rrule(
    rrule: dict[str, Any],
    dtstart: datetime,
    *,
    window_start: datetime,
    window_end: datetime,
    exdates: set[str] | None = None,
    cap: int = FALLBACK_MAX_OCCURRENCES,
) -> list[datetime]:
    """Generate occurrence datetimes for an un-mappable RRULE within
    [window_start, window_end], preserving the anchor's wall-clock
    time-of-day (DST-stable, matching recurrence.js).

    Handles FREQ/INTERVAL, multi-BYDAY (weekly + monthly-with-ordinals),
    BYMONTHDAY lists, BYSETPOS, COUNT, UNTIL, and EXDATE. Anything it can't
    place is simply not emitted (the caller logs the series as too complex).
    """
    freq = str(rrule.get("FREQ", "")).lower()
    try:
        interval = max(1, int(rrule.get("INTERVAL", 1)))
    except (TypeError, ValueError):
        interval = 1
    count = None
    if "COUNT" in rrule:
        try:
            count = int(rrule["COUNT"])
        except (TypeError, ValueError):
            count = None
    until_dt = None
    if rrule.get("UNTIL"):
        until_dt, _ = _parse_dt(str(rrule["UNTIL"]), {})
    exdates = exdates or set()

    byday = _parse_byday(rrule.get("BYDAY", []))
    weekdays = {wd for _, wd in byday}
    try:
        bymonthday = [int(x) for x in rrule.get("BYMONTHDAY", [])]
    except (TypeError, ValueError):
        bymonthday = []
    try:
        bysetpos = [int(x) for x in rrule.get("BYSETPOS", [])]
    except (TypeError, ValueError):
        bysetpos = []

    hh, mm, ss = dtstart.hour, dtstart.minute, dtstart.second
    tz = dtstart.tzinfo

    def at_time(d: date) -> datetime:
        return datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=tz)

    # Compare in the same frame as the window bounds.
    def out_of_range(dt: datetime) -> bool:
        if until_dt is not None:
            u = until_dt
            if (u.tzinfo is None) != (dt.tzinfo is None):
                u = u.replace(tzinfo=dt.tzinfo) if dt.tzinfo else u.replace(tzinfo=None)
            if dt > u:
                return True
        return dt > window_end

    occurrences: list[datetime] = []
    seen_total = 0  # counts toward COUNT, including pre-window ones

    def emit(dt: datetime) -> bool:
        """Record an occurrence if in-window; return False to stop (cap/until)."""
        nonlocal seen_total
        if count is not None and seen_total >= count:
            return False
        seen_total += 1
        if dt.strftime("%Y%m%d") in exdates or dt.strftime("%Y%m%dT%H%M%S") in exdates:
            return True
        if window_start <= dt <= window_end:
            occurrences.append(dt)
        return len(occurrences) < cap

    guard = 0
    if freq == "daily":
        cur = dtstart
        while not out_of_range(cur) and guard < 4000:
            guard += 1
            if not emit(cur):
                break
            cur = at_time((cur + timedelta(days=interval)).date())
    elif freq == "weekly":
        # Anchor to the start of dtstart's week (Sunday, JS convention).
        wd_set = weekdays or {_JS_DAY_FROM_PY(dtstart)}
        week_start = (dtstart - timedelta(days=_JS_DAY_FROM_PY(dtstart))).date()
        wi = 0
        while guard < 4000:
            guard += 1
            base = week_start + timedelta(days=wi * 7 * interval)
            day_candidates = sorted(
                base + timedelta(days=off) for off in range(7)
                if _JS_DAY_FROM_PY(base + timedelta(days=off)) in wd_set
            )
            stop = False
            for d in day_candidates:
                dt = at_time(d)
                if dt < dtstart:
                    continue
                if out_of_range(dt):
                    stop = True
                    break
                if not emit(dt):
                    stop = True
                    break
            if stop or at_time(base) > window_end:
                break
            wi += 1
    elif freq in ("monthly", "yearly"):
        step_months = interval if freq == "monthly" else interval * 12
        mi = 0
        while guard < 1200:
            guard += 1
            base = _add_months(dtstart, mi * step_months)
            y, m = base.year, base.month
            cands: list[date] = []
            if bysetpos and byday:
                pool = sorted(
                    date(y, m, day) for day in range(1, _days_in_month(y, m) + 1)
                    if _JS_DAY_FROM_PY(date(y, m, day)) in weekdays
                )
                for pos in bysetpos:
                    idx = pos - 1 if pos > 0 else len(pool) + pos
                    if 0 <= idx < len(pool):
                        cands.append(pool[idx])
            elif byday:
                for ordinal, wd in byday:
                    if ordinal is not None:
                        nd = _nth_weekday(y, m, wd, ordinal)
                        if nd:
                            cands.append(nd)
                    else:
                        cands.extend(
                            date(y, m, day) for day in range(1, _days_in_month(y, m) + 1)
                            if _JS_DAY_FROM_PY(date(y, m, day)) == wd
                        )
            elif bymonthday:
                for md in bymonthday:
                    day = md if md > 0 else _days_in_month(y, m) + md + 1
                    if 1 <= day <= _days_in_month(y, m):
                        cands.append(date(y, m, day))
            else:
                cands.append(base.date())
            stop = False
            for d in sorted(set(cands)):
                dt = at_time(d)
                if dt < dtstart:
                    continue
                if out_of_range(dt):
                    stop = True
                    break
                if not emit(dt):
                    stop = True
                    break
            if stop or at_time(base.replace(day=1)) > window_end:
                break
            mi += 1
    return occurrences


# ── VEVENT → normalized events ─────────────────────────────────────────


def _vevent_to_normalized(props: dict[str, Any], *, now: datetime) -> list[dict[str, Any]]:
    """Turn one VEVENT's collected properties into normalized event(s).

    One event normally; a recurring VEVENT whose RRULE doesn't fit the
    subset fans out into per-occurrence events with synthetic uids (§1.4).
    """
    uid = props.get("uid")
    if not uid:
        return []  # an event with no stable UID can't be reconciled — skip
    dtstart, all_day = props.get("_start", (None, False))
    summary = props.get("summary") or "(untitled)"
    status = "cancelled" if str(props.get("status", "")).upper() == "CANCELLED" else "confirmed"

    base = {
        "uid": uid,
        "summary": summary,
        "all_day": bool(all_day),
        "location": props.get("location"),
        "description": props.get("description"),
        "status": status,
        "last_modified": props.get("last_modified"),
    }
    end_dt = props.get("_end")
    base_start_iso = dtstart.isoformat() if dtstart else None
    base_end_iso = end_dt.isoformat() if end_dt else None

    rrule = props.get("_rrule")
    if not rrule or dtstart is None or status == "cancelled":
        return [{**base, "start": base_start_iso, "end": base_end_iso, "recurrence": None}]

    mapped = map_rrule_to_subset(rrule, dtstart)
    if mapped is not None:
        return [{**base, "start": base_start_iso, "end": base_end_iso, "recurrence": mapped}]

    # §1.4 fallback — materialise the next 90 days as individual events.
    horizon_end = now + timedelta(days=FALLBACK_HORIZON_DAYS)
    # Compare in dtstart's frame: make window bounds match its awareness.
    if dtstart.tzinfo is not None:
        from datetime import timezone
        ws = now.astimezone(dtstart.tzinfo) if now.tzinfo else now.replace(tzinfo=timezone.utc).astimezone(dtstart.tzinfo)
        we = horizon_end.astimezone(dtstart.tzinfo) if horizon_end.tzinfo else horizon_end.replace(tzinfo=timezone.utc).astimezone(dtstart.tzinfo)
    else:
        ws = now.replace(tzinfo=None)
        we = horizon_end.replace(tzinfo=None)
    win_start = dtstart if dtstart > ws else ws
    exdates = props.get("_exdates") or set()
    occs = expand_rrule(rrule, dtstart, window_start=win_start, window_end=we, exdates=exdates)
    dur = (end_dt - dtstart) if (end_dt and dtstart) else None
    out = []
    for occ in occs:
        out.append({
            **base,
            "uid": f"{uid}#{occ.strftime('%Y-%m-%d')}",
            "start": occ.isoformat(),
            "end": (occ + dur).isoformat() if dur else None,
            "recurrence": None,
            "expanded_from": uid,
        })
    return out


def parse_ical(text: str, *, now: datetime | None = None) -> dict[str, Any]:
    """Parse a full `.ics` document into normalized events.

    Returns {"events": [...], "complex_series": [uid,...]} — complex_series
    names the UIDs whose RRULE was expanded via the §1.4 fallback, so the
    Node loop can log("rule too complex to map as a series").

    `now` (default: the local wall clock) anchors the fallback horizon; pass
    it explicitly in tests for determinism.
    """
    if now is None:
        now = datetime.now()
    lines = _unfold(text or "")
    events: list[dict[str, Any]] = []
    complex_series: list[str] = []
    cur: dict[str, Any] | None = None
    for line in lines:
        upper = line.strip().upper()
        if upper == "BEGIN:VEVENT":
            cur = {"_exdates": set()}
            continue
        if upper == "END:VEVENT":
            if cur is not None:
                normalized = _vevent_to_normalized(cur, now=now)
                if any(e.get("expanded_from") for e in normalized):
                    complex_series.append(cur.get("uid"))
                events.extend(normalized)
            cur = None
            continue
        if cur is None:
            continue
        name, params, value = _split_prop(line)
        if name == "UID":
            cur["uid"] = value.strip()
        elif name == "SUMMARY":
            cur["summary"] = _unescape(value)
        elif name == "LOCATION":
            cur["location"] = _unescape(value)
        elif name == "DESCRIPTION":
            cur["description"] = _unescape(value)
        elif name == "STATUS":
            cur["status"] = value.strip()
        elif name == "DTSTART":
            cur["_start"] = _parse_dt(value, params)
        elif name == "DTEND":
            dt, _ = _parse_dt(value, params)
            cur["_end"] = dt
        elif name == "LAST-MODIFIED":
            dt, _ = _parse_dt(value, params)
            cur["last_modified"] = dt.isoformat() if dt else None
        elif name == "RRULE":
            cur["_rrule"] = _parse_rrule(value)
        elif name == "EXDATE":
            for token in value.split(","):
                dt, _ = _parse_dt(token, params)
                if dt is not None:
                    cur["_exdates"].add(dt.strftime("%Y%m%d"))
                    cur["_exdates"].add(dt.strftime("%Y%m%dT%H%M%S"))
    return {"events": events, "complex_series": [u for u in complex_series if u]}
