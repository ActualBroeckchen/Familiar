# Repository organization — diagnosis + remediation plan

Written for a future session (human or Claude) picking up the "the repo is too
disorganized to help with" problem. Stage 0 is done; Stage 1 is the real work and
is specced here so it can be executed safely and incrementally.

## The diagnosis (how the "disorganized / opaque" impression is created)

A forum contributor reported the repo was too opaque to even attempt helping. The
cause is **topological and presentational, not architectural** — the code inside
each file is focused, commented, modular, and covered by ~2,500 tests. What a
newcomer actually hits:

1. **A flat wall at the root.** ~189 top-level entries, **~151 loose `.js`/`.mjs`
   files**, no `src/`. GitHub's landing view is an undifferentiated list where the
   entry point (`server.js`) has the same visual weight as a leaf helper. This is
   the dominant cause.
2. **The structure lives in people's heads, not the tree.** Clear domains exist
   (30 `voice-*`, 7 `browser-*`, 6 `gcal-*`, 5 `weather-*`, …) but are not folders.
3. **No contributor map.** `README.md` is an excellent *product/user* doc but has
   no "how the code is laid out." The only architecture doc was `docs/architecture.md`
   (deep, 2,800+ lines) and `CLAUDE.md` (626 lines, written for AI agents) — no
   short "start here."
4. **Overlapping knowledge stores with no signpost:** `docs/`, `almanac/` (61),
   `wiki/` (6, genuinely useful *user* guides — hidden), `Research/` (26). A helper
   can't tell which is authoritative.
5. **Leftover-looking artifacts:** space-in-name root docs (`Tome Mechanic.md`,
   `User Tenets.md`), a stale `PR-voice-pass-0.md`, and version-suffixed source
   names (`audio-worker.mjs` + `audio-worker-current.js` + `audio-worker-host.js`)
   that make a reader distrust the tidiness.

## Stage 0 — orientation (DONE)

Additive, near-zero risk; delivers most of the felt improvement:

- **`ARCHITECTURE.md`** (root) — the human "start here" map: five-minute tour, the
  root files grouped by domain, a directory legend, run/test commands. Points into
  `docs/architecture.md` for depth (does not duplicate it).
