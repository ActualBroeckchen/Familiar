#!/usr/bin/env node
/**
 * build-prompt-catalog.mjs — a standalone, re-runnable review page for every
 * prompt the Familiar reads.
 *
 * Why this exists: the prompts ARE the Familiar's voice and judgment — the
 * behaviour-shaping text is scattered across ~15 files, some safety-critical.
 * To "go over all the prompts" you shouldn't have to grep the tree. This script
 * reads the LIVE source each run and emits one self-contained HTML page:
 * each prompt's text, the file + line it lives at, a one-line note on what it's
 * for, a copy button, and a search box over everything. Tool descriptions (the
 * other thing the model reads every turn) come straight from BUILTIN_TOOLS.
 *
 * It stays current because it extracts from source on every run — it never
 * stores a copy of a prompt here. Two ways a prompt is captured:
 *   - 'literal'  — the authored template/string literal is lifted verbatim from
 *                  source by a unique anchor (its opening words). Interpolations
 *                  like ${focusBlock} are shown as-authored, which is what you
 *                  want when reviewing wording. Handles adjacent "a" + "b"
 *                  string concatenation too.
 *   - 'render'   — the prompt is assembled by code with per-branch logic (the
 *                  [CARE CHECK] block), so we import the real function and render
 *                  each variant rather than guess at a single literal.
 *
 * If an anchor ever drifts, extraction FAILS LOUDLY naming the entry — an empty
 * prompt block is never emitted silently (a stale catalog that looks fine is
 * worse than one that refuses to build).
 *
 * Run:  node scripts/build-prompt-catalog.mjs   (or: npm run prompts:catalog)
 * Out:  docs/prompt-catalog.html   — open it in any browser, nothing to install.
 *
 * NOTE: this reads prompts that include the Familiar's own inner voice and the
 * ward's care-related framing. The output is a LOCAL file on purpose; it is not
 * meant to be published to any external service.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const STRING_DELIMS = new Set(['`', '"', "'"]);

// ── The catalogue ───────────────────────────────────────────────────────────
// Each entry names WHERE a prompt lives and WHAT it's for. The text itself is
// pulled from source at build time, never copied here. `anchor` must sit at the
// very start of the literal (the char before it is the opening ` " or ') and be
// unique in its file. Adding a prompt = one entry here.
const PROMPTS = [
  // ── Safety spine (ward sign-off governs the code around these) ──
  {
    id: 'triage', group: 'Safety spine', safety: true,
    title: 'Silence-triage deliberation',
    purpose: "When my human has gone quiet at an elevated threat tier, this decides whether — and how — I reach out. The single most safety-critical prompt: an earlier 'bias toward staying quiet' version once caused a 1.5-hour silence after stated intent.",
    file: 'cerebellum.js', anchor: '--- TRIAGE DELIBERATION ---',
  },
  {
    id: 'care-check', group: 'Safety spine', safety: true,
    title: '[CARE CHECK] injected block',
    purpose: 'The tier-by-tier care framing folded into the live turn when my human shows distress. Assembled per threat tier (mild → severe), so shown here rendered from the real function.',
    file: 'src/safety/care-check.js', mode: 'render',
  },
  {
    id: 'noticing', group: 'Safety spine', safety: true,
    title: 'Noticing deliberation',
    purpose: "My own turn: the organ that lets me notice something worth a look (a due intention, a contact gap, an aging task) and act without being asked. Uniquely, it keeps running at elevated threat — the tier shifts my register, never skips the turn.",
    file: 'src/safety/noticing.js', anchor: 'BRIEF MOMENT TO THINK',
  },

  // ── Warmth & companionship ──
  {
    id: 'reachout', group: 'Warmth & companionship',
    title: 'Warm reach-out deliberation',
    purpose: 'The non-crisis counterpart to triage: reaching out warmly to my human (or a warm villager) just because I have something, not because anything is wrong. Stands down entirely at moderate+ threat so it never competes with triage.',
    file: 'src/warmth/reachout.js', anchor: '--- A QUIET MOMENT ---',
  },

  // ── Free-cycle thinking ──
  {
    id: 'ponder-freecycle', group: 'Free-cycle thinking',
    title: 'Pondering (a free-cycle thought)',
    purpose: 'What I do when nobody is talking to me and I have a moment: pick an interest, actually think about it, and write it to my Ponderings tome in my own voice.',
    file: 'src/pondering/pondering.js',
    anchor: "I'm {{char}}. Nobody's talking to me right now, so I've got a bit of time to think.",
  },
  {
    id: 'ponder-reflection', group: 'Free-cycle thinking',
    title: 'Reflection (how my surfacings landed)',
    purpose: 'A different free-cycle mode: instead of pondering a topic, I reflect on how my recent proactive surfacings landed with my human, and whether I learned something worth keeping at the identity layer. Can end in a commitment (an intention for future-me).',
    file: 'src/pondering/pondering.js',
    anchor: "I'm {{char}}. Nobody's talking to me right now. This isn't my usual thinking",
  },
  {
    id: 'ponder-research', group: 'Free-cycle thinking',
    title: 'Pondering research plan',
    purpose: 'While pondering, this lets me decide what (if anything) to look up next before I write — a small JSON plan of searches/reads, bounded by a daily read budget.',
    file: 'src/pondering/ponder-research.js', anchor: 'I\'m pondering "',
  },

  // ── Memory ──
  {
    id: 'mem-ward', group: 'Memory',
    title: 'Memory extraction (my human, direct)',
    purpose: "After a private conversation, I look back and pull out what's worth keeping — facts about my human, about myself, and the plain web of connections between the people and things that came up. Emits JSON; a separate consent step gates what's actually stored.",
    file: 'src/memory/memorization.js',
    anchor: 'Ah, some unprocessed session logs.',
  },
  {
    id: 'mem-shared', group: 'Memory',
    title: 'Memory extraction (shared room)',
    purpose: "The group-room variant: I note what went on around me, including what other people did or said, WITHOUT pre-censoring — the consent step afterwards weighs each person by where they sit in my human's Village.",
    file: 'src/memory/memorization.js',
    anchor: 'Ah, some unprocessed session logs — and this was a shared room',
  },
  {
    id: 'tome-graduation', group: 'Memory',
    title: 'Tome-graduation routing rubric',
    purpose: 'The batched judgment that drains durable facts stranded in tomes into their right canonical home (identity / memory / graph). Leans toward graduating — over-gathering is cheap because consolidation prunes; missing something that matters is not.',
    file: 'src/tomes/tome-graduation-loop.js',
    anchor: "I'm tidying knowledge that's been sitting in my tomes",
  },
  {
    id: 'content-regate', group: 'Memory', safety: true,
    title: 'Content-regate disclosure judgment',
    purpose: "Going back through my own ward-private notes and deciding, per fact, whether each should stay strictly between us or be governed by my normal content-sharing rules. Fails closed to 'keep private' — this is disclosure, the one narrow cost worth real care.",
    file: 'src/memory/content-regate.js',
    anchor: "I'm going back through my own private notes about my human",
  },

  // ── Vision & voice ──
  {
    id: 'vision-describe', group: 'Vision & voice',
    title: 'Image description (look once, keep forever)',
    purpose: "When my human or a villager shares an image, I describe what I actually see in concrete detail so I can answer about it later without looking again. The description — not raw model prose — is what feeds memory and (for my human's own images) threat scoring.",
    file: 'src/vision/vision.js',
    anchor: 'I am looking at an image {{user}} (or a villager) shared with me.',
  },
  {
    id: 'media-retention', group: 'Vision & voice',
    title: 'Voice-clip retention judgment',
    purpose: "For aged voice clips, deciding which SOUNDS to keep vs let go (the transcript always survives either way). I keep the sound only when the sound itself is the point — a voice, a laugh, how it was said. When unsure, I let it go.",
    file: 'src/vision/media-retention.js',
    anchor: "I'm going back through some voice clips {{user}} and others sent me",
  },

  // ── The web-search explainer (guide chat) ──
  {
    id: 'guide-framing', group: 'Web-search guide',
    title: 'Guide chat — framing',
    purpose: "Who I am in the little in-settings chat where my human is choosing how I search the web: I explain the options at their pace, in my own voice, and I don't change any settings myself.",
    file: 'guide-chat.js',
    anchor: "I'm with {{user}} in my own settings, in the panel where they choose how I search the web.",
  },
  {
    id: 'guide-tools-info', group: 'Web-search guide',
    title: 'Guide chat — what I know about search',
    purpose: 'Everything I know about how I can search the web, so I can compare the options honestly rather than sell any of them.',
    file: 'guide-chat.js',
    anchor: 'Here is everything I know about how I can search the web for {{user}}',
  },
  {
    id: 'guide-no-jargon', group: 'Web-search guide',
    title: 'Guide chat — plain language',
    purpose: "A reminder to keep the explanation plain — no 'terminal' / 'server' / 'API' without saying what it means, checking my human is with me before moving on.",
    file: 'guide-chat.js',
    anchor: 'When I explain this, I keep it plain.',
  },
];

// ── Extraction ──────────────────────────────────────────────────────────────

/** Scan a string/template literal from just after its opening delimiter to the
 *  matching close, honouring escapes and (for backticks) ${…} interpolation
 *  brace depth. Returns { content, endIndex } where endIndex is the closing
 *  delimiter's index. */
