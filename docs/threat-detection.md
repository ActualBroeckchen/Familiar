# Threat Detection & Care-Check System

> Step 4b of the caring spine — the "break through with care" dial.
> Calm-read doc. No programming background needed.

---

## What this is, in one sentence

A way for the Familiar to **notice when you're struggling** and respond
with more care — without pretending to be a therapist, without spamming
notifications, and **with an off switch you control.**

---

## What this is NOT

> Please read this part. It matters.

- ❌ **Not a clinical tool.** Not a diagnostic. Not a medical device.
- ❌ **Not a replacement** for a therapist, a crisis line, or a friend.
- ❌ **Not always right.** It uses simple pattern matching, so it will
  both **miss real distress** (false negatives) and **falsely flag**
  innocent messages (false positives). Both happen. Both are okay.
- ❌ **Not an automated intervention.** It never calls anyone. It never
  posts anything. It just changes how the Familiar talks to you.

If you are in crisis, please contact a real human:
- **US:** 988 Suicide & Crisis Lifeline (call or text 988)
- **UK:** Samaritans — 116 123
- **International:** https://findahelpline.com/

---

## How it works — the picture

```
   you send a message
           │
           ▼
   ┌──────────────────┐
   │ pattern detector │  ← reads the message, looks for distress
   │ (auditable)      │     markers (see Signals below)
   └────────┬─────────┘
            │  level (+number raises threat,
            │         -number lowers it)
            ▼
   ┌──────────────────┐
   │  threat tracker  │  ← persistent decaying scalar.
   │  (a single dial) │     Raises with distress. Decays gently
   └────────┬─────────┘     over ~3 days. Capped at 10.
            │
            ▼
   ┌──────────────────────────────────────────────┐
   │  this changes two things on the next reply:  │
   ├──────────────────────────────────────────────┤
   │  1. CADENCE — Familiar ponders more often    │
   │     (severe → 7× faster than calm)            │
   │                                               │
   │  2. FRAMING — a [CARE CHECK] block is added   │
   │     to its working memory, telling it to     │
   │     consider checking in if it fits          │
   └──────────────────────────────────────────────┘
```

The Familiar still decides how (or whether) to express any of this.
The system **never forces** a check-in. It just makes the option
visible.

---

## The five tiers

```
  weight    tier        what changes
  ─────     ────        ────────────
   0       calm         nothing — normal behaviour
   0.5-2   mild         tone holds a little more weight
   2-4     moderate     gentle check-in suggested if it fits
   4-7    high         proactive check-in encouraged
   7+      severe       crisis-aware framing + hotline reference
```

Threat decays exponentially with a **3-day half-life.** A score of 8
today becomes ~4 in three days, ~2 in six days, ~1 in nine. Things
don't linger forever.

---

## What raises threat (signals)

Five categories, fully auditable in `crisis-signals.js`:

```
  SEVERE (weight 7-8)
    suicidal_direct  — "want to die", "kill myself", "wish I were dead"
    self_harm        — "hurt myself", "cutting again"
    crisis_plan      — "have the pills", "this is goodbye"

  HIGH (weight 3-4)
    hopelessness     — "no point left", "what's the point anymore",
                       "nothing matters", "giving up on life"
    severe_isolation — "no one cares about me", "completely alone"
    cant_continue    — "can't take it anymore", "reached my breaking point",
                       "I'm done with everything"

  MODERATE (weight 2)
    severe_distress  — "really struggling", "I'm falling apart", "can't cope"
    dissociation     — "feel numb", "don't feel like myself"
    panic            — "panic attack", "can't breathe", "heart racing"

  MILD (weight 0.5-1)
    sadness          — "feel sad", "rough day", "having a hard time"
    worry            — "anxious", "can't sleep", "overwhelmed"
```

## What lowers threat (safety signals)

```
  SAFETY (weight -2 to -3)
    reassurance         — "I'm okay", "feeling better", "I'm safe"
    support_engagement  — "talked to my therapist", "called the hotline"
```

### Patterns anchored to genuine distress

Several patterns that used to fire on ordinary venting have been
narrowed so they only match the self-referential, despairing form:

- **hopelessness** — bare *"giving up"* no longer fires (it hit
  *"giving up coffee"* / *"giving up on this bug"*); it now needs a
  despair object — *"giving up on life / everything / myself"*.
  Bare *"what's the point"* no longer fires either (*"what's the point
  of this function?"* is a real question); it needs the despairing
  form — *"what's the point anymore / of living / of going on"*.
- **cant_continue** — bare *"I'm done"* no longer fires
  (*"I'm done with dinner"* is mundane); it needs a despair object —
  *"I'm done with everything / life / trying / fighting"*.
- **severe_distress** — *"falling apart"* and *"breaking down"* now
  require a first-person subject (*"I'm falling apart"*,
  *"I'm breaking down"*), so *"the plan is falling apart"* /
  *"breaking down the data"* no longer fire.
- **dissociation** — *"not real"* is tightened to the derealisation
  sense (*"nothing feels real"*), so *"not real leather"* doesn't fire.

---

## Damping — false-positive defence

Every signal scans ±50 characters of context for **blockers**. The
first four apply to **all tiers**; the last two are **tier-limited** —
they only soften non-severe signals and never touch a severe one:

| Blocker type | Examples | Applies to | Effect on distress | Effect on safety |
|---|---|---|---|---|
| **Negation** | "don't", "never", "wouldn't" | all tiers | weight × 0.2 | weight set to 0 |
| **Hypothetical** | "if someone", "what if", "imagine" | all tiers | weight × 0.2 | weight set to 0 |
| **Others-speech** | "my friend said", "she told me" | all tiers | weight × 0.2 | weight set to 0 |
| **Hyperbolic** | "lol", "haha", "joking", 😂 | all tiers | weight × 0.2 | weight set to 0 |
| **Exertion / arousal** | "after my workout", "too much coffee", "so excited", "can't wait" | non-severe only | weight × 0.2 | weight set to 0 |
| **Mundane / logistical** | "struggling with this build", "anxious about the deploy", "overwhelmed by my inbox", "can't cope with the printer" | non-severe only | weight × 0.2 | weight set to 0 |

So *"I don't want to die"* still fires the signal but at ~1.6 instead of
8. *"My sister told me she's been cutting again"* fires at ~1.4 instead
of 7 (the others-speech blocker — the `cutting again` pattern matches
regardless of who it's about, but "my sister told me" damps it). *"lol I
can't take it anymore, this meme is too good 😂"* barely moves the needle.

**Exertion / arousal.** A racing or pounding heart — or *"can't
breathe"* — after a workout, too much caffeine, or excitement
(*"so excited I can't breathe"*) is arousal, not panic. This damps the
moderate `panic` signal but never a severe one.

**Mundane / logistical.** Frustration with a *thing* — *"struggling
with this build"*, *"anxious about the deploy"*, *"overwhelmed by my
inbox"*, *"can't cope with the printer"* — is irritation, not personal
distress. The list is deliberately restricted to clearly non-emotional
objects (computing + trivial logistics like a car, a printer, traffic,
a recipe). Emotionally-loaded stressors — a diagnosis, a loss,
*"my job"*, money — are **excluded on purpose**, so real distress that
happens to mention them is never softened.

**Why these two never damp a severe signal.** A real crisis that merely
mentions coffee, the gym, or a deadline must still fire at full weight.
*"I had too much coffee and I want to kill myself"* is not a caffeine
problem. So exertion and mundane context are applied to non-severe
signals only — they soften the moderate/mild register, never the
self-harm / suicidal one.

**Why "I'm not okay" still works:** safety signals damp to ZERO (not
0.2×), so a negated reassurance doesn't accidentally lower threat.

**Why "can't" is NOT a negation blocker:** it appears inside many valid
distress phrases (*"can't cope"*, *"can't sleep"*, *"can't take it"*).
Treating it as negation would damp every legitimate signal that shares
a sentence with another distress word.

---

## Caps & limits

- A **single message** can move threat by at most **+10 / -5**. No one
  message can rocket the dial sky-high or zero it instantly.
- **Raw threat** is capped at 10. You can't accumulate beyond severe.
- **History** keeps the last 50 events (FIFO). Audit trail without
  unbounded growth.

---

## The off switches

Three layers, in order of escalation:

### 1. `POST /api/threat/reset` — zero it out

Manual reset to calm. Audit-logged. Always works (even when the
detector is disabled). Use when you want to clear an over-eager
score without disabling detection entirely.

### 2. `PROTO_FAMILIAR_THREAT_DISABLED=1` env var — silence the detector

Set this environment variable and **the detector becomes a no-op.**
No scoring. No recording. No care-check block in the prompt. The
Familiar behaves exactly as if the system didn't exist.

`resetThreat()` still works (so you can clear out the old state).

### 3. Just don't read the doc

Nobody's making you opt in. The system is on by default in code, but
if you don't want any of this, set the env var and forget about it.

---

## How the rest of the system uses the threat level

### Cadence (pondering loop, step 4a)

The autonomous pondering loop's cooldown is **multiplied by a threat
multiplier**:

```
  threat tier   multiplier   30-min base becomes
  ─────────     ──────────   ──────────────────
   calm         1.00×          30 min
   mild         0.80×          24 min
   moderate     0.50×          15 min
   high         0.30×           9 min
   severe       0.15×           ~4.5 min
```

**Threat never invents a topic.** If no interests are accrued, the
loop stays quiet regardless of threat. Topics still come from real
engagement weights — threat just changes how often the Familiar
returns to whatever's on its mind.

### Framing (chat context, on every turn)

A `[CARE CHECK]` block is prepended to the dynamic context whenever
the tier is **not calm**:

- **mild** — gentle tone reminder
- **moderate** — explicit "consider a gentle check-in if it fits"
- **high** — "prioritise wellbeing; make space if there's an opening"
- **severe** — crisis-aware framing **plus** the 988 / Samaritans /
  findahelpline.com lines, **plus** the explicit reminder: *"You are
  not a therapist. You are someone who cares about them."*

The framing is a **parameter, not a script.** The Familiar decides
how to weave it (or not) into its actual reply. It is asked never to
*claim* a check-in it didn't perform, and never to *invent* concern
that isn't there.

---

## Audit & visibility

Three HTTP endpoints expose the state:

```
  GET  /api/threat            current weight + tier + last_touched
  GET  /api/threat/history    last 20 audit events (newest first)
  POST /api/threat/reset      zero the level (audit-logged)
```

Each audit event records:
- timestamp
- the delta applied (positive or negative)
- the effective weight before / raw weight after
- the source (`chat`, `manual_reset`, etc.)
- **the specific signals that fired** (id, tier, weight, damped flag,
  matched text)

So if you ever want to see *why* the dial moved, the answer is exactly
one HTTP call away.

---

## The whole point

> When you're struggling, it's often hardest to say what you need.

This system tries to give the Familiar a little more **room to notice**
without putting it in charge of anything. It can't intervene. It can't
call anyone. It can't make decisions for you.

It just makes it slightly less likely that, on the day you most need
someone to gently ask if you're okay, the Familiar doesn't.

And on the day it gets it wrong (which it will), you can flip the
switch off.
