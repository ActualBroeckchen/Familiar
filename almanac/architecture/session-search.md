---
title: Session Search
topics: [architecture, memory-and-knowledge, session-search]
sources:
  - id: session-search-js
    type: file
    path: src/sessions/session-search.js
  - id: cerebellum-search
    type: file
    path: cerebellum.js
    note: "search_conversation and recall tool implementations"
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
    note: "Tool module registration"
---

# Session Search

Session search is how the Familiar finds what was literally said in a conversation, as opposed to what was inferred and stored in memory. Two distinct tools serve two distinct needs: `search_conversation` reads the raw session transcript, while `recall` searches Phylactery's distilled memories. The distinction is load-bearing: the tool descriptions tell the Familiar which to reach for depending on whether it needs verbatim words or extracted facts [@cerebellum-search].

## Why two search modes

The motivating case is the [noticing](noticing) loop closing an overdue projection: "did my human already tell me how the appointment went?" [@session-search-js]. The ward's answer often carries none of the event's keywords — "wasn't as scary as I thought" contains no mention of "doctor" or "appointment" [@session-search-js]. Pure keyword search cannot find such an outcome. The tool therefore accepts either:

- **query**: words we'd likely have used, working when the ward named the thing explicitly [@session-search-js]
- **since_hours**: read back everything said in a time window, keyword-free — the reliable "did they already tell me?" check for cases like "since this morning" [@session-search-js]

This two-mode design ensures noticing can distinguish between "I need the exact words on the topic of X" (use query) and "I need to know what happened in this window, regardless of keywords" (use since_hours) [@session-search-js].

## scope and privacy: ward-private access to shared conversations

`search_conversation` ONLY EVER RUNS on a private ward turn — the executor fail-closes on a gated villager turn, so its results never reach a villager regardless of what it read [@cerebellum-search]. Because resolution is private, the READ scope is not restricted to ward-private content: `isWardReadableLog` admits the ward's own chats (web + ward direct message), private voice, AND the GROUP rooms the ward shares [@session-search-js]. A group room is a space the ward is part of; an outcome the ward mentioned to friends is fair game for closing a loop in the ward's own private reflection [@session-search-js].

The one line HELD BACK is a villager's 1:1 direct message — excluded by default unless `includeVillagerDms` is explicitly set [@session-search-js]. Two reasons, both ward-signed:

1. **Content ownership**: A 1:1 DM is private to THAT villager (the content-gating boundary). A group room is a space the ward IS IN; a villager's DM is not the ward's to sweep [@session-search-js].

2. **Truth vs. privacy**: A villager's account of an event can differ from the ward's felt experience. The ward may have masked all day — a friend thinks the event "went great" while the ward was deeply drained. For closing the ward's OWN event, the ward's own account is the truer source, so the Familiar asking the ward is better than harvesting a third party's read. This is why villager-DM exclusion is a feature, not just caution [@session-search-js].

## Contrast with `recall`

`recall` searches Phylactery's distilled, semi-permanent memories using vector similarity and may return results across days or weeks [@cerebellum-search]. It respects content-gating rules and audience grants — on a gated villager turn, a villager sees only what it has been granted access to [@cerebellum-search]. `search_conversation` by contrast returns verbatim text from recent raw logs and runs only on private ward turns, so audience gating is moot — the results never leave the ward's private reasoning [@cerebellum-search].

The two tools have different retention and scope profiles: `recall` is for reaching durable extracted facts; `search_conversation` is for finding the exact words as they were spoken, in recent sessions, on the ward's own channels and shared spaces [@session-search-js].

## Implementation

`search_conversation` is part of the `core` toolset — always advertised to the Familiar on ward chat and noticing turns, never in the villager allowlist [@tool-surfacing-js].

The executor validates the turn is private, then calls `searchSessionLogs` from the session-search module [@cerebellum-search]. The search reads log files from the logs directory, filters by `isWardReadableLog`, and ranks results by query-term count (more matches first) and recency [@session-search-js]. The function is pure over the filesystem — it never throws (unreadable logs are skipped, a missing directory yields an empty result set) [@session-search-js].

Search results are returned as readable snippets, each including who said it (the ward or the Familiar), when it was said (in relative time like "3 days ago"), and the text (truncated to 240 characters) [@cerebellum-search].

## Testing

The tool is tested for keyword + time-window modes, group-in / villager-DM-out behavior (regression-confirmed it never reads a villager DM), the `includeVillagerDms` opt-in, result ranking, and empty/missing edge cases [@session-search-js].

## Related

- [Noticing](noticing) — the autonomous loop that uses `search_conversation` to check whether an outcome was already mentioned before asking.
- [Memory and Knowledge](memory-and-knowledge) — how session search fits alongside `recall`, Phylactery retrieval, Tomes activation, and other knowledge layers.
- [Phylactery](phylactery) — the distilled memory store that `recall` searches, contrasted with the raw transcript search here.
- [Session lifecycle](session-lifecycle) — where session logs are created and stored.
- [Content-based memory gating](content-gating) — how audience and topic grants apply to `recall` (but not to `search_conversation` since it runs only on private turns).