function scanLiteral(text, openIdx, delim) {
  let i = openIdx + 1;
  let depth = 0; // ${…} brace depth, backtick only
  const isTemplate = delim === '`';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (isTemplate && depth === 0 && c === '$' && text[i + 1] === '{') { depth = 1; i += 2; continue; }
    if (isTemplate && depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++; continue;
    }
    if (c === delim) return { content: text.slice(openIdx + 1, i), endIndex: i };
    i++;
  }
  return null;
}

/** Lift the prompt at `anchor` from `fileText`. The anchor must sit at the very
 *  start of a string/template literal (the preceding char is its delimiter) and
 *  be unique. Adjacent `+`-concatenated literals are folded in. Throws on any
 *  ambiguity so a drifted anchor can't yield a silent empty block. */
function extractPrompt(fileText, anchor, label) {
  const first = fileText.indexOf(anchor);
  if (first === -1) throw new Error(`[${label}] anchor not found: ${JSON.stringify(anchor.slice(0, 48))}`);
  if (fileText.indexOf(anchor, first + 1) !== -1) throw new Error(`[${label}] anchor is not unique: ${JSON.stringify(anchor.slice(0, 48))}`);

  const openIdx = first - 1;
  const delim = fileText[openIdx];
  if (!STRING_DELIMS.has(delim)) {
    throw new Error(`[${label}] anchor is not at a literal start (char before it is ${JSON.stringify(delim)}, not a quote/backtick)`);
  }

  let piece = scanLiteral(fileText, openIdx, delim);
  if (!piece) throw new Error(`[${label}] unterminated literal at anchor`);
  let content = piece.content;

  // Fold adjacent concatenation:  "a" + "b" + `c`
  let cursor = piece.endIndex + 1;
  for (;;) {
    const m = /^\s*\+\s*/.exec(fileText.slice(cursor));
    if (!m) break;
    const nextIdx = cursor + m[0].length;
    const nextDelim = fileText[nextIdx];
    if (!STRING_DELIMS.has(nextDelim)) break;
    const next = scanLiteral(fileText, nextIdx, nextDelim);
    if (!next) break;
    content += next.content;
    cursor = next.endIndex + 1;
  }

  const line = fileText.slice(0, first).split('\n').length;
  return { text: content, line };
}

