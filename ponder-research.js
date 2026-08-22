/**
 * ponder-research.js — unattended web research for a free-cycle ponder (§8.5).
 *
 * The Familiar, mid-ponder, can seek out sources instead of only recombining
 * what it already holds. This is deliberately NOT a tool-calling loop: in an
 * unattended context (no ward nearby to notice it acting oddly) the Familiar
 * gets LESS agency, not more. So the model only ever NAMES what to look up — a
 * few searches / URLs per round — and CODE does the bounded reads. It can follow
 * a trail across rounds (see a page, then ask for a link from it), but it can
 * never call a tool that acts on the world; reads are idempotent, acts are not.
 *
 * Everything is bounded in code: `ponderWebRoundsPerTick` rounds, and the shared
 * daily read budget (ponder-web-budget.js). Reads go through the browser when
 * it's available (live JS DOM), else the static floor. Each read is audited with
 * surface:'pondering' so "what did my Familiar read while I was away" is one
 * query. Returns provenance-stamped sources for the ponder to cite.
 */

import { searchWeb, lookUp, readWebpage } from './websearch.js';
import { readsRemaining, recordReads } from './ponder-web-budget.js';
import { logBrowserAction } from './browser-audit.js';

function clampRounds(settings) {
  const n = Number(settings?.ponderWebRoundsPerTick);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : 4;
}

const PLAN_PROMPT = (topic, found, left) =>
`I'm pondering "${topic}" in a free cycle, and I can look a few things up before I write. I have ${left} read(s) left today.

${found.length ? `What I've already pulled:\n${found.map((s, i) => `${i + 1}. ${s.ref} — ${String(s.excerpt).slice(0, 200)}`).join('\n')}\n` : 'I haven\'t looked at anything yet.\n'}
What (if anything) do I want to look up NEXT to think about this more honestly? I answer ONLY with JSON, no prose:
{"searches": ["a web search query", …], "reads": ["https://a-url-i-already-know-or-just-found"], "done": false}
- searches: 0–2 web searches (leave empty if none).
- reads: 0–2 URLs to actually read (only URLs I already have — from what I pulled, or ones I'm certain of).
- done: true if I've got enough to write, or I don't actually need to look anything up.
Keep it small — I don't need to read the whole internet to have a thought.`;

function parsePlan(raw) {
  try {
    const m = String(raw).match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    return {
      searches: Array.isArray(o.searches) ? o.searches.filter(s => typeof s === 'string' && s.trim()).slice(0, 2) : [],
      reads:    Array.isArray(o.reads) ? o.reads.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 2) : [],
      done:     o.done === true,
    };
  } catch { return { searches: [], reads: [], done: true }; }
}

async function readOne(url, settings, deps) {
  // Browser-backed live-DOM read when available, else the static floor.
  try {
    if (deps.shouldBrowserRead?.(settings)) {
      const r = await deps.browseRead({ url }, { settings, sessionId: 'pondering' });
      if (r?.ok) return r.text;
    }
  } catch {}
  return deps.readWebpage(url, settings);
}

/**
 * Gather sources for a ponder topic. Returns { sources:[{kind,ref,excerpt}],
 * readsUsed, budgetSpent }. `budgetSpent` is true when today's budget was
 * already 0 (the ponder prompt then says so honestly). Never throws.
 *
 * Deps are injectable for tests: { callLLM, searchWeb, lookUp, readWebpage,
 * shouldBrowserRead, browseRead, remaining, record }.
 */
export async function researchForPonder({ topic, provider, apiKey, model, callLLM, settings = {} }, deps = {}) {
  const d = {
    searchWeb, lookUp, readWebpage,
    remaining: readsRemaining, record: recordReads,
    ...deps,
  };
  const label = typeof topic === 'string' ? topic.trim() : '';
  if (!label || typeof callLLM !== 'function') return { sources: [], readsUsed: 0, budgetSpent: false };
  if (d.remaining(settings) <= 0) return { sources: [], readsUsed: 0, budgetSpent: true };

  const sources = [];
  let readsUsed = 0;
  const rounds = clampRounds(settings);
  for (let r = 0; r < rounds; r++) {
    const left = d.remaining(settings);
    if (left <= 0) break;
    let plan;
    try { plan = parsePlan(await callLLM({ provider, apiKey, model, prompt: PLAN_PROMPT(label, sources, left) })); }
    catch { break; }
    if (plan.done || (!plan.searches.length && !plan.reads.length)) break;

    for (const q of plan.searches) {
      if (d.remaining(settings) <= 0) break;
      try {
        const res = await d.searchWeb(q, settings);
        const rows = Array.isArray(res?.rows) ? res.rows : (Array.isArray(res) ? res : []);
        const excerpt = rows.slice(0, 3).map(x => `${x.title || ''} <${x.url || ''}>`).join(' · ') || String(res).slice(0, 200);
        sources.push({ kind: 'search', ref: q, excerpt });
        readsUsed++; d.record(1, settings);
        logBrowserAction({ tool: 'ponder_search', target: q, verdict: excerpt.slice(0, 120), sessionId: 'pondering' });
      } catch {}
    }
    for (const url of plan.reads) {
      if (d.remaining(settings) <= 0) break;
      try {
        const text = await readOne(url, settings, d);
        sources.push({ kind: 'read', ref: url, excerpt: String(text || '').replace(/^---[\s\S]*?---\n/, '').slice(0, 800) });
        readsUsed++; d.record(1, settings);
        logBrowserAction({ tool: 'ponder_read', target: url, verdict: 'read (pondering)', sessionId: 'pondering' });
      } catch {}
    }
  }
  return { sources, readsUsed, budgetSpent: false };
}

/** A block for the ponder prompt naming what was found (cite these). */
export function sourcesBlock(sources) {
  if (!sources?.length) return '';
  const lines = sources.map((s, i) => `[${i + 1}] (${s.kind}) ${s.ref}\n    ${String(s.excerpt).replace(/\s+/g, ' ').slice(0, 400)}`);
  return `\n\nBefore writing, I looked into this. Here's what I actually found — I lean on THIS, not a confident guess, and I cite what shaped a thought (the source url), plainly:\n${lines.join('\n')}`;
}
