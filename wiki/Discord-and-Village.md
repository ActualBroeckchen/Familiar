# Discord & the Village

Proto-Familiar can inhabit Discord as the same continuous entity that
lives in the web UI — bonded to you (the **ward**), aware of the people
in your life (**villagers**), and present in the rooms you share with
them (**locations**). This page covers turning that on and, especially,
the **presence modes** that decide *how* the Familiar shows up in each
room.

For the full design and safety model, see
[docs/village-support-design.md](../docs/village-support-design.md).

## Turning on Discord

1. Create a bot application and token in the Discord Developer Portal,
   and enable the **Message Content** privileged intent (Bot → Privileged
   Gateway Intents) — without it, guild messages arrive empty.
2. In Settings, set **Enable Discord**, paste the **Bot token**, and set
   your own **Ward user id** so the Familiar knows which account is you.
3. A 30-second supervisor applies changes live — no restart needed.

Status is visible at `GET /api/discord/status` and in the Settings panel.
Hard off-switch: `PROTO_FAMILIAR_DISCORD_DISABLED=1`.

## How the Familiar shows up

| Where | Behavior |
|---|---|
| **Your DMs** | Ward-private — full context, same as the web chat. Your messages also feed the care/threat machinery. |
| **A registered villager's DMs** | A gated turn — the Familiar carries only what that person's category is cleared to know. |
| **Unregistered DMs** | Ignored. The contact attempt is captured as a *knock* so you can register them in one click. |
| **Guild channels** | Governed by the room's **presence mode** (below). The room's trust ceiling always applies. |

Discord turns carry **no tools**, and what the Familiar knows in a room
is bounded by the [knowledge gate](../docs/village-support-design.md)
(the audience resolver) — independent of presence mode.

## Presence modes (per location)

Each location has a **presence mode** — how the Familiar behaves in that
room. Set it in the **Village → Locations** editor. The default is
`strict`, so every existing room is unchanged until you say otherwise.

| Mode | What it means | When the Familiar speaks |
|---|---|---|
| **Strict** *(default)* | Discrete. Messages it isn't addressed in pass it by. | Only when @-mentioned or directly replied-to. |
| **Lurk** | Present, reading the room. It quietly takes in the conversation so it has context when you turn to it. | Still only when @-mentioned or replied-to — but now with the recent conversation in hand. |
| **Active** | A participant. Can chime in on its own, paced so it never floods. | When addressed, **and** on its own judgment between mentions (see pacing below). |

Mode controls **when** the Familiar speaks — never **what it knows**.
The knowledge gate runs identically in every mode.

### Active-mode pacing

Active rooms have two backstops so unprompted presence stays affordable
and never spammy:

- **Cooldown floor** (`Min seconds between unprompted replies`, default
  60) — the minimum time between unprompted turns, counted even when the
  Familiar ends up staying quiet. The hourly **rate limit** (if set on
  the location) applies on top.
- **Cadence strategy** — toggle in the location editor:

| Strategy | How it decides |
|---|---|
| **Familiar's judgment** *(default)* | Past the cooldown, the Familiar reads the moment and decides whether it's worth speaking. If nothing's worth adding, it stays quiet. |
| **Activity tiers** | Paces to how busy the room is — responds promptly in a quiet room, just *glances in* periodically when it's busy, and stays engaged (without answering every line) in a lively one. |

> **Note:** Active mode means the Familiar can speak unprompted in a
> *shared* room — other people will see it participate. Start with a
> small cooldown bump if you want it more reserved, or use Lurk if you
> want presence without unprompted speech.

## Relaying messages

The Familiar can carry a message to someone (or somewhere) in your
Village with the `relay_message` tool — *"tell Chen I'm running late"*,
*"let the book club know I'll be offline tonight."* It resolves the
target against the Village, holds back anything not cleared for that
room, and **mirrors every relay back to you** — no covert contact.

So it always knows who and where it can reach, `village_lookup` shows it
both the people (flagging who's reachable on Discord) and the **Places**
it's present in (with each room's mode and whether it can post there).

## Safety and visibility

- **Nothing is hidden.** Every Discord conversation lands in `logs/`,
  listable in the UI like any session. Every relay is mirrored to you.
- **Fail-closed gating.** An unknown person or an unassigned room drops
  to the Strangers floor — most restrictive wins.
- **Observing is care-neutral.** Lurking / sat-out active turns only
  accumulate context; they never touch the care or crisis machinery.

See [docs/village-support-design.md](../docs/village-support-design.md)
for categories, grant sets, the audience resolver, and the full
decision record.