// ── Gather prompts ──────────────────────────────────────────────────────────
const fileCache = new Map();
function readRepoFile(rel) {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
  return fileCache.get(rel);
}

async function renderCareCheck(entry) {
  const mod = await import(join(ROOT, entry.file));
  const build = mod.buildCareCheckBlock;
  if (typeof build !== 'function') throw new Error(`[${entry.id}] buildCareCheckBlock not exported`);
  const tiers = ['mild', 'moderate', 'high', 'severe'];
  const blocks = tiers.map((tier) => {
    const weight = { mild: 0.30, moderate: 0.55, high: 0.75, severe: 0.95 }[tier];
    const text = build({ tier, weight });
    return `# ── tier: ${tier} ──\n${text}`;
  }).filter(Boolean);
  // Line of the function so "where it is" still points somewhere real.
  const src = readRepoFile(entry.file);
  const line = src.slice(0, src.indexOf('buildCareCheckBlock')).split('\n').length;
  return { text: blocks.join('\n\n'), line, rendered: true };
}

async function gatherPrompts() {
  const out = [];
  for (const entry of PROMPTS) {
    let res;
    if (entry.mode === 'render' && entry.id === 'care-check') {
      res = await renderCareCheck(entry);
    } else {
      res = extractPrompt(readRepoFile(entry.file), entry.anchor, entry.id);
    }
    out.push({ ...entry, text: res.text, line: res.line, rendered: !!res.rendered });
  }
  return out;
}

