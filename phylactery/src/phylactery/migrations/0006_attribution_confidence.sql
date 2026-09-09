-- Attribution confidence: how sure the Familiar is about WHO a memory is about,
-- kept SEPARATE from `confidence` (how sure the thing happened). The extraction
-- pass sets it low when a referent/target/actor is unresolved; recall
-- DOWNWEIGHTS a low-attribution memory in ranking rather than dropping it, so a
-- solid-but-fuzzily-attributed fact survives (recoverable by a later sweep)
-- instead of being pinned to the wrong person. Nullable: existing rows and any
-- write that omits it are treated as fully attributed (weight 1.0), so nothing
-- old is retroactively downweighted.
ALTER TABLE memories ADD COLUMN attribution_confidence REAL;
