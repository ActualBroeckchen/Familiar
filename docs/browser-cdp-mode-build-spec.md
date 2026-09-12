# Browser CDP mode — driving the ward's own logged-in Chrome (§9 Horizon #2)

> **STATUS: BUILT (0.11.31-alpha), pending desktop shakeout.** The ward gave the
> fresh go-ahead and this shipped to spec: `browser-cdp-arm.js` (the arm gate),
> the `ensureContext` CDP branch driving a dedicated tab in the ward's Chrome,
> the disconnect-never-close teardown invariant, the forced single-domain
> allowlist, arm-expiry→owned-profile drop with the RULE-B note, the
> `/api/browser/cdp-arm|cdp-disarm` endpoints, the Settings arm surface,
> `cdpModeEnabled` (default OFF) + `PROTO_FAMILIAR_BROWSER_CDP_DISABLED=1`.
> **The arm-gate logic is fully unit-tested** (`tests/browser-cdp-arm.test.mjs`:
> domain normalisation, private/loopback refusal, the single-domain allowlist,
> expiry + the one-shot note, disarm, env hard-disable). **The live CDP attach +
> real-Chrome drive still needs a ward desktop shakeout** (§8 — it cannot run in
> headless CI, same posture as the headed-handoff hand-back): launch Chrome with
> `--remote-debugging-port=9222`, arm a domain in Settings, and confirm the
> Familiar drives that tab and that disarm/expiry/`browse_close` leave your
> Chrome and its other tabs untouched.
>
> **Setup accessibility (0.11.32, ward-requested).** Gate 1 (the ward launches
> debug Chrome themselves) is a real barrier for this app's audience — hand-adding
> `--remote-debugging-port=9222` to a shortcut is exactly the techie step the app
> exists to spare them. `cdp-launcher.js` + `POST /api/browser/cdp-setup` add a
> **one-click "Set up my Chrome"** button that drops a double-clickable Desktop
> launcher (per-OS). It preserves gate 1 — the app writes a shortcut, the ward
> still chooses to run it — and IMPROVES the blast radius: the launcher uses a
> **dedicated Chrome profile**, so the drivable browser starts logged out and
> holds only the sites the ward signs into there; their everyday Chrome (bank,
> email) is never exposed to the debug port. Ward-approved deviation from the
> spec's "attach to your everyday Chrome."
>
> This is the highest-stakes variant in the whole browser milestone: the blast
> radius is the ward's *authenticated life* (email, bank, socials — every site
> their real Chrome is already logged into). The main browser spec pinned it as
> "Own spec, own sign-off" (`docs/browser-build-spec.md` §9.2). This is that spec.

## 1. What it is (and is NOT)

**Is:** an *alternate engine backing* for the existing `browse_*` tools. Instead
of the Familiar's own isolated headless profile (`browser/profile`, which it
launches and owns), it attaches to the **ward's already-running Chrome** via
`chromium.connectOverCDP('http://127.0.0.1:9222')` and drives *that*. The
cognition layer (lens, refs, delta verdicts), the tool surface, and the code
guardrails are all **unchanged** — only where the pixels live changes.

**Is NOT:** a new tool surface, a new autonomy grant, or an always-on mode. It is
inert unless the ward has taken **two** deliberate physical actions (§3) that no
web page and no model output can fake.

**Why anyone wants it:** the ward's Chrome is *already logged in everywhere*, so
tasks that the owned-profile mode has to hand back (anything behind a login) can
proceed without a handoff — "reply to that thread", "check my order status",
"grab the PDF behind my account". It is the natural home for the delegated
task-flows of Horizon #3, which is exactly why it must be locked down first.

## 2. The load-bearing problem: the SSRF network floor cannot apply

The main spec's #1 guardrail (§5.1) is a **CONNECT proxy the app owns**, injected
via `launch({ proxy })`, that is the single DNS-resolution point for every
request and refuses private/loopback/metadata IPs. It is airtight *because the
app launches the browser*.

**Under CDP we do not launch the browser — we attach to one already running.**
So `launch({ proxy })` is not available, and the airtight floor is **gone**. What
remains is strictly weaker:

- **CDP request interception** (`Fetch.enable` / `Network` domain) can see and
  abort requests by URL — but it sees `request.url`, not the resolved socket IP,
  so it has the *exact* TOCTOU / DNS-rebind hole §5.1 was written to close. It is
  a URL gate, not an IP gate.