// ── Gather tools ────────────────────────────────────────────────────────────
async function gatherTools() {
  const mod = await import(join(ROOT, 'cerebellum.js'));
  const tools = mod.BUILTIN_TOOLS;
  if (!Array.isArray(tools)) throw new Error('BUILTIN_TOOLS not an array — cannot enumerate tools');
  const src = readRepoFile('cerebellum.js');
  return tools.map((t) => {
    const fn = t.function ?? t;
    const name = fn.name ?? '(unnamed)';
    const marker = `name: '${name}'`;
    const at = src.indexOf(marker);
    const line = at === -1 ? null : src.slice(0, at).split('\n').length;
    return { name, description: String(fn.description ?? '').trim(), line };
  });
}

// ── HTML ────────────────────────────────────────────────────────────────────
const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

// Data attribute for the copy button: the raw text, base64'd so quotes/newlines
// survive the HTML round-trip untouched (code canonicalises the value; nothing
// is hand-escaped into a JS string).
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function promptCard(p) {
  const badges = [];
  if (p.safety) badges.push('<span class="badge badge-safety" title="Behavioural changes here need human sign-off — see CLAUDE.md">safety sign-off</span>');
  if (p.rendered) badges.push('<span class="badge badge-note" title="Assembled by code — shown rendered from the real function">rendered</span>');
  const loc = `${esc(p.file)}${p.line ? ':' + p.line : ''}`;
  const hay = `${p.title} ${p.purpose} ${p.file} ${p.text}`.toLowerCase();
  return `
    <article class="card" data-hay="${esc(hay)}">
      <div class="card-head">
        <h3>${esc(p.title)}</h3>
        <div class="badges">${badges.join('')}</div>
      </div>
      <p class="purpose">${esc(p.purpose)}</p>
      <div class="loc"><span class="loc-path">${loc}</span>
        <button class="copy" data-b64="${b64(p.text)}">Copy prompt</button></div>
      <pre class="prompt">${esc(p.text)}</pre>
    </article>`;
}

function toolRow(t) {
  const hay = `${t.name} ${t.description}`.toLowerCase();
  const loc = t.line ? `cerebellum.js:${t.line}` : 'cerebellum.js';
  return `
    <article class="card tool" data-hay="${esc(hay)}">
      <div class="card-head">
        <h3><code>${esc(t.name)}</code></h3>
        <div class="loc"><span class="loc-path">${loc}</span>
          <button class="copy" data-b64="${b64(t.description)}">Copy</button></div>
      </div>
      <pre class="prompt">${esc(t.description)}</pre>
    </article>`;
}

