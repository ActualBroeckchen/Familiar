---
title: "Domain Folder Layout: Moving Root Modules Into src/<domain>/"
topics: [decisions, architecture]
sources:
  - id: repo-organization-plan
    type: file
    path: docs/repo-organization-plan.md
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Domain Folder Layout: Moving Root Modules Into src/<domain>/

Proto-Familiar's Node source used to live as roughly 151 loose `.js`/`.mjs` files directly
under the repository root, with no `src/` directory at all. A forum contributor reported the
repo as too opaque to help with; the diagnosis in `docs/repo-organization-plan.md` is explicit
that this was a topological and presentational problem, not an architectural one — the code
inside each file was already focused, commented, and covered by roughly 2,500 tests, but a flat
root gave the entry point (`server.js`) the same visual weight as a leaf helper, and the
groupings a maintainer could see in file-name prefixes (30 `voice-*` files, 7 `browser-*`, 6
`gcal-*`, and so on) existed only in people's heads, not in the tree [@repo-organization-plan].
This decision record exists because the move changed where almost every source file this wiki
cites actually lives, and a future agent updating an architecture page's `sources:` needs to
know the convention rather than rediscovering it file by file.

## Decision

The plan calls the root-file sprawl "Stage 0" and "Stage 1" work. Stage 0 was additive
orientation only (a root `ARCHITECTURE.md` tour, a "Repository layout" legend in `README.md`);
Stage 1 is the structural fix and is recorded here as complete: root modules were moved into
`src/<domain>/` folders, one self-contained domain per pull request, each shipped only after the
full test suite and `npm run audit:wiring` passed green with zero stale references
[@repo-organization-plan]. All 16 domains are done — `voice`, `browser`, `schedule`, `safety`,
`pondering`, `memory`, `gcal`, `tomes`, `vision`, `sessions`, `village`, `weather` (the pilot),
`discord`, `warmth`, `ward`, and `search` — taking the repository root from about 151 `.js`/
`.mjs` files down to about 21 [@repo-organization-plan].

The roughly 21 files still at the root are there **by design**, not as leftover unmigrated
work: the entry point `server.js` (pinned by `package.json`'s `main` field and by the
`start`/`stop`/`update` launcher scripts), the thalamus/cerebellum inward-outward split
described in [Architecture](../architecture), `organs.js`, and cross-cutting helpers such as
`macros.js`, `providers.js`, `provider-models.js`, `llm-call.js`, `injection-guard.js`,
`tool-surfacing.js`, `core-prompts.js`, `slug-ids.js`, `relative-time.js`, `settings-merge.js`,
`entity-ref.js`, `phylactery-result.js`, `message-sanitize.mjs`, and `updater.js`
[@repo-organization-plan]. These stay next to `server.js` rather than forcing every importer of
core, repo-wide code to churn for a marginal readability gain; the plan notes a future
`src/core/` is possible with the same recipe but is not required.

Each domain move is a **pure relocation**: `scripts/migrate-domain.mjs` resolves every relative
specifier (`from`, dynamic `import()`, `export … from`, and `new URL(…, import.meta.url)`)
against the old path and rewrites it for the new one, so a `git mv` plus that script covers both
static and dynamic imports [@repo-organization-plan]. This mechanical framing matters beyond
tidiness: CLAUDE.md's safety-critical-code rule normally requires explicit human sign-off before
any behavioral change to the crisis-detection, threat-tracking, and noticing files, but carves
out relocation by name — "a pure relocation with byte-identical behavior is fine" — which is why
the `src/safety/` move could ship without a ward sign-off even though it touched
`crisis-signals.js`, `threat-tracker.js`, and `silence-triage-loop.js` [@claude-md].

Two hazards recur across the domain moves and are worth keeping in mind when reading code in a
newly-moved folder: a file that builds a `path.join(__dirname, …)` repo-root path (for example
into `tomes/` or a model directory) silently breaks after the move unless the depth hop is
added or the code switches to the voice domain's shared `repo-root.js` helper
(`REPO_ROOT`, computed independent of call depth); and source-scanning tests that reference a
moved file as a **literal path string** (`read('voice-transcribe.js')`) need surgical updates,
distinct from a blanket string replace that would also corrupt unrelated substring assertions
[@repo-organization-plan].

## Status

Stage 1 is complete for all 16 listed domains. Stage 2 — consolidating the overlapping
knowledge stores (`docs/`, `almanac/`, `wiki/`, `Research/`) behind one labeled, authoritative
home — is documented as optional and low-urgency, and has not started [@repo-organization-plan].
A separate root-doc naming cleanup (renaming the space-in-name `User Tenets.md` and retiring the
stale `PR-voice-pass-0.md`) is planned but not yet done as of this decision; both files still
exist at their original root paths.

## Consequences

Every architecture, decision, and reference page in this wiki that cites a moved file's source
path now points at `src/<domain>/<file>.js` instead of the old bare root filename. A page whose
`sources:` entry still names a bare filename for one of the 16 migrated domains is stale and
should be corrected to the `src/<domain>/` path before the citation is trusted. Bare root
filenames are still correct for the roughly 21 core files enumerated above (`server.js`,
`thalamus.js`, `cerebellum.js`, `organs.js`, `llm-call.js`, `injection-guard.js`,
`phylactery-result.js`, and the others in that list) — do not "fix" those paths into a `src/`
form they do not have.

Prose that names a file by its bare basename (`` `discord-gateway.js` ``, `` `village.js` ``)
remains accurate regardless of which folder it lives in, since the basename itself did not
change during the move; only the `path:` field in a page's frontmatter `sources:` list needs the
`src/<domain>/` prefix. If a future domain move happens (a `src/core/` split, or a further split
of the ~21 remaining root files), the same recipe applies: one domain per pull request, driven
by `scripts/migrate-domain.mjs`, verified by the full test suite and `npm run audit:wiring`, and
followed by another wiki gardening pass to correct any `sources:` paths the move invalidates.
