"""Entry point for `python -m unruh` and `uv run python -m unruh`.

Subcommand dispatch:
  unruh                    — run the MCP server on stdio (default)
  unruh seed-routine [...] — load the default routine into the DB

Kept thin so adding a subcommand (export, dump, etc.) only adds one
elif arm here plus the subcommand's module.
"""

from __future__ import annotations

import sys


def main() -> int:
    args = sys.argv[1:]
    if not args:
        from unruh.server import main as server_main
        server_main()
        return 0

    cmd, *rest = args
    if cmd == "seed-routine":
        from unruh.seed import cli_main
        return cli_main(rest)
    if cmd in {"-h", "--help", "help"}:
        print("usage: python -m unruh [seed-routine [--replace]]")
        print("  (no subcommand)  run the MCP server on stdio")
        print("  seed-routine     load the default routine into the DB")
        return 0

    print(f"unknown subcommand: {cmd!r}. Try `python -m unruh --help`.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
