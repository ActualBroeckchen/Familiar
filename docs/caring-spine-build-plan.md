# Caring Spine — Build Plan

> A step-by-step map of how the proactive-care system gets built.
> Each step ends with something you can **see, open, and feel.**
> Stop or redirect at any step.

---

## The road, in one glance

```
  STEP 1  ──▶  STEP 2  ──▶  STEP 3  ──▶  STEP 4
  "can it     "can it       "can it      "can it choose
   think      pick what     reach        WHEN, with
   alone?"    to think      out?"        care?"
              about?"
```

Each step is small. Each step works on its own. Each one is something
you can sit with for as long as you want before saying yes to the next.

---

## Step 1 — Can it think on its own and leave a real trace?

**This is what we're building right now.**

### What we build

- A new way to ask the Familiar to **ponder one topic** as itself —
  first-person, private, honest.
- A brand-new tome file: **"Familiar's Ponderings."**
- Every ponder writes one **timestamped entry** into that tome.

### What we DON'T build yet

- ❌ No automatic waking up. We run it on demand.
- ❌ No reaching out to you.
- ❌ No threat-level dial.
- ❌ Not pulling from interest weights yet.

We're just answering the *most basic* question first: *can the Familiar
think on its own and leave a true record?*

### What you'll see when we're done

```
1. A new file appears in tomes/ named "Familiar's Ponderings".
2. Inside, one real entry — a real first-person thought.
3. Timestamped. With the topic it was pondering.
4. You can open the file in any text editor and read it.

   → The thought existed. You can prove it to yourself.
```

### How we test

- 🧪 **Plumbing tests** with a fake LLM (free — no tokens).
  Confirms the loop logic is right *before* we spend anything real.
- 💸 **One small live ponder** using your TEMP_KEY, on a topic of your
  choice (or one I suggest).

(After that we stop and look at the result together.)

---

## Step 2 — Can it pick what to think about?

The Familiar pulls its current **interest weights** from Unruh (which
you already have) and chooses what to ponder — highest weight, with a
little randomness so it isn't robotic.

Same machine as step 1. Just smarter about *what*.

---

## Step 3 — Can it reach out?

A simple **mailbox**: the UI quietly checks if there are any new
ponderings since you last looked, and surfaces them gently — "I was
thinking about this while you were away."

The pondering it surfaces is **the real one from step 1**. No making
things up in the moment.

---

## Step 4 — Can it choose WHEN, with care?

The **two dials** come online:

```
  INTEREST WEIGHT  ──▶  decides how often it wakes
  THREAT LEVEL     ──▶  decides whether to knock, and how hard
```

Quiet thought → leaves it for you to find.
High care moment → gently breaks through.

This is also where the **honesty rule** earns its keep: when it says
"I've been thinking about this," there's a real entry from step 1
backing the claim.

---

## Where we are right now

```
  step 1 ✓    step 2 ✓    step 3' ✓   step 4a ✓   step 4b ✓
  ───────     ───────     ────────    ────────    ────────
  think       pick what   reference   wake on     break
  alone       to think    in chat     own         through
              about                   cadence     with care
```

**All five steps shipped.** See:
- `docs/threat-detection.md` — comprehensive doc for the threat / care
  system (step 4b), including the off switches.
- `pondering.js`, `interest-picker.js`, `recent-ponderings.js`,
  `pondering-cadence.js`, `pondering-loop.js`, `crisis-signals.js`,
  `threat-tracker.js` — the spine modules.
- `scripts/ponder-once.mjs`, `ponder-from-interests.mjs`,
  `chat-with-ponderings.mjs`, `pondering-loop-demo.mjs`,
  `threat-demo.mjs` — CLI runners for each step.

Production wiring (server.js / thalamus.js) covers **all five steps,
end to end**:

- Steps 1–3' are integrated into the chat path (`enrich()`).
- Step 4a's autonomous loop **boots with the server by default** and
  is controlled by:
  - **Settings → Sidebar → Autonomous pondering** (UI toggle, default ON)
  - **Settings → Pondering interval scale** (1× – 10×; stretches only)
  - `PROTO_FAMILIAR_PONDERING_DISABLED=1` env var (hard off-switch)
- Step 4b's detector + tracker + framing is integrated into both the
  chat path and the autonomous loop (high threat shortens cadence;
  `[CARE CHECK]` block surfaces in replies).

**Silence-triage improvements (0.2.54-alpha):** The triage deliberation
was subsequently hardened:

- The LLM now receives the Familiar's full identity context *and* the
  most recent session messages before deciding — no blind reasoning.
- The deliberation prompt was made **neutral** (no passivity bias).
- Outreach is **sequential**: the Familiar contacts you first (outbox
  banner); trusted-contact escalation is deferred behind a deadline
  (severe=30min, high=2h, moderate=6h). You acknowledging the outbox
  item prevents escalation automatically.
- Every triage tick is appended to `logs/triage-events.jsonl` and
  readable via `GET /api/triage-events`.
- Pending triage notices are injected into the `[DYNAMIC CONTEXT]`
  block of the next `/api/chat` call so the Familiar can reference them.

**Cerebellum era (0.4.x):** the spine's delivery side moved into the
motor module — see [`cerebellum-design.md`](cerebellum-design.md). The
triage deliberation, trusted-contact delivery, and escalation
deadlines now live in `cerebellum.js` (server.js only boots the loop);
outbox items deliver as chat messages plus an optional Discord push to
the user's own webhook; and the escalation deadline counts from
*confirmed delivery* of the check-in rather than from enqueue, with
delivery failures visible to the Familiar in its deliberation prompt.
The step descriptions above record the spine as originally built and
stand as the historical record.
