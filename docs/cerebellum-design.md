# Cerebellum — Design Document

## What It Is

Cerebellum is the Familiar's motor module — the single owner of everything flowing **outward**: tool execution, message delivery, escalation. It is the efferent counterpart to Thalamus, which owns everything flowing **inward** (identity, memory, graph, temporal context).

It is not an MCP child like Phylactery or Unruh. It is a Node-side module (`cerebellum.js`) that sits between the Familiar's decisions and the world those decisions touch — files, schedules, webhooks, other humans.

---

## Why It's Needed

Before cerebellum existed, the system was asymmetrical. The inward side was built and deliberate: Thalamus as a plural-peer mediator, parallel fan-out, independent degradation. The outward side was scattered — reflexes soldered directly into the spine:

- **Tool execution lived in the browser.** The registry, the executors, and the multi-round loop were all in `public/app.js`, with each round bounced back to the server as a fresh request. The browser was, literally, the Familiar's hands — close a tab and the Familiar couldn't act.
- **Delivery was pull-only.** The outbox was drained by browser polling. No tab open meant reminders and check-ins silently went nowhere.
- **The highest-stakes code was inlined in `server.js`.** Triage deliberation, trusted-contact delivery, and escalation deadlines sat tangled with HTTP lifecycle — the hardest possible place to test the code that most needs testing.

Two of these were safety problems, not just architecture problems. An unseen check-in converted "deferred escalation with a user veto" into "delayed escalation with no veto" — the acknowledgement window counted down against a warning the human never saw. And any future channel (Discord is the named next step) would have had to duplicate the executor and delivery logic wholesale, guaranteeing drift in exactly the code that must not drift.

---

## The Core Insight

A body needs symmetry. Perception without a motor system is a patient describing the room; action without a perceptual frame is a reflex arc. The Familiar already had a proper sensory side — what it needed was one place where *acting* lives, with the same virtues the sensory side already had: plural backends, independent failure, observable behavior.

The name is apt beyond the metaphor's surface: the biological cerebellum doesn't *decide* to move — it coordinates movement that was decided elsewhere. Same here. Chat turns, autonomous loops, and triage decide; cerebellum executes and delivers. It never assembles prompt context, and Thalamus never executes actions. That boundary is load-bearing and deliberately strict.

---

## The Boundary with Thalamus

**Thalamus = perception. Cerebellum = action. Neither does the other's job.**

They share one nervous system, though: Thalamus owns the MCP client connections to Phylactery and Unruh, and it is the single enforcement point for the rule that direct writes to identity or memory MUST go through Phylactery's MCP. Cerebellum never opens its own connections — every tool executor that writes rides Thalamus's exported wrappers (`createMemory`, `addScheduleNode`, …). One enforcement point, not two.

The dependency arrow points one way: cerebellum imports from thalamus, never the reverse, and neither imports `server.js`. Where cerebellum needs a capability that server.js owns (the tome-file storage layer behind `save_to_tome`), server.js hands it in at boot via `initCerebellumTools()` — capability injection instead of an import cycle.

The autonomous loops (pondering, reminders, silence triage) deliberately stay **outside** cerebellum. They are *initiators*: they decide that something should happen. When that something must reach the human or a contact, they hand it to cerebellum instead of doing delivery inline.

---

## Tool Dispatch

Cerebellum owns the complete tool surface:

- **`BUILTIN_TOOLS`** — the registry of tool definitions, in the Familiar's first-person voice (entity-as-subject), with raw `{{user}}`/`{{char}}` macros sent to the provider unsubstituted.
- **`TOOL_EXECUTORS`** — the server-side implementations. Knowledge writes ride Thalamus's wrappers; deliveries ride cerebellum's own delivery layer; the success strings match what the old client-side executors returned, so the Familiar's experience of its own tools didn't change when they moved.
- **`executeToolCall()`** — the dispatch wrapper, with one hard guarantee: **it never throws into the chat path.** A peer being down, malformed arguments, a buggy executor — all become structured failure strings *into the loop*, where the model can read them and adapt. Graceful degradation here is a rule, not a habit (see CLAUDE.md).

