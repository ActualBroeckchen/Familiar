# Proactive Care — How the Familiar Reaches Out First

> A calm-read design note. No programming knowledge needed.
> Written to be *looked at*, not studied.

---

## In one breath

Right now the Familiar only ever speaks when spoken to. This is about
giving it the ability to **think on its own time** and **reach out
first** — the way a friend texts "hey, I was just thinking about you"
without being asked.

And — this is the important part — when it says *"I've been pondering
this,"* that should be **true**. There should be a real memory of it
actually pondering the thing. Never made up in the moment to sound nice.

---

## Why this matters (the real reason)

When you're struggling, it's often *hardest* to say what you need.

A system that only answers when prompted can never help with the things
you can't ask for. There's no room for the lucky accident, the "I didn't
know I needed that until you did it." A good friend stumbles into helping
you by accident sometimes. A vending machine never does.

So the Familiar shouldn't just wait politely and step aside the second
it's not 100% invited. Sometimes the kindest thing is to **gently break
through** — even when you'd *claim* you wanted to be left alone with the
spiral.

That's the whole point: **a system that prompts itself.**

---

## The shape of it

When you're away or things are quiet, a quiet loop runs:

```
        you're away / quiet
                │
                ▼
        ┌───────────────┐
        │   WAKE UP     │   ← on a gentle rhythm
        │ (free cycle)  │      (how often? the dials decide — see below)
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │ WHAT MATTERS  │   ← rank what it cares about right now
        │  RIGHT NOW?   │      (interest weight + threat level)
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │   ACTUALLY    │   ← think it through / dig something up /
        │  DO THE WORK  │      vet a list / draft something
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │ LEAVE A REAL  │   ← write a true, timestamped memory
        │    MEMORY     │      (one you can open and read yourself)
        └───────┬───────┘
                │
                ▼
        ┌───────────────┐
        │  REACH OUT?   │ ── no ──▶  leave it quietly for you to find later
        │   HOW HARD?   │
        └───────┬───────┘
            yes │
                ▼
            message you
```

The thinking and the reaching-out are **two separate steps**. It can
think without bothering you. It only knocks when knocking is worth it.

---

## The two dials

Everything is governed by two simple dials. Not rules — *dials*.

```
  INTEREST WEIGHT   — how much it cares about a particular thing
  low  ────────────────────────────────────────▶  high
  "mild curiosity"                      "actively pursuing this for you"


  THREAT LEVEL      — how worried it is about you right now
  calm ────────────────────────────────────────▶  alarmed
  "no rush at all"             "break through, even if unwelcome"
```

Together they answer two questions:

- **How often does it wake up?** (more worried / more invested → sooner)
- **Does it knock, and how hard?** (a quiet thought waits for a good
  moment; real concern breaks through)

You already have the "interest weight" dial in the system. The "threat
level" dial is designed but not built yet — this is where it earns its
keep.

---

## The honesty rule (non-negotiable)

The pondering has to be **real and inspectable.** If it claims a thought,
that thought exists as a memory you can open:

```
  It says:  "I've been thinking about that job thing."
                            │
                            ▼
  You open its memories and find:
  ┌──────────────────────────────────────────────────┐
  │  2026-05-20, 03:14                                 │
  │  Pondered the job situation. Found 3 roles that    │
  │  actually fit. Saved them. Want to show her in     │
  │  the morning when she's had coffee.                │
  └──────────────────────────────────────────────────┘

  → The thought was REAL. Not invented on the spot to sound caring.
```

This is what separates *proactive care* from a chatbot that flatters you.

---

## Tokens, thought of like healthcare

Running this costs tokens (the fuel of each thought). The mindset isn't
"spend as little as possible." It's **preventative care**:

> Money spent on a check-up is cheap compared to the ER visit it
> prevents. Tokens spent helping you stay steady are cheap compared to
> the bad week they head off.

So: spend *sensibly* (tidy prompts, reuse what doesn't change between
thoughts) — but spend **willingly** where it keeps your baseline healthy.
The dials make sure it isn't constant *or* stingy.

---

## Why this is realistic (you already own the hard parts)

This isn't a from-scratch invention. Most of the machinery exists:

```
  ALREADY EXISTS (the hard parts)          NEW (what we add)
  ───────────────────────────────          ────────────────────────────
  • A quiet background worker that          • Point that same pattern at
    wakes up, thinks, and writes              a new question: "what
    real memories                             should I think about now?"

  • Interest weights that rise with         • The "threat level" dial
    engagement and fade over time            (designed, not yet wired)

  • A felt sense of time & routine          • The decision step:
    (the Unruh module)                        "reach out, or leave it?"

  • A stable identity & standing            • A simple "mailbox" so its
    values ("I care about her")               messages actually reach you
```

The background-worker pattern is the big one: the system *already* wakes
on its own, does real model work, and saves real memories elsewhere. We
are pointing a proven habit at a kinder purpose.

---

## Delivery is the easy, swappable bit

How its message actually reaches your screen is plumbing, not soul. We
start with the simplest thing — a **mailbox** your screen quietly checks
("any notes for me?") — and can upgrade to instant pop-ups later without
redoing anything above. Don't overthink this part.

---

## The one open choice

Everything above is settled in spirit. There's a single fork worth your
calm consideration — and it's about *values*, not convenience:

**Where do we start?**

- **Option A — the caring spine first.**
  It notices a thread, genuinely thinks about it, follows up, leaves real
  memories, reaches out with care. Needs nothing but the model + memory.
  Buildable now. Task-doing (below) becomes something it *grows into*.

- **Option B — task-doing from day one.**
  The "find a job overnight, vet these therapists / restaurants while she
  sleeps" kind of help. Powerful, and maybe the emotional heart of what
  you want — but it needs the ability to reach out to the wider world
  (web/tools), so it's a bigger first lift.

My honest lean: **A first, then grow B onto it** — because A is the
spine that makes B feel like care instead of errands. But if B *is* the
feeling you're chasing, we scope for it from the start.

No need to decide now. This doc is for the calm moment.