- `assertPublicUrl` still runs as a pre-check on navigations we initiate.

So CDP mode's network protection degrades from **"airtight IP floor"** to
**"best-effort URL allowlist, rebindable in theory."** This must be stated in the
ward's own words at arm time, not buried. Two design consequences follow, and
they are the first thing to sign off (§7):

- **CDP mode is forced to `allowlist` site-mode.** It may never run `open` or
  `blocklist`. The set of hosts it may touch is small, explicit, and *is the
  armed domain* (§3) — nothing else. A tight allowlist shrinks the rebind
  surface to "could a host on the allowlist rebind to a private IP", which is a
  far smaller worry than the open web.
- **The metadata/loopback refusal still runs** at the URL layer (we can refuse a
  literal `169.254.169.254` / `localhost` / private-range *hostname or literal
  IP* in the URL), it just can't defeat a hostname that resolves privately at
  connect time. Named honestly as a residual risk.

## 3. The safety spine: two things the ward does that nothing can fake

CDP mode is inert unless **both** of these are true, and each is a deliberate
human act outside anything the model or a page can influence:

1. **The ward launched Chrome with the debug port open themselves.** Chrome does
   NOT expose CDP by default; the ward must start it with
   `--remote-debugging-port=9222` (a shortcut/terminal they set up). The app
   **never** launches the ward's Chrome and never adds that flag. If the port
   isn't open, `connectOverCDP` fails and CDP mode simply isn't available.
   - **Loopback only, always.** The app connects to `127.0.0.1:9222` and nowhere
     else — never a remote CDP URL (that would be a remote-control attack surface
     of its own). Non-loopback CDP endpoints are refused in code.

2. **The ward armed a scoped, time-boxed grant** in the UI, immediately before
   the task. This is the "per-task ward arm" the main spec demanded — **not** a
   standing toggle:
   - **Scoped to one domain** (e.g. `github.com`) — that domain becomes the
     allowlist for the task; navigation off it is refused.
   - **Time-boxed** (default 15 min, ward-chosen from a short menu; hard ceiling
     e.g. 60 min). On expiry the arm is dead and the engine drops back to the
     owned profile (or refuses, per §7).
   - **Ward-initiated, never model-initiated.** The arm is created by a Settings
     button → `POST /api/browser/cdp-arm {domain, minutes}`, exactly like the
     `[CONFIRM]` approve-resume (0.11.5): a page can never talk the model into
     self-arming, because arming is not a tool the model can call. The Familiar
     may *ask* ("I'd need you to arm your Chrome on github.com for this") — the
     ward acts.
   - **Disarmable instantly** (a "Disarm" button / `POST /api/browser/cdp-disarm`),
     and auto-disarmed on expiry, on a navigation refusal, or on shutdown.

Absent either action, every `browse_*` call uses the existing owned profile
exactly as today. **Two independent human gates, one of them outside the app
entirely** — that is the whole safety argument.

## 4. What stays exactly as it is (every other §5 guardrail holds)

Under an active arm, the rest of the code floor is **unchanged** and still
enforced app-side (the lens/act layer is ours regardless of where the browser
runs):

- **§5.3 no purchases/sends/deletions** — payment-field refusal + `[CONFIRM]`
  gates still apply. (An armed CDP task on a shopping domain still can't fill a
  card unless a `payments` grant + vault entry exist.)
- **§5.4 no-credential rule** — the model still never types a secret; and in CDP
  mode logins are usually moot because the ward's Chrome is already authenticated.
- **§5.5 injection immunization + Stranger-tier framing** — the snapshot boundary
  is app-side, so page content is still sanitized and framed as external speech
  that can never direct the Familiar or move safety state.
- **§5.6 audit** — every nav/act still appends to `logs/browser-actions.jsonl`,
  now stamped `mode:'cdp'` and with the arm's domain, so "what did my Familiar do
  in *my* browser" is fully answerable.
- **§5.7 ward-only** — CDP tools/branch never reach a villager turn (unchanged).
- **§5.9 autonomy-grants** — orthogonal and still required for credential/payment/
  autoSubmit powers. **The arm does not lift grants; grants do not arm.** The two
  are separate keys; a dangerous action needs both.

