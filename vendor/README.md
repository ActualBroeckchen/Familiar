# vendor/

Third-party apps the Familiar runs, vendored into the tree so they ship "in the
box" (the same posture as `phylactery/` and `unruh/`, except these are *not* our
code). Their build artifacts and virtualenvs are gitignored; their source is
committed.

## searxng/ — vendored at `b5ef7ec` (2026-06-18)

The optional Familiar-managed web-search backend. SearXNG is a **rolling
release** — no version tags — so we pin to a specific commit SHA (recorded in
`vendor/searxng/VERSION`). Smoke-tested on Windows: `[searxng] managed instance
ready`, real search returned results, `/healthz → OK`.

### ⚠️ Local patches to re-apply after every re-clone

We carry a small local modification to SearXNG's source. **A fresh re-clone wipes
it**, so it MUST be re-applied whenever the pin moves (and re-smoke-tested):

- **`searx/valkeydb.py` — guard the Unix-only `import pwd`.** `import pwd` is
  Unix-only and crashes module load on Windows (it's in a Valkey connection-error
  path we never hit). Wrap the import in `try/except ImportError` (and guard its
  single use). Without this, the managed backend cannot boot on Windows. **Keep the
  dated `# Modified by Proto-Familiar … (AGPL/GPL §5(a))` notice** at the patch site
  when re-applying — it satisfies the copyleft change-marking requirement (see
  [`docs/searxng-license-notes.md`](../docs/searxng-license-notes.md)).

If this list grows, consider converting these into committed `.patch` files
applied programmatically during vendoring rather than hand-editing.

> **License:** SearXNG is **AGPL-3.0-or-later** (`vendor/searxng/LICENSE`). Proto-Familiar
> is GPL-3.0 and runs SearXNG at arm's length (separate process, loopback HTTP), so this is a
> compatible aggregation, not a combined work. Full analysis + obligations:
> [`docs/searxng-license-notes.md`](../docs/searxng-license-notes.md).

### Re-vendoring procedure (when bumping the pin)

```bash
# from the repo root (any OS)
git rm -r --cached vendor/searxng            # drop the old vendored tree from the index
rm -rf vendor/searxng                        # (Windows: Remove-Item -Recurse -Force vendor\searxng)
git clone --depth 1 https://github.com/searxng/searxng vendor/searxng
git -C vendor/searxng rev-parse HEAD > vendor/searxng/VERSION   # the new pin
```

Then strip the nested `.git` so it's vendored files, not an embedded gitlink:

```bash
rm -rf vendor/searxng/.git                       # macOS / Linux
```
```powershell
Remove-Item -Recurse -Force vendor\searxng\.git  # Windows PowerShell
```
```cmd
rmdir /s /q vendor\searxng\.git                  :: Windows cmd
```

**Then re-apply the local patches above and re-run the boot smoke-test** (flip the
"Web search & read" toggle, watch for `[searxng] managed instance ready`). Until
`vendor/searxng/searx/webapp.py` exists, the managed backend stays dormant and
search runs on the in-box keyless backend.
