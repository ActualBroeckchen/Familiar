# Vendored SearXNG — license notes (AGPL-3.0)

> **Not legal advice.** This is an informed engineering analysis written by a maintainer, not
> a lawyer. The reasoning below reflects the FSF's own stated interpretations of the (A)GPL and
> the plain text of the licenses, but copyleft scope is fact-specific. Before distributing
> Proto-Familiar widely, have someone qualified confirm the AGPL §13 specifics for your exact
> distribution model.

## Bottom line

Vendoring SearXNG is **fine**, and it does **not** "infect" Proto-Familiar's own code. Two facts
carry the whole analysis:

1. **Proto-Familiar is itself GPL-3.0** (top-level `LICENSE`). It is already a copyleft,
   source-available project — so shipping more copyleft source alongside it is not a new burden,
   and GPL-3.0 is explicitly *compatible* with AGPL-3.0.
2. **The managed SearXNG runs at arm's length** — a separate OS process, bound to loopback,
   spoken to over HTTP/JSON. It is never linked into our address space. Under the FSF's own
   interpretation that is *mere aggregation*, not a combined/derivative work.

So Proto-Familiar's code stays GPL-3.0; SearXNG stays AGPL-3.0; they coexist in one distribution.
What we owe is ordinary copyleft hygiene for the SearXNG component, listed below.

## The licenses involved

| Component | License | Where |
|---|---|---|
| Proto-Familiar (our code) | **GPL-3.0** | top-level `LICENSE` |
| SearXNG (vendored) | **AGPL-3.0-or-later** | `vendor/searxng/LICENSE` + per-file `SPDX-License-Identifier: AGPL-3.0-or-later` |

AGPL-3.0 = GPL-3.0 **plus §13**, the "network use" clause: if you *modify* the program and let
users interact with the modified version *remotely over a network*, you must offer those users the
Corresponding Source. GPLv3 §13 and AGPLv3 §13 are written to interoperate, so a GPL-3.0 project
aggregating an AGPL-3.0 component is a supported combination — the AGPL terms govern the AGPL part.

## Does AGPL reach Proto-Familiar's own code? No.

The copyleft "derivative/combined work" line, per the FSF's GPL FAQ, runs roughly at the process
boundary:

- **Same process / linked (shared address space):** generally one combined work → copyleft reaches it.
- **Separate processes at arm's length (fork+exec, sockets, pipes, HTTP, CLI):** generally
  *separate* works merely aggregated → copyleft does **not** reach the other side.

Proto-Familiar spawns SearXNG with `child_process.spawn`, binds it to `127.0.0.1`, and talks to it
only via its HTTP JSON API (`searxng-service.js` / `websearch.js`). That is the textbook
arm's-length pattern. Our code is not a derivative of SearXNG, and even in the contrary reading,
GPL-3.0↔AGPL-3.0 compatibility would cover the combination. Either way, **nothing forces
Proto-Familiar's own modules to become AGPL.**

## What we DO owe (for the SearXNG component)

These are the obligations that *do* attach, with current status:

1. **Ship the complete Corresponding Source of SearXNG** — ✅ done; it's vendored verbatim under
   `vendor/searxng/`, and our repo is public.
2. **Preserve its license + notices** — ✅ `vendor/searxng/LICENSE`, the per-file SPDX headers, and
   `vendor/searxng/AUTHORS.rst` are vendored intact. Do not strip them.
3. **Mark our modifications, with a date (GPL/AGPL §5(a))** — ⚠️ we patched
   `searx/valkeydb.py` (guarded the Unix-only `import pwd` for Windows). It carries an inline
   `# proto-familiar` marker; we strengthen it to a dated "modified by" notice (see below) so the
   §5(a) "prominent notices stating that you changed it, and giving a relevant date" is clearly met.
   Every entry on the `vendor/README.md` re-apply patch list is one of these and must keep its notice.
4. **AGPL §13 (network source offer)** — minimal in practice. Our instance is **loopback-bound,
   single-user, and headless** (only Proto-Familiar's own server hits its API; the human interacts
   with Proto-Familiar, never with SearXNG over a network). So there are effectively no "remote
   network users" of the modified SearXNG. The Corresponding Source is in any case available (public
   GPL repo). Keep SearXNG's own source-offer mechanisms intact, and **keep the instance bound to
   loopback** — exposing it to a real network is what would make §13 bite.
5. **Impose no further restrictions** — ✅ we add none.

## Vendoring vs. fetch-at-install — does it change the licensing?

**Barely.** Because Proto-Familiar is already GPL-3.0 with public source, the "we are now
distributing AGPL source" obligation is trivially satisfied either way.

| | Vendored (current) | Fetch at install from upstream |
|---|---|---|
| Who provides SearXNG's source to the user | Us (it's in our repo) | Upstream SearXNG (user pulls it) |
| Our §5(a) duty for our patch | Yes — mark it (we do) | Yes — we still apply + must mark the patch |
| Net licensing benefit of fetching | — | Marginal (shifts source-hosting upstream only) |
| **Engineering** trade-offs | +reliable/in-the-box; −repo bloat (~419k LOC), −secret-scan noise, −security-update cadence burden | +small repo; −install-time network dependency, −more moving parts, −still patch on the user's disk |

**Conclusion: choose between vendoring and fetch-at-install on *engineering* grounds, not licensing
grounds.** The AGPL does not meaningfully push us one way or the other here. (If we were closed-source
or permissively licensed, the calculus would differ — vendoring AGPL source into a proprietary product
is where teams get burned. That is not our situation.)

## Concrete to-dos (small, mostly done in this change)

- ✅ Strengthen the `valkeydb.py` modification notice to a dated §5(a) statement; mirror it on the
  `vendor/README.md` patch list.
- ✅ Declare our own license explicitly in `package.json` (`"license": "GPL-3.0-or-later"`), matching
  the `LICENSE` file, so tooling and downstream users see it without guessing.
- ☐ Keep the instance loopback-bound (already enforced in `searxng-service.js`'s generated settings).
- ☐ On every SearXNG pin bump: re-apply the marked patches and keep their dated notices (already in
  the `vendor/README.md` re-vendoring procedure).
- ☐ If Proto-Familiar is ever distributed as a binary/bundle rather than source, revisit how the
  Corresponding Source offer is presented — but as a public source repo this is already satisfied.
