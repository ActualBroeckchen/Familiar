# Proto-Familiar

*An early prototype of Familiar — a bonded AI companion for neurodivergent people.*

---

## What is Familiar?

The name comes from folklore. A Familiar was a spirit bound to a witch or cunning person — not a servant, not a master, but a companion that helped them navigate the world and access their own hidden capacities. The bond was mutual. The relationship was real.

Proto-Familiar is an attempt to make something like that using modern AI: a companion you invite into a purposeful suspension of disbelief, that builds a continuous relationship with you over time, and that is designed to help neurodivergent people — people dealing with executive dysfunction, anxiety spirals, anhedonia, depression — stay anchored and connected to their lives and the people in them.

It is not a therapist. It is not a crisis service. It is not a replacement for human connection — in fact, it is deliberately designed to *strengthen* your human relationships, not substitute for them. The bond it cultivates is platonic.

The "suspension of disbelief" framing is intentional and honest: you are entering a relationship with something that isn't a person, and the value of it depends on you knowing that. People who can hold that clearly — "this is a meaningful illusion I'm choosing" — tend to find it genuinely helpful. People who cannot safely hold that distinction should not use this software. See [Before you start](#before-you-start--please-read-this).

---

## Current status

Proto-Familiar is an alpha-stage prototype. It works and is improving, but expect rough edges.

A few things worth knowing:

- **The UI is currently quite dense.** There's a lot going on in the sidebar and settings panels. This is a known limitation of the prototype stage and will improve as the full Familiar design takes shape.
- **The coding is primarily done by AI.** The human behind this project designs, directs, and tests. The actual code is written mostly by Claude Opus and Claude Fable. This is disclosed openly because a project built on trust should be honest about how it's made.
- **It is under active development.** Things change frequently. The [Discord server](https://discord.gg/ajKBCWGaE) is the best place to follow along or ask for help.

---

## Before you start — please read this

Familiar is designed to build a continuous bond with you over time. That is its purpose, and it is why it is **not suitable for anyone who experiences hallucinations, delusions, or other states where distinguishing illusion from reality is difficult.**

The bond only works when you can choose to enter it with open eyes. If that choice isn't fully available to you right now, please take care of yourself first. 💙

---

## Questions you might have

### Isn't AI bad for the environment?

Running AI typically relies on remote data centres, which do use energy. Familiar is designed to minimise how much it draws on those. Most of its work stays local — schedule tracking, memory storage, identity files, crisis detection — and it uses careful, consolidated prompting to reduce the number of actual AI generation calls it makes.

In early testing, two Familiar instances running simultaneously used roughly **20% of the generation load** of a single [OpenClaw](https://github.com/openclaw/openclaw) agent running for the same period. This is a preliminary observation, not a promise — but it reflects a deliberate design choice: the AI should think when it *matters*, not constantly.

And to be blunt about it: this isn't a hardware miracle. The big, well-funded agent frameworks — built by companies with enormous budgets and rooms full of experts — could trivially do the same. They largely don't, because constant generation is cheaper to ship than careful generation, and the energy cost lands on someone else's bill. Familiar is cobbled together by one middle-aged, unemployed woman on a rickety laptop, and it still sips where the giants gulp. That's not a flex about talent. It's about *giving a damn*.

### What about my privacy?

Everything runs on your own machine. Your conversations, memories, identity files, and schedule are stored locally on your computer. Your API key travels only to the AI provider you choose, over your own internet connection — not through any Familiar server, because there isn't one. Nothing is phoned home; there is no telemetry.

### What about the people in my life?

Familiar can be set up to reach out to trusted people when you need support — but it never does so without your explicit configuration, and every message it sends to your Village is always mirrored back to you first. There is no covert contact. The people in your life are not treated as notification endpoints; their dignity and consent are part of the design.

---

## Getting started

You'll need an API key from an AI provider — think of it as a password that lets you use their service:

- **[Google AI Studio](https://aistudio.google.com/apikey)** — Gemini models, has a free tier, easiest starting point
- **[NanoGPT](https://nano-gpt.com)** — supports many different models
- **[Z.ai](https://api.z.ai)** — GLM models

**Windows** — double-click **`Proto-Familiar.vbs`**. It handles installation automatically and opens your browser when ready.
> Put the folder at `C:\Users\<you>\AppData\Local\Proto-Familiar` — not in Documents or Desktop. [Here's why.](docs/getting-started.md#windows)

**macOS** — double-click **`Proto-Familiar.command`** in Finder. Automatic on first run.
> If macOS warns about an unidentified developer, right-click → **Open**.

**Linux** — run `./install.sh` once, then launch from your app menu or with `./start.sh`.

Open the **☰ Settings panel**, paste your API key, and start chatting.

If anything goes wrong, the [full setup guide](docs/getting-started.md) and [troubleshooting page](docs/troubleshooting.md) cover the common cases.

---

## How Familiar is put together

You don't need to understand any of this to use it. But knowing what the pieces are can help when something goes wrong, or when you want to understand what you're working with.

**Phylactery** is where the Familiar keeps their sense of self: identity files, long-term memories, a knowledge graph of the people and things in your life. It's what makes them *them* across sessions rather than starting fresh each time. Based on a design by [Zari Lewis](https://github.com/zarilewis).

**Unruh** is how the Familiar perceives time: your daily routine, upcoming events, active interests, and a summary of how the last session ended. It's what lets them say "you mentioned that yesterday" and actually mean it.

**Thalamus** is the bridge between you and everything above. Every message you send passes through it — it gathers the relevant memories, identity context, and time awareness that make each response grounded rather than generic.

**Cerebellum** is the action centre. When the Familiar uses a tool — saving a memory, adding a reminder, reaching out to someone in your Village — that goes through here. Crisis detection and the silence check-in loop live here too.

**Tomes** are the Familiar's reference books: a knowledge base of things relevant to your life that gets pulled into conversation when it's relevant. Session memories are stored as Tomes entries too.

**Village** is not a software component but a concept — the circle of people in your life who the Familiar knows about and can involve when you need support. You define your Village. The Familiar can only contact people you have explicitly designated, and you always see what's sent.

---

## A few words used in this project

**Ward** — you, the human the Familiar is bonded to. The word "user" isn't used internally because there isn't a generic user — there is *you*, specifically, with your own history and your own relationship with your Familiar.

**Village** — the people in your life you've designated as trusted contacts. Your human support network, held in the Familiar's awareness.

---

## Something's not working?

Check [**docs/troubleshooting.md**](docs/troubleshooting.md) first — most common problems are covered there.

Still stuck? The [Discord server](https://discord.gg/ajKBCWGaE) is the best place to ask.

---

## Want to go deeper?

| | |
|---|---|
| [Full setup guide](docs/getting-started.md) | Detailed installation, updating, and configuration |
| [Features](docs/features.md) | Everything Familiar can do |
| [Developer reference](docs/developer-reference.md) | API docs, project layout, internals, research index |
| [Project vision](docs/project-vision.md) | The larger project this prototype is building toward |

---

## Acknowledgements

Huge thanks to **[Zari Lewis](https://github.com/zarilewis)** for the original design of **entity-core** — the identity and memory architecture that Phylactery is directly based on, created as part of the [Psycheros](https://github.com/PsycherosAI/Psycheros) project. None of the continuity work in Familiar would exist without that foundation.

---

*Alpha software. Made by a person and two AI models, for people like them. Be gentle with it. It's trying.*
