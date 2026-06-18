# Familiar-managed SearXNG — build spec

> **Status: SHIPPED (`0.7.x-alpha`).** The lifecycle (`searxng-service.js`), the toggle-followed
> supervisor, the keyless fallback, the executor backend-resolution, and the off-switch are built
> and unit-tested; SearXNG is vendored at `b5ef7ec` and the real spawn is **smoke-tested on
> Windows** (`[searxng] managed instance ready`, real search returned results, `/healthz → OK`).
> Kept as the build record. Two things differed from the original guesses: SearXNG packages with
> `requirements.txt`+`setup.py` (not `pyproject.toml`), so deps go through `uv venv` + `uv pip
> install` and the spawn invokes the venv Python directly; and `searx/valkeydb.py`'s Unix-only
> `import pwd` needed guarding for Windows (a local patch — see `vendor/README.md`, re-apply on
> every re-vendor).

## Why this exists

Web search must work the instant the human flips a checkbox — no install, no terminal, no YAML.
The people Proto-Familiar serves include those for whom any setup friction is disqualifying. So:

- **The floor is keyless and in-process** (`websearch.js` → DuckDuckGo HTML scrape). It can never
  "fail to start"; it's just an HTTP call from the Node process. This always works.
- **The optional upgrade is a Familiar-managed SearXNG.** A self-hosted SearXNG aggregates many
  engines and is sturdier than scraping a single source — but running it is exactly the friction
  we forbid. So the *Familiar* runs it: brought up when the human enables "Web search & read",
  taken down when they disable it. Zero terminal. Same toggle-followed lifecycle as the Discord
  gateway.

This is the hybrid the human chose over (a) keyless-only and (b) always-on SearXNG: keyless as the
guaranteed floor, managed SearXNG as a one-click sturdier backend that costs nothing when off.

## The shape (built)

```
  cerebellum web_search executor — resolves the effective backend:
      custom webSearchBaseUrl  ??  managedSearxngUrl()  ??  ''(keyless)
                                          │
                                          ▼
  searxng-service.js — toggle-followed supervisor (30s, like Discord)
      desiredManaged(settings) = webSearchEnabled
                                 AND no custom webSearchBaseUrl
                                 AND not PROTO_FAMILIAR_SEARXNG_DISABLED=1
                                 AND vendored source present
      reconcile(): want&&down → spawn → health-poll → publish URL
                   !want&&up  → SIGTERM → clear URL
                                          │
                                          ▼
  ./vendor/searxng/  (VENDORED third-party app, uv-managed)   ← REMAINING WORK
      uv run python -m searx.webapp, generated loopback+JSON settings.yml
```

- **Graceful degradation is absolute.** `managedSearxngUrl()` returns null whenever the instance
  isn't ready — cold start, failed spawn, missing source, crashed child, env-disabled. The
  executor then uses keyless. A managed instance can *never* break search. This is the contract.
- **No new LLM call, no chat-path coupling.** The supervisor is a background reconcile loop; the
  search executor just reads `managedSearxngUrl()`.

## What's built and tested (`0.7.1-alpha`)

- `searxng-service.js`: `desiredManaged` (pure), `reconcile` (lifecycle, injected side effects),
  `startSearxngSupervisor` / `stopManagedSearxng`, `managedSearxngUrl`, source-presence + env
  gates, generated settings, free-port pick, health-poll, child-exit → back-to-keyless.
- `cerebellum.js`: the `web_search` executor resolves custom ?? managed ?? keyless.
- `server.js`: supervisor started after the Discord gateway; torn down in the SIGTERM/SIGINT/SIGHUP
  handler.
- `tests/searxng-service.test.mjs`: desired-state matrix; spawn-on-enable / idempotent / teardown
  -on-disable; failed-spawn → keyless; child-exit → keyless.

## Remaining work (vendor + verify)

1. **Vendor SearXNG** into `./vendor/searxng/`, pinned to a specific **commit SHA** (SearXNG is a
   rolling release — no version tags; every master commit is a "release"). Clone, record the SHA
   into `./vendor/searxng/VERSION`, then strip the nested `.git` so the files are vendored (not an
   embedded gitlink). Add `vendor/searxng/` build artifacts (`.venv`, `__pycache__`, caches) to
   `.gitignore`.
2. **Spawn invocation — verified against the pinned SHA `bd73cc0`** by reading `searx/webapp.py`:
   entrypoint `python -m searx.webapp` (its `__main__` calls `run()` → `app.run(host, port)`) ✅;
   bind/port come from `settings.yml` (`server.bind_address` / `server.port`), **not** env vars —
   so `writeManagedSettings` sets them and `spawnSearxng` no longer passes the dead
   `SEARXNG_BIND_ADDRESS`/`SEARXNG_PORT` ✅; health is `GET /healthz` → `200 "OK"`, now used by
   `waitHealthy` ✅. The **one** thing still to confirm at first boot: that `SEARXNG_SETTINGS_PATH`
   (read by `searx/settings_loader`, not webapp.py) points the app at our generated settings.
3. **`ensure-searxng-deps`**: the lazy `uv sync` runs on first enable. Confirm uv resolves
   SearXNG's requirements cross-platform; gate cleanly when `uv` is absent (stay keyless).
4. **Smoke test on a real install**: enable the toggle → instance boots, `web_search` returns
   SearXNG results, disable → process exits; pull the plug mid-search → keyless still answers.

## Update cadence (recorded in CLAUDE.md)

`./vendor/searxng/` is someone else's actively-developed, web-facing app. **Check for upstream
SearXNG updates to pull on every MINOR (`0.X.0`) or MAJOR (`X.0.0`) Proto-Familiar bump**, and pull
security releases promptly. Leave it untouched on PATCH bumps. Keep `VERSION` current so the diff
is auditable.

## Safety

Not on the safety-critical care surface (crisis/threat/triage). It adds an optional backend; it
never changes *when or whether* the Familiar acts on a human's safety. The managed process is
loopback-bound, JSON-only, with a generated secret. The SSRF guard in `websearch.js` still governs
every `read_webpage`, independent of which search backend produced the URL.
