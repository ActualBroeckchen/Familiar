# Known issues

A running log of bugs we've spotted but haven't fixed yet, so they don't get
lost. Newest first. When one is fixed, move it to the commit that fixes it (or
delete it) rather than leaving it here stale.

---

## Phylactery: `UNIQUE constraint failed on memory_vecs primary key` during embedding

**Spotted:** 2026-06 (web-search branch session), in the server console.

**Symptom:**
```
[phylactery] embedding failed for d202747caa19461cb25f725925c1fe55: UNIQUE constraint failed on memory_vecs primary key
```

**What it means:** Phylactery tried to insert an embedding row into the
`memory_vecs` (sqlite-vec) table for a memory whose primary key already exists —
a plain `INSERT` where an upsert / delete-first was needed. The memory itself is
presumably stored; its vector either didn't update or is stale, so that entry may
be missing/outdated in semantic recall.

**Likely cause:** a re-embedding path (editing or re-saving a memory, a
re-run, or a retry after a partial write) that re-inserts the vector by primary
key instead of `INSERT OR REPLACE` / delete-then-insert. Possibly a race between
two writers.

**Where to look:** the embedding insert in Phylactery's memory store (`./phylactery/`,
the code that writes to `memory_vecs`). Confirm whether re-embed deletes the old
vec row first, and whether the write is idempotent on the memory's PK.

**Severity:** low/medium — degrades semantic recall for the affected entry, does
not crash the chat path (the embedding failure is caught and logged). Worth fixing
because silent recall gaps are exactly the kind of thing that erodes the bond over
time.

**Status:** OPEN — not yet investigated.
