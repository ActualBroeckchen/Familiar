# Troubleshooting

Common ways things go sideways, and what to do about each. Most failures
fall into one of a few buckets: entity-core lost contact, the browser
can't store something, the user did something the UI allows but the
backend doesn't, or the live data drifted from what the UI cached.

If something isn't covered here, the **🩺 Generate diagnostic report**
button in the sidebar dumps a plain-text snapshot of the runtime state
that's useful to paste into a bug report.

---

## Knowledge editor / graph

### "Failed to load graph: entity-core not connected"

The MCP server is down. `thalamus.js` spawns entity-core as a child
process on Proto-Familiar startup; if it crashed or never started,
every `/api/entity/*` endpoint returns `502 { error: 'entity-core not
connected' }` and the Knowledge editor surfaces that text directly.

**Fix:** restart Proto-Familiar (`npm start`). On startup, watch the
server logs for `[thalamus]` lines — they'll say whether the child
process spawned and connected. The most common causes are:

- `deno` not on `PATH` for the shell that started Node. `start.sh`
  adds `~/.deno/bin` to `PATH`; bare `npm start` won't.
- entity-core path missing or moved. Set `ENTITY_CORE_PATH` to the
  absolute path of its `src/mod.ts` if you have a non-standard layout.
- entity-core's data directory permissions changed.

Chat still works without entity-core — `enrich()` returns an empty
string and every request goes through unenriched. But the Knowledge
editor will be unusable until the MCP child reconnects.

### Map view is empty or stuck on "Loading…"

If the toolbar's Type filter has a value, only nodes of that type are
returned and edges to nodes of other types are dropped (so the legend
matches what's drawn). Clear the filter to see everything.

If it's empty without a filter, switch to List view — if List is also
empty, the graph genuinely has no nodes (or entity-core is down; see
above). If List has rows but Map doesn't, click **Refresh**: Map view
fetches its own `/api/entity/graph/full` aggregate, and a stale browser
cache or an interrupted earlier load can leave it half-drawn.

### "No node with that label is loaded. Try refreshing."

Add-edge resolves the typed target label against the in-memory label
index, which is fed by every fetch that returned nodes. Two cases
trigger this message:

- The target really doesn't exist yet — create it via **+ Node** first.
- The target exists but was filtered out by the toolbar's Type filter
  before you opened this popover, so it isn't in the index. Clear the
  filter, click **Refresh**, then try again.

### "Multiple nodes share that label. Use the first match?"

Labels aren't unique — two nodes can share one. Add-edge picks the
first matching id and asks before proceeding. If that isn't the one
you wanted, rename one of the duplicates (open it via List view and
change the label) so the next resolve picks the right id.

### Editing edits the wrong edge

If you have the popover open and another editor changes the underlying
graph (the LLM running an edit tool, a second tab, a direct DB write),
the popover's cached subgraph drifts. The visible edge list shows what
was true when you opened the popover. Click **Refresh** on the toolbar
to pull a fresh copy, then re-open the node.

### Map snaps every time I edit something

It shouldn't — `keLoadGraphMap` preserves x/y for nodes that survive a
reload, and the force-directed simulation only re-runs on a genuinely
fresh map. If yours is shaking on every save, you likely changed the
Type filter or the set of visible nodes changed enough that most of
the previous positions are gone. Click Refresh once to relax the
layout, then keep editing.

### Hovering over an edge doesn't light it up

Edge hit-test uses the same Bézier curve we render (16-segment
polyline approximation), with ~6 screen-pixels of tolerance scaled by
zoom. Two cases still miss:

- Very low zoom (< 0.4×) — the edge is 1 px thick on screen and the
  6-px tolerance shrinks proportionally. Zoom in.
- An edge overlapping a node — node hit-test wins. Hover off the dot
  to surface the edge underneath.

### Map labels overlap and become unreadable

Intentional — labels only show for the hovered node at default zoom.
Past ~1.4× zoom every dot's label is drawn alongside; zoom out first
if it gets too dense.

---

## Modals

### Backdrop click doesn't close the Knowledge / Tomes editors

Intentional. A click outside the modal used to dismiss it, but the
event fires when a drag (canvas pan, resize-handle drag, popover
drag) ends past the modal edge — which is exactly when you don't want
the window to vanish. Only the ✕ closes them.

### Modal size doesn't persist between sessions

`bindResizableModal` writes the size to `localStorage` keys
`pf-knowledge-modal-size`, `pf-tome-entries-modal-size`, and
`pf-lore-editor-modal-size`. If you're in private / incognito mode or
have site storage disabled, every open starts at the default size.
Not a bug, just a browser policy.

### Modal opens at an unusably tiny size on a small screen

The CSS clamps `width` and `height` via `max-width: 95vw` /
`max-height: 92vh`. If a previous session saved a width larger than
the current viewport, the rendered size gets clamped and the
ResizeObserver eventually overwrites the saved value with the clamped
one — self-correcting within one resize cycle. If it's stuck, clear
the storage key from DevTools (`localStorage.removeItem('pf-knowledge-modal-size')`).

---

## Snapshots & undo

### "I deleted something I shouldn't have"

Every destructive op auto-snapshots first. Open Knowledge editor →
**Snapshots** tab → Restore the snapshot from just before your delete.
Restoration overwrites the current memory / identity / graph state
wholesale, so anything created *after* the snapshot is lost — copy
recent edits to a scratch file first if they matter.

Creates (new node, new edge) do **not** auto-snapshot — they're
additive and reversible by deleting the thing you just made.

### Snapshots tab shows an old entry I want to keep forever

entity-core prunes snapshots older than `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS`
(default 30 days). Bump that env var before starting Proto-Familiar
if you need longer retention.

---

## LLM / chat

### LLM seems to ignore my recent Knowledge editor changes

`thalamus.enrich()` runs once per `/api/chat` request and rebuilds the
graph / memory / identity block from current entity-core state. So the
next message after an edit reflects the change — but the current
turn's reply is already in flight with the old context. Send another
message (anything; "ok" works) to get a fresh enrichment.

### Tool calls fail with "entity-core not connected"

Same root cause as the Knowledge editor failure — see above. The LLM
will see the error message in the tool result and can either retry
later or carry on without that knowledge surface.

---

## Sessions & memorization

### Memorize button does nothing

Memorization is a queued server-side job. Check the server logs for
`[memorize]` lines; if the queue is full or the worker is stuck on a
failing job (exponential backoff), the next submission sits in the
queue. The queue file is `tomes/.memorization-queue.json` — safe to
delete if it's wedged (you'll lose pending jobs).

### Session Memories tome is missing

Auto-created on the first successful memorization. If you've never
memorized anything, it won't exist yet.