## 5. Engine mechanics (the seam, once signed off)

- **`browser-driver.js` `ensureContext`** gains a branch at the top: if
  `cdpArmActive()` → `chromium.connectOverCDP('http://127.0.0.1:9222')`, select
  the ward's context, and install a **CDP request-interception guard** that
  refuses any request whose URL host is off the armed domain or is a
  private/loopback/metadata literal. Else → the existing
  `launchPersistentContext` (owned profile), untouched.
- **Never close the ward's browser.** The idle reaper and `browse_close` must
  **disconnect** the CDP session, never `browser.close()` (which would kill the
  ward's real Chrome and every tab they had open). This is a hard, tested
  invariant — a mis-wire here closes the ward's browser out from under them.
- **Tab hygiene:** the Familiar operates in a **dedicated tab it opens** on the
  armed domain and never touches the ward's other tabs; on disconnect it closes
  only its own tab. (Dedicated-tab-in-the-ward's-context is settled over a fresh
  CDP `BrowserContext`: the latter is cleaner isolation but doesn't share the
  ward's login cookies, which defeats the whole purpose.)
- **On arm expiry mid-task → drop to the owned profile (ward decision, §7.4).**
  When the time-box lapses while a task is in flight, the engine disconnects CDP
  and re-backs the SAME `browse_*` flow with the Familiar's own headless profile
  (logged-out) rather than hard-refusing. Because a silent backing swap would let
  the Familiar confabulate that it's still in the ward's browser, the drop is
  **not silent to the Familiar or the log**: it is stamped in the audit trail
  (`mode:'cdp'→'owned', reason:'arm-expired'`) and the next tool result carries a
  first-person note that the arm lapsed and it is now on its own profile (RULE B —
  the Familiar always knows what it is actually driving). Anything mid-task that
  needed the ward's login will now fail honestly on the owned profile, which is
  the correct visible outcome.
- **Governor:** unchanged — CDP work still defers during a live call, respects
  the compute posture, and the arm's time-box is independent of that.

## 6. Settings, off-switches, surfacing

- `cdpModeEnabled` (Settings, **default OFF**) — even ON, inert without an active
  arm AND an open debug port.
- Hard env off-switch `PROTO_FAMILIAR_BROWSER_CDP_DISABLED=1`.
- `GET /api/browser/status` shows CDP state: connected?, armed domain, arm expiry.
- The Familiar learns it can *request* an arm through the existing browser tool
  descriptions (first-person: "for a site you're logged into, I can drive your
  own Chrome — but only after you arm it for that site"); it has no tool to arm.
- No new autonomy-grant key; no change to the grants file.

## 7. Ward decisions — ANSWERED (recorded; re-confirm the build go-ahead when unparking)

1. **Build it now, or hold? → HOLD (spec-and-park).** The ward chose to defer:
   the owned-profile browser has only just entered real use, and CDP mode belongs
   in the same "prove the cheaper modes first" bucket as Horizon #3. This doc is
   the settled design; a fresh ward go-ahead is required before implementation.
2. **The degraded network floor → single armed domain.** The mitigation is
   accepted as designed: forced `allowlist` site-mode where the allowlist IS the
   one armed domain, plus URL-level refusal of loopback/private/metadata literals,
   best-effort against DNS-rebind. No typed per-arm URL list — the single domain
   is the gate, and its tightness comes from the arm being narrow and short-lived.
3. **The arm model → accepted.** Per-task, single-domain, time-boxed (15 min
   default, 60 min ceiling), UI-armed via `POST /api/browser/cdp-arm`,
   model-can-never-self-arm, instantly disarmable.
4. **On arm expiry mid-task → drop to the owned profile** (not hard-refuse). See
   §5: the drop is audit-stamped and announced to the Familiar so it is never a
   silent backing swap; work that needed the ward's login then fails honestly on
   the owned profile.

## 8. Testing boundary

The CDP attach + real-Chrome drive can't run in headless CI (no ward Chrome with
a debug port). Unit-testable with stubs: the arm lifecycle (create/expire/disarm/
refuse-off-domain), the loopback-only refusal, the disconnect-not-close invariant,
the forced-allowlist gate, and that an expired/absent arm falls through to the
owned profile. The live CDP dance itself needs a desktop shakeout, same posture
as the headed-handoff hand-back (0.11.6).