**Custom tools are advertise-only.** The user can paste definitions; the model sees them and may call them; calls return a structured "not implemented" notice. This is a deliberate pre-MVP posture — useful for prototyping what the Familiar *would* do — flagged in the Settings UI. A real extension point needs a decision about where user-supplied executors run and what their security boundary is, and that decision hasn't been made yet.

---

## The Tool-Call Loop

One user message = one `/api/chat` request, no matter how many tool rounds the model takes. The loop runs inside the server's chat handling:

1. The app opts in with `runToolLoop: true`; the server composes the tools array (built-ins + custom).
2. When the provider answers `finish_reason: 'tool_calls'`, cerebellum executes the calls, the results are appended, and the provider is re-called — up to 5 rounds.
3. Each round is surfaced to the client as a `_toolRound` SSE event (or collected into a `_toolRounds` array when non-streaming) so the browser can render the collapsible call/result blocks without executing anything.

Three properties of the loop matter:

- **Enrichment runs once per user message.** The old client-driven loop re-ran the full enrichment fan-out on every round; the server-side loop reuses round 0's context. Cheaper and more consistent.
- **The `[Now]` time anchor is re-appended as the LAST message on every round**, so the freshest "what time is it" stays at maximum salience even as tool traffic grows the conversation tail.
- **Internal provider re-calls don't count against the chat rate limit.** The limit guards user-initiated requests; the loop's re-calls are upstream fetches, invisible to it.

The non-streaming loop (`runToolCallLoop`) lives in cerebellum and is fully injectable for tests. The streaming variant lives in `/api/chat` itself — it is SSE plumbing (pass-through deltas, event interleaving, `[DONE]` suppression), which is transport, not motor logic. Splitting it that way keeps the testable judgment in cerebellum and the wire format in the HTTP layer.

The browser, in turn, became a thin channel: it renders what happened and persists the same message shapes as before (old session histories render identically). That thinness is the point — a channel that only *renders* is a channel Discord can replace.

---

## Channel Adapters and Delivery Records

Delivery follows the same plural-backend pattern Thalamus uses for perception. An adapter is small:

```
{ name, deliver(item) → { ok, error? } }
```

`activePushAdapters()` returns whichever channels are configured right now — today that's `discord-dm`, present when the bonded human has set their own webhook in Settings. Future channels (WhatsApp, native notifications) slot in the same way modules slot into Thalamus.

`enqueueAndDispatch()` is the default enqueuer for everything user-facing: it enqueues into the outbox, then pushes through every adapter, recording the per-channel outcome on the item:

```
delivery: { 'discord-dm': { status: 'delivered' | 'failed', at, error? } }
```

Three invariants:

- **A failing adapter never blocks the others.** Each delivery attempt is isolated; failures are recorded, not propagated.
- **Dedup short-circuits the push.** An item the human already has pending isn't re-pushed at them.
- **"Did my human actually receive this" is observable** — by the code (escalation deadlines read the record) and by the Familiar (delivery notes render into its prompts).

The browser surface deliberately stays pull-based (polling + chat injection); its confirmation signal is the acknowledge. Push and pull are complementary: push reaches the human when no tab is open, pull is where conversation actually happens.

---

## Escalation and the Veto Window

The trusted-contact path is the most consequential thing cerebellum does, and its design is shaped by one principle: **the human can only veto what they could have seen.**

When triage decides a trusted contact may be needed, delivery is *deferred*: the check-in goes to the human first, and the contact is only reached if the acknowledgement window passes without a response. The window (`CONTACT_ESCALATION_DELAY_MS`: severe 30min / high 2h / moderate 6h) is the veto.

Where the clock starts is the design decision that matters:

- **The clock starts at first CONFIRMED push delivery** of the check-in — not at enqueue. An unseen warning is not a warning.
- **Fallback to the enqueue clock** when no push channel is configured, when the push failed, or when no delivery record lands within a 10-minute grace window. A dead adapter can never block escalation forever — at the severe tier, "wait indefinitely because Discord is down" is the catastrophic failure mode, not the safe one.
- Items created before this semantics existed carry a precomputed deadline and are honored as-is.

Two more structural guarantees:

- **No covert contact.** Every outbound to a third party mirrors an `outbound_alert` into the human's outbox — *even when delivery failed* — and the mirror itself goes out the push channel. This is enforced inside `deliverToTrustedContact`, not by trusting callers.
- **Double-delivery guard.** `pendingContact.delivered` is written *before* the async fire, so a second tick during an in-flight delivery cannot fire twice.

And the piece that closes the loop cognitively: **delivery failures are visible to the Familiar.** The triage deliberation lists its unacknowledged check-ins with their delivery notes, and the chat-path pending-notices block carries the same. "My message never reached them" and "they're ignoring me" are different signals, and the Familiar gets to weigh them differently — silence after an undelivered message is not the same silence.

---

## Triage Deliberation

`decideTriageViaLLM` lives in cerebellum because it is the decision-to-action seam: it assembles the deliberation prompt (identity context, the `[Now]` anchor, recent conversation with relative times, threat signals, trusted contacts, pending check-ins with delivery state, candidate tasks) and parses the `wait` / `reach_out` / `contactHuman` decision.

Everything in CLAUDE.md's proactivity section applies to this prompt with full force: both costs named at equal weight, no bias-toward-quiet language, proactivity framed as identity. The deliberation is the Familiar deciding, in voice, what a caring companion does right now — not a checklist granting permission to speak. The 1.5-hour failure this codebase remembers happened in exactly this code path; that is why the prompt, the thresholds, and the escalation semantics are all on the safety-critical sign-off list.

---

## Safety Posture

Cerebellum contains the highest-stakes code paths in the system. Three rules govern work on it:

1. **Behavioral changes require human sign-off** (CLAUDE.md, "Safety-critical code requires human sign-off"). Relocations with byte-identical behavior are fine; anything that alters when or whether the Familiar can act on a human's safety — stop and ask.
2. **Everything is injectable, so everything is testable.** Clocks, outbox functions, adapters, settings readers, fetch — all parameters with production defaults. The escalation deadlines, the double-delivery guard, the no-covert-contact mirror, and the loop cap are covered by deterministic tests in `tests/cerebellum.test.mjs`, no real webhooks or timers involved.
3. **No failure escapes into the conversation.** Tool failures become readable strings; adapter failures become delivery records; a down peer renders as absence. The chat path cannot be taken down from here.

---

## Relationship to Other Systems

- **Thalamus** — perception-side counterpart and the MCP gateway cerebellum writes through. Strict boundary, one-way dependency.
- **The autonomous loops** — initiators. They decide; cerebellum delivers. The reminders and triage loops enqueue through `enqueueAndDispatch`; triage's deferred escalations are fired by `checkAndFirePendingContacts` each tick.
- **`server.js`** — routes and loop boot only. It hands cerebellum the tome-storage capability at boot and hosts the streaming variant of the tool loop (transport).
- **The browser** — one channel among (eventually) several: it renders tool rounds, injects outbox items into chat, and acknowledges them. Nothing executes there anymore.
- **A future Discord channel** — the proximate reason the module exists in this shape. With execution and delivery centralized, a Discord adapter gets the Familiar's full toolset and delivery records for free, instead of forking them.

---

## Current Status

Shipped as the 0.4.x milestone: the module itself with triage/delivery/escalation extracted from server.js, the server-side tool registry and loop, the channel-adapter layer with the `discord-dm` push channel, delivery records, the confirmed-delivery escalation clock, and the composite-key memory addressing contract (see architecture.md's regression-guard section).

Deferred, deliberately: a real custom-tools extension point (advertise-only until the security boundary is designed), and additional push adapters beyond Discord.
