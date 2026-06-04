# Unruh

Temporal-context cognitive module for Proto-Familiar. Sibling
specialist to entity-core, mediated by `thalamus.js`.

For the design rationale read [`../docs/unruh-design.md`](../docs/unruh-design.md).
For the milestone-by-milestone implementation plan read
[`../docs/unruh-implementation-plan.md`](../docs/unruh-implementation-plan.md).

## Status

Milestones 1–6 shipped; M7 (standing-value bridge to entity-core) is
the in-progress milestone. The implementation plan has the full
milestone breakdown and task-level status.

## What Unruh exposes today

### Tools the Familiar can call directly

These appear in `BUILTIN_TOOLS` in `public/app.js` and are wired
through to Unruh via `/api/temporal/*` server endpoints:

| Tool | What it does |
|---|---|
| `schedule_add_event` | Record a one-time appointment |
| `schedule_add_task` | Record a task (open-ended or deadline-bound) |
| `schedule_add_reminder` | Set a time-triggered banner reminder |
| `schedule_add_phase` | Add a named daily-routine phase (recurs by time-of-day) |
| `schedule_resolve` | Mark a task/event/reminder done, cancelled, or carried forward |
| `interest_bump` | Nudge the weight of a topic of interest |
| `interest_set_standing` | Promote a topic to an always-on standing value |

### Server-side tools (not directly callable by the Familiar)

These are called by background workers or by `thalamus.js` on every
chat turn, not by the LLM directly:

| Tool | Who calls it |
|---|---|
| `health_check` | Startup / diagnostics |
| `temporal_context` | `thalamus.js enrich()` — builds the `[Temporal Context]` block injected into every prompt |
| `schedule_add_edge` | Available for future server-side use; no current caller |
| `schedule_get_window` | `thalamus.js` → `temporal_context` |
| `schedule_update_node` | `thalamus.js getScheduleWindow` path (available; no current LLM-facing wrapper) |
| `schedule_delete_node` | `thalamus.js deleteScheduleNode` (available; no current LLM-facing wrapper) |
| `reminders_due` | `reminders-loop.js` every 30 s |
| `reminders_health` | `reminders-loop.js` — overdue-growth watchdog |
| `interest_record` | `thalamus.js recordInterest` / `bumpInterest`, called from `/api/interest/engage` |
| `interest_bookmark` | Available for future use; no current caller |
| `interest_demote_standing` | `thalamus.js` M7 bridge — demotes standing values whose entity-core anchor is gone |
| `interest_list` | `thalamus.js listLiveInterests` → pondering-loop topic picker |
| `session_set_handoff` | `thalamus.js recordHandoff` at session end |
| `session_get_handoff` | `thalamus.js getHandoff` |
| `session_mark_handoff_consumed` | `thalamus.js markHandoffConsumed` after first surfacing |

## Local dev

Requirements: [`uv`](https://docs.astral.sh/uv/) ≥ 0.4 (handles
Python ≥ 3.11 itself).

```sh
cd unruh
uv sync
uv run python -m unruh    # speaks MCP on stdio; Ctrl-D to exit
uv run pytest             # run the test suite
uv run python -m unruh seed-routine        # seed the default daily routine
uv run python -m unruh seed-routine --replace  # rewrite today's phases
```

You won't normally run it by hand — Proto-Familiar's `thalamus.js`
spawns it as a stdio child on startup. The launchers (`start.sh`,
`start.bat`, `Proto-Familiar.command`) detect a missing `.venv/` and
run the installer automatically.

## Layout

```
unruh/
├── pyproject.toml          # uv-managed project
├── unruh.toml              # runtime config stub
├── data/                   # gitignored — SQLite lives here (unruh.db)
├── src/unruh/
│   ├── __init__.py
│   ├── __main__.py         # `python -m unruh` entry (server + seed-routine)
│   ├── server.py           # MCP server + all tool definitions
│   ├── db.py               # SQLite connection, migrations runner
│   ├── schedule.py         # schedule-layer logic (events/tasks/phases/reminders)
│   ├── interest.py         # interest-layer logic (weights, decay, standing values)
│   ├── handoff.py          # session handoff (intent + open threads)
│   ├── seed.py             # daily-routine seed loader
│   ├── seed_routine.json   # default phase anchors (edit to reshape the routine)
│   └── migrations/         # plain SQL migration files (0001_initial, 0002_handoff)
└── README.md
```

## Adding a tool

Tools are declared in `src/unruh/server.py` using the FastMCP
decorator pattern:

```python
@mcp.tool()
def some_tool(arg: str) -> dict:
    """One-line description Thalamus may surface in its logs."""
    ...
```

Keep return-shape changes additive — Thalamus reads these payloads.
If the tool should be Familiar-callable, also add a `BUILTIN_TOOLS`
entry and an executor in `public/app.js`, plus a `/api/temporal/*`
route in `server.js`.