function buildHtml({ prompts, tools, version }) {
  const groups = [];
  const seen = new Set();
  for (const p of prompts) {
    if (seen.has(p.group)) continue;
    seen.add(p.group);
    groups.push(p.group);
  }
  const promptSections = groups.map((g) => `
    <section class="grp" data-grp>
      <h2>${esc(g)}</h2>
      ${prompts.filter((p) => p.group === g).map(promptCard).join('')}
    </section>`).join('');

  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proto-Familiar — Prompt Catalog</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f6f3; --panel: #fffdfa; --ink: #23201c; --dim: #6b655c;
    --line: #e5e0d8; --accent: #7a5cff; --accent-ink: #fff;
    --safety: #b4421f; --safety-bg: #fbe9e3; --note: #3a6ea5; --note-bg: #e6eef7;
    --code-bg: #f2efe9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1815; --panel: #232019; --ink: #ece7de; --dim: #a49c8e;
      --line: #38332b; --accent: #a58cff; --accent-ink: #1a1815;
      --safety: #ff9a7a; --safety-bg: #3a221a; --note: #8fb8e6; --note-bg: #1e2a38;
      --code-bg: #14120f;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; background: var(--panel);
    border-bottom: 1px solid var(--line); padding: 16px clamp(16px, 4vw, 40px); }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0 0 12px; color: var(--dim); font-size: 13.5px; max-width: 70ch; }
  .search { width: 100%; max-width: 520px; padding: 10px 13px; font-size: 16px;
    border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--ink); }
  .meta { color: var(--dim); font-size: 12.5px; margin-top: 9px; }
  main { padding: 8px clamp(16px, 4vw, 40px) 80px; max-width: 1000px; margin: 0 auto; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--dim); margin: 34px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 11px;
    padding: 14px 16px; margin: 12px 0; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .card h3 { margin: 0; font-size: 16px; }
  .card h3 code { font-size: 15px; background: var(--code-bg); padding: 1px 7px; border-radius: 6px; }
  .purpose { margin: 6px 0 10px; color: var(--ink); font-size: 14px; }
  .badges { display: flex; gap: 6px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
  .badge-safety { color: var(--safety); background: var(--safety-bg); font-weight: 600; }
  .badge-note { color: var(--note); background: var(--note-bg); }
  .loc { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .loc-path { font: 12.5px ui-monospace, "SF Mono", Menlo, monospace; color: var(--dim);
    background: var(--code-bg); padding: 2px 8px; border-radius: 6px; }
  .copy { font-size: 12.5px; padding: 4px 11px; border: 1px solid var(--line);
    background: var(--accent); color: var(--accent-ink); border-radius: 7px; cursor: pointer; }
  .copy:hover { filter: brightness(1.06); }
  .copy.done { background: var(--panel); color: var(--dim); }
  .copy:focus-visible, .search:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  pre.prompt { margin: 0; white-space: pre-wrap; word-break: break-word;
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 13px; font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
    max-height: 340px; overflow: auto; }
  .tool .card-head { align-items: center; }
  .tool pre.prompt { max-height: 220px; }
  details.toolwrap > summary { cursor: pointer; font-size: 15px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--dim); margin: 34px 0 4px; padding-bottom: 6px;
    border-bottom: 1px solid var(--line); list-style: none; }
  details.toolwrap > summary::before { content: "▸ "; }
  details.toolwrap[open] > summary::before { content: "▾ "; }
  .empty { color: var(--dim); font-style: italic; padding: 20px 2px; display: none; }
  .count { color: var(--dim); font-weight: 400; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Proto-Familiar — Prompt Catalog</h1>
  <p>Every prompt the Familiar reads, lifted live from source. Each card shows what it's for, where it lives (file:line), the text as authored, and a copy button. The <span class="badge badge-safety" style="font-weight:600">safety sign-off</span> badge marks prompts whose behaviour needs human sign-off before changing.</p>
  <input class="search" id="q" type="search" placeholder="Search prompts &amp; tools… (try: threat, memory, reach out, recall)" aria-label="Search prompts and tools">
  <div class="meta">${prompts.length} prompts &middot; ${tools.length} tool descriptions &middot; v${esc(version)} &middot; generated ${esc(generated)} &middot; re-run <code>npm run prompts:catalog</code> to refresh</div>
</header>
<main>
  <p class="empty" id="empty">No prompt or tool matches that search.</p>
  ${promptSections}
  <details class="toolwrap" id="toolwrap" open>
    <summary>The Familiar's tools <span class="count">(${tools.length} descriptions the model reads every turn)</span></summary>
    <section class="grp" data-grp>
      ${tools.map(toolRow).join('')}
    </section>
  </details>
</main>
<script>
  // Copy buttons — decode the base64 payload so the copied text is byte-exact.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const text = new TextDecoder().decode(Uint8Array.from(atob(btn.dataset.b64), c => c.charCodeAt(0)));
    navigator.clipboard.writeText(text).then(() => {
      const old = btn.textContent; btn.textContent = 'Copied ✓'; btn.classList.add('done');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1400);
    });
  });
  // Live search over every card's data-hay; hides empty groups; shows a note.
  const q = document.getElementById('q');
  const cards = [...document.querySelectorAll('.card')];
  const groups = [...document.querySelectorAll('[data-grp]')];
  const empty = document.getElementById('empty');
  const toolwrap = document.getElementById('toolwrap');
  q.addEventListener('input', () => {
    const terms = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let anyVisible = false;
    for (const c of cards) {
      const hay = c.dataset.hay;
      const show = terms.every(t => hay.includes(t));
      c.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    }
    for (const g of groups) {
      const vis = [...g.querySelectorAll('.card')].some(c => c.style.display !== 'none');
      g.style.display = vis ? '' : 'none';
    }
    if (terms.length && toolwrap) toolwrap.open = true;
    empty.style.display = anyVisible ? 'none' : 'block';
  });
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const version = JSON.parse(readRepoFile('package.json')).version;
  const prompts = await gatherPrompts();
  const tools = await gatherTools();
  const html = buildHtml({ prompts, tools, version });
  const outPath = join(ROOT, 'docs', 'prompt-catalog.html');
  writeFileSync(outPath, html, 'utf8');
  console.log(`[prompt-catalog] wrote ${relative(ROOT, outPath)} — ${prompts.length} prompts, ${tools.length} tools (v${version})`);
}

// Run only when invoked directly (`node scripts/build-prompt-catalog.mjs`);
// importing for tests must NOT kick off a build.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => { console.error('[prompt-catalog] FAILED:', err.message); process.exit(1); });
}

export { scanLiteral, extractPrompt };
