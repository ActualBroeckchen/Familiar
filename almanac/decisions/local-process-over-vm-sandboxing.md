---
title: "Local Process Over VM/Docker Sandboxing"
topics: [decisions, autonomous-loops]
sources:
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: installer-getting-started
    type: file
    path: docs/getting-started.md
  - id: founding-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/e6e73df7-Finding_a_better_mental_health_tool.txt
    note: "Founding design conversation that scoped v0.1 and worked through VM/Docker/OS-sandbox tradeoffs before any of Familiar existed."
  - id: mvp-scoping-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/ec43aed6-Visualizing_a_vague_yet_specific_vi.txt
    note: "Second founding design conversation in which the maintainer described the barebones prompt-testing frontend she was already running."
  - id: index-html
    type: file
    path: public/index.html
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: temporal-core-design
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/524975aa-temporalcoredesign_1.md
    note: "Temporal-core design document that named Tailscale plus a password gate as the intended two-layer remote-access security model, ahead of either shipping."
---

# Local Process Over VM/Docker Sandboxing

**Status: decided, at the v0.1 scoping stage that produced Familiar.** Before any code
existed, the maintainer considered having the Familiar spin up its own isolated VM or Docker
container to protect its data from the host and the host from it, and decided against
self-provisioned isolation in favor of relying on the isolation a normal local application
already gets for free. Familiar's actual shape — a local Node.js/Express server plus a
browser-rendered frontend, installed and run directly on the ward's machine (see
[Installer and launcher](../architecture/installer-and-launcher)) — is the outcome of that
decision, not an accident of "just start simple."

## Context

The instinct behind the original idea was sound: **bidirectional isolation** is a real security
pattern (it is how browsers contain web pages and how mobile OSes contain apps) — the data
inside an application should be safe from whoever controls the host, and the host should be
safe from whatever the application does [@founding-conversation]. The specific proposal was for
Familiar to detect the host's virtualization capability at install time and provision its own
VM automatically, similar to how WSL2 or Vagrant automate VM provisioning today
[@founding-conversation].

Working through the actual cost/benefit surfaced several reasons this was the wrong tradeoff
for this project specifically:

- **The host-trust problem does not go away inside a VM.** Anyone with admin access to the host
  can read the VM's disk image directly, snapshot its running memory, or watch its network
  traffic at the host's interface — a VM protects against casual access from other apps or
  unprivileged users, not from someone (or something) with host admin rights, which is
  approximately the same protection ceiling as good OS-level application sandboxing, at far
  greater cost [@founding-conversation].
- **Running 24/7 argues against a VM, not for one.** A guest OS reserves RAM and CPU
  continuously even at idle, which is a real cost on the older, lower-spec laptop hardware this
  project was scoped around, and it is the opposite of what a background companion that is
  meant to run constantly should be paying for [@founding-conversation].
- **Cross-platform VM tooling is not actually uniform.** VirtualBox's Apple Silicon support was
  recent and limited, it conflicts with Hyper-V on modern Windows, and it requires a kernel
  extension that triggers security warnings — meaning "Familiar provisions its own VM" would
  really mean maintaining separate platform-specific code paths, plus an ongoing obligation to
  keep a guest OS patched that a container or a normal app never takes on
  [@founding-conversation].
- **Self-imposed sandboxing does not actually provide the "protect the host from the app" half.**
  The reason an OS-level sandbox protects the host is that the OS enforces the boundary from
  outside the application; an application building its own container is trusting itself to be
  honest about a boundary it could also remove, which is exactly the trust pattern that does not
  work for security — "this is the deep reason web browsers don't let pages 'secure themselves'
  — the browser secures them, because self-imposed boundaries can be self-removed"
  [@founding-conversation].

## Decision