- **`README.md`** — a "Repository layout" legend + links to `ARCHITECTURE.md` and
  the `wiki/` user guides (so they're no longer hidden).
- **This plan.**
- Tidied the clearest stray root doc (`Tome Mechanic.md` → `docs/`).

## Stage 1 — the structural fix (IN PROGRESS): move root modules into `src/<domain>/`

**Done so far:** `src/weather/` (5 files, the pilot) and **`src/voice/` (37 files
— voice + audio + call-engine)**. Both green (full suite + `audit:wiring`, zero
stale refs). A reusable migration script lives at `scripts/migrate-domain.mjs` — it
resolves every relative specifier (`from`, `import()`, `export … from`,
`new URL(…, import.meta.url)`) against the old layout and recomputes it for the new
location, so dynamic imports are handled too. Run it, then `git mv` the files and
fix `__dirname` repo-root paths (below).

**The voice slice added a shared `repo-root.js`** (exports `REPO_ROOT`, computed
from its own root location) — the depth-independent fix for the `__dirname`
landmine. The six voice files that built repo-root paths now import `REPO_ROOT`
instead of deriving it from `__dirname`. Prefer this over `../../` counting for
future domains.

**Test-file gotcha (bit me on voice):** `migrate-domain.mjs` rewrites *import*
specifiers everywhere, but source-scanning tests also reference moved files as
**literal path strings** — `read('voice-transcribe.js')`,
`path.join(process.cwd(), 'audio-worker.mjs')`, `['…'].map(read)`. Those need
updating too, but *surgically*: rewrite only file-READER arguments, never a
`.includes('audio-worker-current.js')` substring assertion (a blanket replace
breaks those). And don't `git checkout --` a test to undo a bad literal edit — that
also reverts the script's legitimate import rewrite. When a test pins an import
PATH (`from '…/voice-audio-features.js'`), prefer a path-flexible match
(`from '[^']*voice-audio-features\.js'`) so the next move doesn't re-break it.

**The `__dirname` lesson (do NOT skip this on the next domain):** a moved file's
`path.join(__dirname, 'tomes' | 'models/…' | 'voice-model-pins.json')` still points
*beside the file*, which after the move is `src/<domain>/tomes` — a silent runtime
break that import audits and many tests will NOT catch. After moving, grep the moved
files for `__dirname` / `import.meta.url` and add the depth hop
(`path.join(__dirname, '..', '..', …)` for a 2-deep `src/<domain>/`), or switch them
to a shared repo-root helper. The voice cluster has **seven** such files
(`call-engine.js`, `voiceprints.js`, `voice-enroll/models/pin/tagging/transcribe.js`)
plus a worker-spawn path in `audio-worker-host.js` — budget for fixing every one.

The target layout is the domain map in `ARCHITECTURE.md`. Suggested folders:
`src/core`, `src/safety`, `src/memory`, `src/voice`, `src/discord`, `src/schedule`,
`src/gcal`, `src/browser`, `src/search`, `src/vision`, `src/pondering`, `src/tomes`,
`src/warmth`, `src/sessions`, `src/ward`.

### Constraints the migration MUST respect (measured, not guessed)

- **`server.js` stays at the root.** `package.json` `main`, `start.sh`/`start.bat`,
  `stop.*`, `update.*` all reference `server.js` by root path. Keep the entry point
  where the launchers expect it (or update every launcher + `main` in the same
  commit — prefer keeping it put).
- **~413 relative-import lines** across the root modules will need rewriting. This
  is a mechanical, scripted job — never hand-edit 400 imports.
- **Dynamic `import('./x.js')` calls exist** (≥19 with literal string paths, e.g.
  `import('./voice-call-server.js')`, `import('./vision.js')`,
  `import('./audio-worker-current.js')`). A rewrite that only touches static
  `import … from` statements **will silently miss these** and they'll throw at
  runtime, not at load. Rewrite both forms, and grep `import\(` after each step.
- **`public/app.js` is a classic browser script**, not a module — it does not
  import the root modules, so the browser side is unaffected by the move.
- **`scripts/` and `tests/`** import root modules by relative path (`../x.js`) —
  they must be rewritten too, and `scripts/audit-wiring.mjs` itself scans the tree,
  so re-run it after each step to confirm it still resolves.
- **Python services (`phylactery/`, `unruh/`, `voicebox/`) are untouched** — they're
  spawned as subprocesses, not imported.

### Procedure (one domain per PR — small, reviewable, always-green)

1. Pick one **self-contained** domain. Start with **`voice/`** — it's the biggest
   visual win (~34 files) and its imports are mostly intra-domain.
2. Script the move: `git mv` each file into `src/<domain>/`, then rewrite every
   importer's specifier (static `from` **and** dynamic `import()`), plus the moved
   files' own outward imports (`./x` → `../x` or `../<other-domain>/x`).
3. Run `npm test` **and** `npm run audit:wiring`. Both must pass before the PR.
   Add a grep check for stray `import('./` referencing a moved file.
4. Bump PATCH, commit, PR, merge. Repeat for the next domain.
5. Do **not** attempt all domains in one PR — a 150-file move is unreviewable and a
   single missed dynamic import is a runtime break.

### Naming cleanups (fold into the relevant domain's PR)

- Resolve the `audio-worker*` trio: confirm which of `audio-worker.mjs` /
  `audio-worker-current.js` / `audio-worker-host.js` are live and rename so the
  names don't imply stale versions.
- Rename the remaining space-in-name root docs (`User Tenets.md`) to kebab-case
  under `docs/` and update the ~4 references (note: two are in generated `almanac/`
  and will re-garden — fix or let the next `codealmanac garden` regenerate them).
- Retire `PR-voice-pass-0.md` (stale PR note; one reference in generated almanac).

## Stage 2 — knowledge-store consolidation (optional, low urgency)

Decide one authoritative home and label the rest in `ARCHITECTURE.md` (Stage 0
already labels them):
- `docs/` = authoritative developer docs.
- `wiki/` = user guides (or push to the actual GitHub wiki and drop the mirror).
- `almanac/` = generated CodeAlmanac wiki (leave to the tool).
- `Research/` = background essays — consider `docs/research/` or an `archive/`.

## Guardrails recap

`npm test` (~2,500 tests) + `npm run audit:wiring` are the safety net for every
step. The audit already catches undocumented off-switches, dead lookups, and
duplicate dispatch keys; after a move it also proves imports still resolve.
