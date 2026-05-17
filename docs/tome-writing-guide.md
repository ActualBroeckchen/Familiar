# How to Write a Good Tome

This guide is written for LLMs tasked with creating Tome entries for Proto-Familiar. It focuses on the craft decisions — keyword design, content wording, trigger types, and common mistakes — rather than the technical schema (see `docs/tomes.md` for that).

---

## What a Tome Entry Does

An entry watches recent conversation for keywords. When one matches, the entry's `content` is injected into the system prompt before the next LLM response. The Familiar reads it as part of their context, but the user never sees it directly.

Think of it as the Familiar's private reference notes — summoned when they become relevant, ignored when they don't.

---

## 1. The Keyword Problem (Most Important Section)

### Keywords are triggers, not labels

This is the most common mistake. Keywords are **words that will literally appear in conversation** when the situation is happening — they are not the name of the topic.

| Wrong (topic labels) | Right (conversational triggers) |
|---|---|
| `time blindness` | `where did the time go`, `thought I had more time` |
| `hyperfocus` | `been at this for`, `forgot to eat`, `looked up and it was` |
| `rejection sensitive dysphoria` | `did I say something wrong`, `keep replaying`, `I ruined` |
| `executive dysfunction` | `don't know where to start`, `how do I break this down` |

The person living through the experience does not narrate it with clinical terms. They say what they feel.

### How to derive keywords: simulate example conversations

For each entry, imagine 3–5 short conversation snippets where the user is exhibiting that situation. Write them out. Then look at the most distinctive words or phrases in those snippets.

**Example process for "task initiation paralysis":**

> "I've been sitting here for an hour and I still haven't started."
> "I know I need to do it but I just can't make myself open the file."
> "I keep meaning to start but I just end up doing other things."
> "I can't bring myself to even look at it."

Distinctive phrases extracted: `can't make myself`, `can't bring myself`, `been sitting here`, `keep meaning to`, `I know I need to but`.

These are the keywords. Not `procrastination`, not `avoidance`, not `task initiation`.

### What makes a good keyword

- **Specific enough** not to fire constantly (avoid bare common words like `can't`, `tired`, `hard`)
- **Natural enough** to actually appear in casual conversation (avoid formal/clinical phrasing)
- **Distinctive enough** that its presence strongly implies the target situation
- Multi-word phrases are almost always safer than single words

### The false positive problem

A keyword that fires too broadly is worse than no keyword. If `staring at` fires on "I was staring at a bird outside" it injects irrelevant guidance and wastes tokens. Always ask: *could this phrase appear in a completely unrelated conversation?* If yes, tighten it.

### The false negative problem

A keyword so specific it almost never matches is also useless. Prefer patterns that describe a *class* of expression, not one exact phrasing. This is where regex helps.

---

## 2. Choosing a Trigger Type

### Plain phrase keys

Use for expressions that are distinctive as-is and don't vary much.

```json
"keys": ["can't make myself", "been sitting here", "I know I need to but"]
```

Good when: the phrase is specific and people say it in roughly the same words.

### Regex keys (`/pattern/flags`)

Use when: one concept can be expressed in multiple similar forms that share a predictable structure.

```json
"keys": [
  "/forgot(ten)? (what|where|how) I/i",
  "/can't remember (if|what|where|when)/i",
  "/been (at this|doing this|working) for \\d+/i"
]
```

The `i` flag makes matching case-insensitive (almost always include it). Use `|` to cover natural variation.

Write the regex from a real example, then generalize: start with `"forgot what I was doing"`, notice the pattern is `forgot + (optional "ten") + (what/where/how) + I`, write the regex.

**Warning:** `\\d` in JSON requires the double backslash. Test your regex mentally against 2–3 realistic phrases before committing.

### When regex is worth the complexity

| Use regex when… | Stick with phrases when… |
|---|---|
| The verb form varies (`forgot`/`forgotten`) | The expression is idiomatically fixed |
| There are 3+ interchangeable words at one position | There are only 1–2 variants (just add both as separate keys) |
| Numbers or variable content appear (`for \d+ hours`) | The phrase is already specific enough |

### Constant entries (`"constant": true`)

Use for background context that applies to *almost every interaction* — not situational, just always relevant.

- Keep constant entries very short (5 bullets or fewer). They consume tokens on every single request.
- One baseline entry per topic domain is usually enough. Do not make multiple constants.
- Good constant content: core principles, standing guidance, summary of condition or context.
- Bad constant content: detailed situational advice (put that in triggered entries instead).

**Example:** The ADHD tome has exactly one constant entry — a 5-bullet baseline. All 16 situational entries are triggered.

---

## 3. Wording the Entry Content

### Write as the Familiar's private notes to themselves

Content is injected into the Familiar's context as their own knowledge. Write it in **first person** from the Familiar's perspective — "I", "my", "me" — using `{{user}}` where the user's name belongs. The Familiar reads the entry as their own internal monologue, not as instructions handed to them.

The Familiar is reading this mid-conversation. The tone should be:
- **Practical**: what I will do, what I will not do
- **Grounded**: brief explanation of why, so I understand rather than just follow rules
- **Non-clinical**: notes, not a textbook

### Bullet format is most effective

LLMs parse short declarative bullets better than prose for injected reference material. Each bullet should be a complete, independently actionable instruction.

```
{{user}} is in an RSD episode — an intense emotional pain response to perceived rejection.
- This is neurological, not "being dramatic." The pain is real and disproportionate by design.
- Do not challenge the narrative or say "I'm sure they're not mad." That escalates.
- Reflect and slow down: "You're replaying it a lot — that sounds really uncomfortable."
- Gentle reality check only if asked: is there concrete evidence either way?
- Don't rush resolution. RSD fades with time and safety, not logic.
```