Familiar should be built as a normal local application that gets OS- or browser-level
sandboxing for free, rather than provisioning its own VM or Docker container. Of the framework
options considered — Tauri, Electron, a native per-platform app, or a browser-rendered local
web app — the browser option was identified as the most accessible starting point for a v0.1
scoped around a single maintainer without a software-engineering background working from an
existing laptop: no separate install step for a runtime, sandboxing comes from the browser
itself, and it is the same surface on a laptop and a phone without separate builds
[@founding-conversation]. The v0.1 the maintainer actually named at the time was deliberately
narrow: "a frontend that successfully communicates with an LLM without leaking all my personal
data" [@founding-conversation] — direct provider calls only, no third-party analytics or
telemetry, no plaintext credential storage in a form that would block adding encryption later,
and a provider tier that does not train on submitted content.

What Familiar shipped is a variant of this outcome, not a byte-for-byte match: a local
Node/Express server (not a browser-only app) that a browser frontend connects to, installed and
launched per-platform rather than served purely as a static web app
[@architecture-doc] [@installer-getting-started]. This keeps the OS-level isolation argument the
founding conversation reached for — nothing here provisions its own VM, Docker container, or
kernel-level sandbox — while the server-plus-browser split gives room for the Node process to
own persistent state (`tomes/`, `logs/`, `phylactery/data/`) that a pure browser app's storage
model would have made awkward.

The repository's first commit already carries this shape forward literally. In the second
founding conversation — the one that scoped [temporal assurance](../concepts/temporal-assurance)
into an MVP — the maintainer described a running prototype: "Very simple. Main Prompt, Char, User,
Post-History. So far it's only a local front end with no memory past context, yet. Messages are
already getting dated and timestamped though and chatlogs get saved"
[@mvp-scoping-conversation]. The repository's `ff15714` ("Skeleton") commit is titled
Familiar from its first line and ships exactly that four-field layout — System Prompt,
Character Profile, User Profile, and Post-History Prompt — still present in `public/index.html`
today under the same field ids [@index-html]. This places the barebones-prompt-testing session
described in that conversation at the project's actual starting point, not a discarded separate
prototype.

## Consequences

The "always running" question the founding conversation raised separately from isolation —
whether the heartbeat, scheduled reminders, and channel listeners need to be always-on even
though the heavier main-agent and sifter work should stay lazy — was resolved differently from
the thin-listener-plus-lazy-heavy-components split first sketched. That split proposed a small,
opinion-free persistent process that only listens and schedules, waking heavier components on
demand [@founding-conversation]. What shipped instead is a single Node process that boots every
[autonomous loop](../architecture/autonomous-loops) directly at startup, each with its own hard
off-switch, rather than a separate lightweight listener spawning heavier work lazily. The
independent-failure and hard-off-switch guarantees the founding conversation wanted are present
in the shipped design, but achieved by process-internal isolation between loops rather than by
physically separating an always-on layer from an on-demand one.

Because isolation is never self-provisioned, Familiar's own trust model is the same one
[Session memorization: durable queue](session-memorization-queue) already names for the
memorization queue's on-disk API key: local files are protected by the OS's own user-account
boundary, not by anything Familiar builds itself, and that posture is explicitly
understood to need revisiting if the server is ever exposed beyond localhost.

That revisit is distinct from the isolation question this decision covers — it is about
authenticating *remote* access, not about containing the local process — and a later design
conversation named the intended shape as two layers: Tailscale (a private encrypted overlay
network, no open ports) plus a password gate on Familiar's own server as a second layer
[@temporal-core-design]. Only the first layer shipped: `server.js` always binds to `0.0.0.0`, but
a middleware rejects any non-loopback request with `403` until an in-UI toggle (or a
`TAILSCALE=1` env var at first start) turns it on, with the toggle state persisted to
`.proto-familiar-config.json` [@claude-md]. No separate password or basic-auth layer exists in
the shipped server — once the Tailscale toggle is on, any device that can reach the machine over
the tailnet can use the API key, read Phylactery/Unruh context, and write to the Tome editor with
no further credential [@claude-md]. The second layer named in the original design remains an open
item, not something already covered by a different mechanism.

## Related

- [Installer and launcher](../architecture/installer-and-launcher) — what actually runs on the
  ward's machine as a result of this decision.
- [Autonomous loops](../architecture/autonomous-loops) — the shipped resolution of the
  always-on/lazy question, as independently-failing loops inside one process rather than a
  physically separate listener layer.
