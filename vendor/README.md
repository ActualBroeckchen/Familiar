# vendor/

Third-party apps the Familiar runs. We **don't commit their source** — it bloats
the repo (SearXNG alone was ~970 files / 419k lines). Instead the managed backend
**fetches the source on first enable**, pinned to an exact commit, and re-applies
the tracked patches under `vendor/searxng-patches/`.

## searxng/ (fetched, not committed)

The optional Familiar-managed web-search backend. SearXNG is a **rolling release**
(no version tags), so we pin to a commit SHA — recorded as `SEARXNG_PIN` in
`searxng-service.js`. When the ward enables "Web search & read" with no custom
backend URL, `searxng-service.js` clones that commit into `vendor/searxng/`
(shallow, by SHA), strips `.git`, and applies every `vendor/searxng-patches/*.patch`.
A missing `git` / no network degrades cleanly to the keyless backend (and backs off
an hour before retrying).

### Local patches (`vendor/searxng-patches/`)

These ARE committed and re-applied on every fetch:

- **`0001-valkeydb-windows-pwd.patch`** — guards SearXNG's Unix-only `import pwd`
  (and its one use site) so the webapp loads on Windows. Carries an AGPL/GPL §5(a)
  change notice; see [`docs/searxng-license-notes.md`](../docs/searxng-license-notes.md).

### Bumping the pin (on every MINOR / MAJOR Proto-Familiar bump — see CLAUDE.md)

1. Pick the new SearXNG commit; set `SEARXNG_PIN` in `searxng-service.js`.
2. Delete any local `vendor/searxng/`, let it re-fetch, and confirm the patches still
   apply (regenerate them against the new commit if upstream drifted —
   `git diff --relative=vendor/searxng <old> <new> -- vendor/searxng/searx/<file>`).
3. **Re-run the spawn smoke-test** (entrypoint / bind-port / `/healthz`).
