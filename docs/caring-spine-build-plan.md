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
  [ STEP 1 ]      step 2       step 3       step 4
  ── 🚧 ──▶      ─ ─ ─ ─ ─    ─ ─ ─ ─ ─    ─ ─ ─ ─ ─
   building
   today
```

We do step 1 today, all the way through to a real entry you can read,
then we pause.
