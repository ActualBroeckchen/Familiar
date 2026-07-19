# UI / UX guidelines — designing for overwhelm

Familiar's primary users include people dealing with executive
dysfunction, ADHD, anxiety, and depression. The UI is not a neutral surface
for them — a cluttered screen is a real barrier to using the Familiar at
all. These guidelines are binding for every UI change; they distill the
cognitive-accessibility literature (sources at the bottom) into rules this
codebase actually follows.

## The five rules

### 1. One thing at a time (progressive disclosure)

Show the control; hide the lecture. Every explanation longer than one short
sentence lives behind a **ⓘ toggle** (the shared `.field-hint` disclosure —
see below), collapsed by default. Wizards beat long forms; a list's detail
lives in the detail pane, not the row.

- The more options visible at once, the harder every decision gets (Hick's
  law — and it bites harder with ADHD). Group, collapse, and stage.
- **Exception:** safety-relevant text (what a toggle exposes to the
  network, what an outreach feature will share about the user) stays
  visible. Mark those hints `hint-keep`.

### 2. Nothing hides offscreen without a cue

If content can overflow, the overflow must be *visible* (edge fade, arrow,
scrollbar) and reachable by touch, wheel, and keyboard. Tab bars use the
shared scrollable-tabs pattern (`.ke-tabs`): they scroll horizontally, show
edge fades while more tabs exist, and auto-scroll the active tab into view.
Never let a fixed-width row silently clip its children.

### 3. Calm by default

No auto-playing motion, no aggressive animation, nothing pulsing for
attention unless it is genuinely urgent (a crisis banner may; a version
badge may not). Respect `prefers-reduced-motion` everywhere. Whitespace is
a feature: generous spacing between groups, one visual hierarchy per
screen, at most one accent-colored primary action per view.

### 4. Lists must scale past ten items

Any list a user grows over time (villagers, memories, tomes, schedule)
needs, from the start: a **search/filter box**, a stable sort, compact rows
(one line of summary, details on tap), and counts. A wall of full-detail
cards is unusable at twenty entries — design for fifty.

### 5. Say it like a person, once

Microcopy is short, plain, and non-repeating. The label names the thing;
the collapsed hint explains it; nothing explains it twice. Prefer "Quiet
hours" + hint over a paragraph beside every control. Error text says what
happened and what to do next.

## The shared components (use these, don't reinvent)

| Component | Where | What it does |
|---|---|---|
| Scrollable tabs | `.ke-tabs` (style.css) + `initScrollableTabs()` (app.js) | Horizontal scroll + edge fades + active-tab auto-scroll on every `role="tablist"` row |
| Disclosure hints | `.field-hint` + `enhanceHints()` (app.js) | Every hint collapses to a ⓘ toggle automatically (MutationObserver — works for dynamically rendered panes too). `hint-keep` opts out. |
| Full-screen sheets | `.modal` mobile rules (style.css) | On phones every modal is a full-height sheet with sticky header and internally scrolling body |
| Structured grant editor | `vlRenderCatDetail` (app.js) | Known grants render as labeled selects with plain-language options; free-text rows only for unknown/custom keys |
| Model browser | Connections modal + `POST /api/models` | Visible, clickable list of the provider's actual models — never only a type-to-discover datalist |
| Sidebar nav | `SIDEBAR_NAV` + `initSidebarNav()` (app.js) | Master-detail settings: searchable grouped menu → one section at a time with a back button; advanced group hidden until "Show advanced settings" (first-run essentials mode, synced as `uiShowAdvanced`) |
| List search | `.vl-search` + cached-render pattern | Villagers, KE memories, and TE schedule lists filter a cached fetch live (no refetch per keystroke) and show an N-of-M count |
| Icons | `public/icons.js` (vendored Material Symbols) + `data-ms-icon` / `msIcon()` | One icon language app-wide, fully offline (inline SVG paths, Apache-2.0). Static markup uses `data-ms-icon="name"`; templates call `msIcon('name')`. Icons are decorative — the owning control carries the accessible name. |

## Testing changes

**Run the full walk, not a sample.** `node scripts/ui-walk.mjs` screenshots
EVERY modal, tab, and view at phone size, flags horizontal overflow and
unthemed (white) native controls automatically, and leaves the shots for
you to actually look at. Sampled verification is how the graph-map mobile
bug shipped — "the modals are responsive" was checked on a few panes and
extrapolated to the rest. Also check a narrow desktop window (modals are
user-resizable — a 500px-wide modal must still work), keyboard focus
visibility, and contrast per the WCAG tokens (CLAUDE.md "hold the WCAG
line").

Two structural rules the walk exists to enforce:
- **Fixed-height containers must fill**: a pane inside a fixed-height
  modal gets its height from the flex chain (`.ke-body { flex:1 }`) — a
  canvas or list that sizes itself from a collapsed parent renders tiny
  with a void below.
- **Form controls are themed at the element level** (base
  `input/select/textarea` rules in style.css) — never rely on a scoped
  wrapper class to theme a control; anything that escapes the scope
  renders white browser chrome.
- **Every fixed-position surface that holds a text input must track the
  soft keyboard** — size it from `--app-h` (the visual-viewport height)
  or anchor it with `--kb-inset`; `bottom: 0` / `100dvh` are the LAYOUT
  viewport, which sits behind the keyboard on iOS Safari and Firefox
  Android. Gotcha: `backdrop-filter` (on `.modal-backdrop`) makes the
  backdrop the containing block for fixed descendants, so inside a modal
  `bottom: 0` already means "the keyboard's top" — don't add the inset
  twice.

## Sources

- [Software accessibility for users with attention deficit disorder](https://www.carlociccarelli.com/post/software-accessibility-for-users-with-attention-deficit-disorder)
- [How to design for ADHD and neurodiversity in UX — Welcoming Web](https://welcomingweb.com/learn/designing-for-neurodiversity-adhd-ux)
- [The Principles of Neurodivergent UX Design](https://www.accessibilitychecker.org/blog/neurodivergent-ux-design/)
- [Designing Digital Content For Users With Cognitive Disabilities — Section508.gov](https://www.section508.gov/design/digital-content-users-with-cognitive-disabilities/)
- [Progressive disclosure in UX design — LogRocket](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- [What is Progressive Disclosure? — Interaction Design Foundation](https://ixdf.org/literature/topics/progressive-disclosure)
- [Improving Site Usability: Design Tactics for Cognitive Disabilities — A11Y Collective](https://www.a11y-collective.com/blog/designing-for-cognitive-disabilities/)
- [Neurodiversity and UX — Stéphanie Walter](https://stephaniewalter.design/blog/neurodiversity-and-ux-essential-resources-for-cognitive-accessibility/)