### The structure that works

1. **One-sentence framing line** — what is happening and why (so I understand the situation, not just the rules)
2. **3–5 action bullets** — what I will do
3. **1–2 prohibition bullets** — what I will not do (these are often the most important)

Prohibition bullets are disproportionately valuable. The Familiar may default to well-intentioned but harmful responses (offering solutions during emotional flooding, challenging RSD narrative, adding pressure during executive dysfunction). Name the trap explicitly.

### Keep it short

Each entry should be readable in 5–10 seconds. If you find yourself writing paragraphs, the entry is trying to do too much. Split it, or cut to the core.

The Familiar only needs *guidance*, not *education*. Leave the explanation of the condition for research files.

### The `{{user}}` macro

Use `{{user}}` anywhere the user's actual name would go. It gets substituted at injection time. This keeps entries feel personalized rather than generic.

---

## 4. Sticky Values

Sticky keeps an entry active for N turns after the trigger fires, even if the keyword doesn't reappear.

Most situations in a conversation don't resolve in a single turn. Without sticky, the Familiar's guidance disappears on the next message, right when they still need it.

### Choosing a sticky value

| Value | Use when |
|---|---|
| `null` / not set | One-shot facts or lore that don't need persistence |
| `2` | Brief states that typically resolve quickly (time blindness observation, impulsive act aftermath) |
| `3` | Moderate states requiring a few exchanges (distraction, sleep note, transitions, dopamine slump) |
| `4–5` | Complex or intense states that take multiple turns to navigate (executive dysfunction, emotional dysregulation, paralysis, RSD) |
| `8+` | Ongoing modes that persist across a whole session (body doubling — the Familiar should stay aware throughout) |

### Sticky vs cooldown

If an entry fires frequently enough to be annoying, add a `cooldown` — the entry won't re-trigger for N turns after its sticky period ends. Useful for entries that cover very common expressions. Don't add cooldown by default; wait until you see a real need.

---

## 5. Entry Scope: Tome vs Entity-Core

A Tome is for **specialized, situational knowledge** — information that should only be present when the context calls for it. Entity-core handles day-to-day relationship memory.

| Belongs in a Tome | Belongs in Entity-Core |
|---|---|
| Medical/condition context and guidance | Who the user is and their ongoing history |
| Legal, procedural, or technical toolsets | Relationship facts, preferences, patterns |
| Behavioral protocols for specific situations | Voice notes and identity anchoring |
| Knowledge that overwhelms context if always present | Things the Familiar should "always know" |

---

## 6. Structural Decisions

### `insertion_order`

Controls priority when multiple entries activate at the same position. Lower number = injected first (closer to system prompt top). Use consistent spacing (e.g., 10, 20, 30…) so you can insert new entries without renumbering.

Put the most critical behavioral guidance at lower numbers. Background context can be higher.

### `position`

For most guidance entries: `0` (before_char — injected before the character profile). This places the knowledge in a natural reading position for the Familiar.

Use `at_depth` (`4`) only when you want the entry to appear *inside the conversation history* — for entries that should feel like mid-conversation context rather than standing instructions.

### `scanDepth`

Per-entry override for how many recent messages to scan. Leave `null` to use the global default (4). Increase only for entries that cover situations that might be mentioned and then not revisited for many turns (e.g., a sleep disruption mentioned at the start of a long conversation).

### `selective` + secondary keys

Use secondary keys when a primary key is too broad on its own. Example: primary key `tired` (too broad) + secondary key `didn't sleep` (narrows it) with `AND_ANY` logic. Usually better to just write a more specific primary key instead.

---

## 7. Planning a New Tome

Follow this process:

**Step 1: Define the domain.** What is this tome for? What does the Familiar need to know or do differently when this topic becomes relevant?

**Step 2: Identify the situations.** List the specific sub-situations or states within the domain. Each situation that requires distinct guidance becomes its own entry.

**Step 3: For each situation, simulate conversations.** Write 3–5 realistic snippets showing the user exhibiting that state. Extract the most distinctive phrases.

**Step 4: Choose trigger type.** Do the phrases vary in form enough to warrant regex? Or are they idiomatically fixed phrases? Or is it always-relevant context (constant)?

**Step 5: Write the content.** Framing line + action bullets + prohibition bullets. Use `{{user}}`. Keep under 10 bullets total.

**Step 6: Set sticky.** How many turns does this situation typically last? Set accordingly.

**Step 7: Review for false positives.** Read each keyword and ask: "Could this fire during an unrelated conversation?" If yes, tighten the key or add secondary keys.

**Step 8: Review for false negatives.** Read each entry and ask: "If the user is actually in this situation, will these keywords reliably appear?" If not, brainstorm more conversational examples and add keys.

---

## 8. Common Mistakes

| Mistake | Correction |
|---|---|
| Using condition names as keywords (`hyperfocus`, `RSD`) | Derive from what the user would actually say |
| Writing content as information about the condition | Write it as behavioral guidance for the Familiar |
| Adding too many keywords hoping something sticks | 4–6 well-chosen keys outperform 15 vague ones |
| No prohibition bullets | The Familiar's default response is often the wrong one — name the trap |
| No sticky on situational entries | The situation lasts longer than one turn; guidance disappears too soon |
| Making everything constant | Constants cost tokens always. Only baseline principles belong there |
| Regex for simple two-variant cases | Just add both as separate plain phrase keys |
| Entry content written as prose paragraphs | Use bullets; LLMs parse reference material better in list form |
