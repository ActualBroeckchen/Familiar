"""Entry point for `python -m phylactery` and `uv run python -m phylactery`.

Subcommand dispatch:
  phylactery              — run the MCP server on stdio (default)
  phylactery migrate-ec   — one-time entity-core migration (Pillar F)
"""

from __future__ import annotations
import sys


def main() -> int:
    args = sys.argv[1:]
    if not args:
        from phylactery.server import main as server_main
        server_main()
        return 0

    cmd, *rest = args
    if cmd == "migrate-ec":
        print("entity-core migration not yet implemented (Pillar F)", file=sys.stderr)
        return 1
    if cmd in {"-h", "--help", "help"}:
        print("usage: python -m phylactery [migrate-ec]")
        print("  (no subcommand)  run the MCP server on stdio")
        print("  migrate-ec       one-time entity-core → Phylactery conversion")
        return 0

    print(f"unknown subcommand: {cmd!r}. Try `python -m phylactery --help`.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
