# Unruh

Temporal-context cognitive module for Proto-Familiar. Sibling
specialist to entity-core, mediated by `thalamus.js`.

For the design rationale read [`../docs/unruh-design.md`](../docs/unruh-design.md).
For the milestone-by-milestone implementation plan read
[`../docs/unruh-implementation-plan.md`](../docs/unruh-implementation-plan.md).

## Status

Milestone 1 (process skeleton + MCP handshake) and Milestone 2
(Thalamus second-peer wiring) are in. The server exposes:

- `health_check` — liveness ping.
- `temporal_context` — returns an empty payload; populated by later
  milestones.

## Local dev

Requirements: [`uv`](https://docs.astral.sh/uv/) ≥ 0.4 (handles
Python ≥ 3.11 itself).

```sh
cd unruh
uv sync
uv run python -m unruh    # speaks MCP on stdio; Ctrl-D to exit
```

You won't normally run it by hand — Proto-Familiar's `thalamus.js`
spawns it as a stdio child on startup.

## Layout

```
unruh/
├── pyproject.toml          # uv-managed project
├── unruh.toml              # runtime config stub
├── data/                   # gitignored — SQLite lands here (Milestone 3)
├── src/unruh/
│   ├── __init__.py
│   ├── __main__.py         # `python -m unruh` entry
│   └── server.py           # MCP server + tool definitions
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
