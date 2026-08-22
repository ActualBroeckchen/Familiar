/**
 * Context-sensitive tool surfacing (docs/tool-surfacing-build-spec.md).
 *
 * Decides WHICH tool modules travel on a turn — never what any tool does.
 * All decisions are cheap code (regex + block markers + a sticky TTL);
 * no LLM ever picks the tool set. The safety floor: CORE modules (incl.
 * both crisis tools and request_tools, the Familiar's own hand on the
 * toolbox lid) are ALWAYS advertised, regardless of triggers or settings.
 *
 * ⚠ Safety-adjacent per CLAUDE.md: changes to CORE membership or the
 * crisis rules need human sign-off.
 *
 * Recovery contract (the reason auto-surfacing is legal at all under the
 * "reachable BY the Familiar" rule): request_tools carries the full module
 * index in its always-visible description, and pulls a module's tools into
 * the SAME turn (next round of the tool loop). A miss costs one round.
 */

// ── Module map: every Familiar-facing tool belongs to exactly one ──────
// module. A parity test asserts full coverage of BUILTIN_TOOLS, so adding
// a tool without a module fails the suite instead of silently vanishing.
export const TOOL_MODULES = {
  // core — always advertised (time, memory in/out, id discovery, filing,
  // interests (human's call: they're character, not task), safety, the lid)
  get_datetime: 'core', get_session_info: 'core',
  recall: 'core', recall_timeframe: 'core', save_memory: 'core', save_to_tome: 'core',
  update_identity: 'core', schedule_find: 'core',
  interest_bump: 'core', interest_set_standing: 'core',
  bookmark_for_later: 'core',   // the Familiar's own initiative (nothing in a user msg triggers it) — always reachable, like the other interest-layer tools

  contact_trusted_person: 'core', show_crisis_resources: 'core',
  flag_distress: 'core',   // safety: the Familiar's own read of distress → threat (ward-signed)
  get_trusted_contacts: 'core',   // pairs with contact_trusted_person
  request_tools: 'core',

  // schedule, split read/write (human's call: reads need result-reading,
  // writes don't — and they trigger differently)
  schedule_export: 'schedule-read',
  schedule_add_event: 'schedule-write', schedule_add_task: 'schedule-write',
  schedule_add_reminder: 'schedule-write', schedule_add_phase: 'schedule-write',
  schedule_add_need: 'schedule-write', schedule_assign_time: 'schedule-write',
  schedule_snooze_task: 'schedule-write', schedule_resolve: 'schedule-write',
  schedule_delete: 'schedule-write', schedule_link: 'schedule-write',
  schedule_push_to_google: 'schedule-write',  // keeps its gcalWriteEnabled gate too
  template_upsert: 'schedule-write', template_delete: 'schedule-write',
  template_apply: 'schedule-write', template_list: 'schedule-read',
  gcal_list_calendars: 'schedule-read', gcal_attribute_calendar: 'schedule-write',
  schedule_add_hold: 'schedule-write', schedule_availability: 'schedule-read',
  schedule_set_lead: 'schedule-write',   // per-event alert lead (Initiative Pass 5)
  schedule_calibrate_link: 'schedule-write',   // grade a forecast after the fact (causal-chain fix)

  'memory-edit': undefined, // (namespace note only — real entries below)
  read_memory: 'memory-edit', read_memory_by_id: 'memory-edit',
  update_memory: 'memory-edit', update_memory_by_id: 'memory-edit',
  delete_memory: 'memory-edit', delete_memory_by_id: 'memory-edit',
  list_memories: 'memory-edit', move_memory_date: 'memory-edit',
  memorize_now: 'memory-edit',
  rewrite_identity_section: 'memory-edit',

  create_graph_node: 'graph', find_graph_node: 'graph',
  update_graph_node: 'graph', delete_graph_node: 'graph',
  create_graph_edge: 'graph', find_graph_edges: 'graph',
  update_graph_edge: 'graph', delete_graph_edge: 'graph',

  village_lookup: 'village', village_upsert: 'village',
  relay_message: 'village',

  web_search: 'web', read_webpage: 'web', look_up: 'web',

  // weather — the sky over my human's day (W-B). Surfaced by leaving-the-house
  // language and by the readiness/stewardship agenda + a new outside event
  // landing on the calendar (exactly when the weather matters).
  weather_today: 'weather', set_current_location: 'weather',

  acknowledge_deferred_intent: 'acks', snooze_deferred_intent: 'acks',
  list_deferred_intents: 'acks', drop_deferred_intent: 'acks',
  memory_confirm_consent: 'acks', memory_drop_pending: 'acks',
  graduation_acknowledge: 'acks',
  disclosure_acknowledge: 'acks', keep_memory_private: 'acks',
  // Reading my own recent thought in full — the expand path for the pondering
  // index, which renders on every ward turn, so the tool must always be reachable
  // (like recall). Ward-only: it's absent from the villager allowlist, so a
  // villager can never read my private ponderings through it.
  read_pondering: 'core',

  list_files: 'files', read_file: 'files',

  convert_ids_to_slugs: 'maintenance',

  set_day_start_anchor: 'stewardship',

  // intentions — my own forward commitments and rounds (Initiative Pass 3).
  // Surfaced by intent-setting/round language OR by the due-intentions block
  // travelling with its tools (a payoff turn brings the tools to act).
  intention_set: 'intentions', intention_list: 'intentions',
  intention_drop: 'intentions', intention_done: 'intentions',
  intention_mark_fired: 'intentions',
  intention_visibility: 'intentions',

  // vision (vision build spec §6.5/§10) — looking again at an image + tying it
  // to a graph node. Surfaced whenever an image stand-in is in context.
  view_image: 'media', link_image_to_node: 'media', unlink_image_from_node: 'media',

  // browser (browser build spec §4) — the Familiar's own hands on the web.
  // Surfaced by URLs + browse-ish verbs; ward-only executors, so a villager
  // turn never reaches them even if the module is advertised.
  browse_open: 'browser', browse_see: 'browser', browse_act: 'browser', browse_close: 'browser',
  browse_screenshot: 'browser', browse_tabs: 'browser', browse_history: 'browser', browse_handoff: 'browser',
  watch_page: 'browser', list_page_watches: 'browser', unwatch_page: 'browser',
};
delete TOOL_MODULES['memory-edit']; // the namespace note above, not a tool

export const CORE = 'core';
export const ALL_MODULES = [...new Set(Object.values(TOOL_MODULES))];

// Human-readable index for request_tools' description — generated from the
// map so it can't drift from reality.
export const MODULE_INDEX =
  'schedule-write (add/re-time/snooze/resolve/delete/link calendar items, requirement templates, push to Google), ' +
  'schedule-read (export an item as .ics/link, list requirement templates), ' +
  'memory-edit (read/update/delete/list/move my memories, memorize-now, rewrite identity sections), ' +
  'graph (my knowledge web: nodes + relationships), ' +
  'village (the people around my human: lookup/upsert, relay, Discord DM), ' +
  'web (search, read pages, look up facts), ' +
  'weather (the sky over my human\'s day today/tomorrow, and moving between their saved places), ' +
  'acks (inspect/file/snooze/drop my own pending deferred intents & tells, confirm/drop memory consent, graduation notices), ' +
  'files (list/read my own folder), ' +
  'maintenance (id tidy-up), ' +
  'stewardship (set the day-start time I open my human\'s day on), ' +
  'intentions (my own forward commitments and rounds: set/list/drop/complete, keep my rounds legible to my human or private), ' +
  'media (look again at an image shared earlier, tie an image to someone/something in my graph), ' +
  'browser (open a web page in my own browser and use it — click, fill, scroll, follow a flow — when reading isn\'t enough)';

// ── Triggers ───────────────────────────────────────────────────────────
// A module surfaces when its regex matches the turn text (user message +
// the Familiar's previous reply) OR a marker block is present in the
// injected dynamic context. Deliberately "somewhat generous" (human's
// words): a false positive costs a few hundred tokens once; a false
// negative costs one request_tools round. Tuned from the miss log.
const TRIGGERS = {
  'schedule-write': {
    text: /\b(remind(er)?s?|schedul\w*|calendar|appointment|task|to-?dos?|deadline|due|postpone|resched\w*|cancel\w*|snooze|every (day|week|month|morning|night)|routine|phase|tonight|tomorrow|next (week|month)|at \d{1,2}([:.]\d{2})?\s?(am|pm)\b|\d{1,2}([:.]\d{2})\s?(am|pm)?\b|done with|finished|habit|meal|meds|medication|template|prerequisite|before I (can|go)|leaving the house|clean clothes|laundry|hold\b|keep (\w+ )?(free|clear)|block off|protect (the |my )?(day|time))\b/i,
    // Blocks that invite schedule ACTION travel with the write tools. The
    // stewardship agenda offers aging floaters a place → I need the write
    // tools to give them a time on the spot.
    blocks: ['[Surface candidates', "[New on my human's calendar", '[My stewardship',
      // The projection cue + the hindsight questions both invite link work
      // (schedule_link / schedule_calibrate_link) — the tools travel with them.
      '[Coming up with nothing hanging off it yet]', 'Recently past, not yet examined'],
  },
  stewardship: {
    text: null,  // block-driven: the anchor-adjust tool travels with the agenda
    blocks: ['[My stewardship'],
  },
  'schedule-read': {
    text: /\b(export|\.ics|add (it |this )?to (my|the|your) calendar|calendar (file|link)|template|shared calendar|whose calendar|calendars?\b|availab(le|ility)|free\/busy|am I free|when (am|are) (I|you) free)\b/i,
    blocks: [],
  },
  'memory-edit': {
    text: /\b(memor(y|ies)|remember(ed)?\b|forget|you (said|told|mentioned)|last (time|week|month)|back (then|when)|journal|diary|wrong date|that day)\b/i,
    blocks: [],
  },
  graph: {
    text: /\b(relationship(s)? (between|with)|connected|knows?\b|who (is|was) \w+ to|graph|web of)\b/i,
    blocks: [],
  },
  village: {
    text: /\b(discord|relay|dm\b|message (to|for|from)|tell (them|him|her)|villager|the village|send \w+ a)\b/i,
    blocks: ['[CARE CHECK'],  // trusted-contact-adjacent flows
  },
  web: {
    text: /\b(search|look (it|this|that|him|her|them)? ?up|google|online|internet|web(site|page)?|news|weather|price of|what does .{1,40} mean|definition)\b/i,
    blocks: [],
  },
  browser: {
    // Using a page, not just reading it: a URL, or interaction verbs. Generous
    // by design — the ward-only executors mean a stray match costs only tokens.
    text: /(https?:\/\/\S+|\bwww\.\S+|\b(open (the |that |this )?(page|site|link|url|tab)|browse|click|fill (in|out)?|log ?in|sign ?in|log into|check ?out|add to (cart|basket)|book (a|the|it)|order (it|the|a)|navigate|on (the|that) (site|page|website)|submit the form|scroll (down|the page))\b)/i,
    blocks: [],
  },
  weather: {
    // Leaving-the-house / outdoor language (generous, per the miss-log rule):
    // a false surface costs a few hundred tokens; a missed one, a request_tools
    // round while my human is deciding whether to go out.
    text: /\b(weather|forecast|rain(ing|y)?|snow(ing)?|umbrella|sunny|cloud(y|s)?|storm|windy?|heat\b|hot out|cold out|freezing|outside|go(ing)? out|head(ing)? (to|out)|errand|walk\b|hike|cycl(e|ing)|drive over|leave the house|leaving the house|hang (the )?laundry|dress warm|coat\b|jacket)\b/i,
    // A new outside event on the calendar, and the readiness/stewardship agenda,
    // are exactly when the sky matters — the tools travel with them.
    blocks: ["[New on my human's calendar", '[My stewardship'],
  },
  acks: {
    // Block-driven (the notice + its tools travel together) AND text-driven:
    // language about my OWN pending queue surfaces list/drop/acknowledge so I
    // can audit it on demand — the block only appears when the system decides
    // to, so I need a way to reach the queue myself (the "reachable BY the
    // Familiar" rule). Generous by design: a false surface costs a few hundred
    // tokens once; a miss, one request_tools round.
    text: /\b(deferred intents?|pending (tells?|intents?)|my tells?\b|things? I (meant|wanted) to (tell|say|bring up)|already (told|said|answered|covered) (that|it|you)|audit (my|the) (tells?|intents?|queue))\b/i,
    blocks: ['[Deferred intents from my free time]', '[PENDING MEMORY CONSENT', '[GRADUATION NOTICE'],
  },
  files: {
    text: /\b(your (files|folder|logs?)|session log|our (conversation|chat|talk) (on|from|about)|read (the|your) \w+ (file|log|tome))\b/i,
    blocks: [],
  },
  maintenance: {
    text: /\b(convert|tidy|migrate|old ids?|hex ids?)\b/i,
    blocks: [],
  },
  intentions: {
    // Intent-setting / round language, plus follow-through phrasing. Generous
    // by design (the "somewhat generous" rule) — a missed surface costs one
    // request_tools round; over-surfacing a few hundred tokens once.
    text: /\b(intention|inten(d|ding)|from now on|every (morning|noon|afternoon|evening|day|night)|each (morning|day|phase)|my round|rounds\b|remind myself|note to self|follow[ -]?up|check in on|keep an eye on|next time (I|we)|when I (next|get)|going forward|make a habit|going to start)\b/i,
    // The due-intentions block travels with the tools so a payoff turn can act
    // on what's come due (mark fired / complete / adjust).
    blocks: ['[Intentions coming due]'],
  },
  media: {
    // Surfaced by look-again / recognition language, OR whenever an image
    // stand-in is in context (the `[image <id>: …]` marker) — that's exactly
    // when view_image / link_image_to_node become reachable and useful.
    text: /\b(look again|see (it|that|the (photo|picture|image))|which (photo|picture|image)|the (photo|picture|image) (of|I sent|you sent)|recognise|recognize|is (that|this) (the same|my)|tag (the|this) (photo|picture|image)|whose (photo|picture))\b/i,
    blocks: ['[image '],
  },
};

/**
 * Extra dynamic pattern: any registered villager name in the turn text
 * surfaces the village module. Names are escaped; 1–2 char names skipped
 * (too collision-prone).
 */
export function villagerNameRegex(names = []) {
  const safe = names
    .filter(n => typeof n === 'string' && n.trim().length >= 3)
    .map(n => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return safe.length ? new RegExp(`\\b(${safe.join('|')})\\b`, 'i') : null;
}

/**
 * Diagnostic: explain WHY each module would surface for a turn — which regex
 * matched which substrings, which block markers were present, which villager
 * names hit. Pure; drives the ward-facing regex tracer (no effect on live
 * selection). Returns [{ module, textMatches:[...], blockMatches:[...], via }].
 */
export function explainSelection({ turnText = '', dynamicBlock = '', villagerNames = [] } = {}) {
  const collect = (re, hay) => {
    if (!re) return [];
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return [...new Set([...String(hay).matchAll(g)].map(m => m[0]).filter(Boolean))];
  };
  const out = [];
  for (const [mod, trig] of Object.entries(TRIGGERS)) {
    const textMatches = collect(trig.text, turnText);
    const blockMatches = (trig.blocks || []).filter(b => dynamicBlock.includes(b));
    if (textMatches.length || blockMatches.length) out.push({ module: mod, textMatches, blockMatches });
  }
  const nameRe = villagerNameRegex(villagerNames);
  const nameMatches = collect(nameRe, turnText);
  if (nameMatches.length) out.push({ module: 'village', textMatches: nameMatches, blockMatches: [], via: 'villager-name' });
  return out;
}

/**
 * Pick this turn's modules. Pure — sticky state is passed in/out.
 *
 * @param {object} p
 * @param {string} p.turnText      user message + previous assistant reply
 * @param {string} p.dynamicBlock  the assembled injected context (markers)
 * @param {string[]} [p.villagerNames]
 * @param {Set<string>} [p.sticky] modules still inside their sticky TTL
 * @returns {Set<string>} modules to advertise (core NOT included — it's
 *          implicit and unconditional at the compose layer)
 */
export function selectModules({ turnText = '', dynamicBlock = '', villagerNames = [], sticky = new Set() } = {}) {
  const out = new Set(sticky);
  for (const [mod, trig] of Object.entries(TRIGGERS)) {
    if (trig.text && trig.text.test(turnText)) { out.add(mod); continue; }
    if (trig.blocks.some(m => dynamicBlock.includes(m))) out.add(mod);
  }
  const nameRe = villagerNameRegex(villagerNames);
  if (nameRe && nameRe.test(turnText)) out.add('village');
  return out;
}

// ── Sticky TTL (per session, in-memory) ────────────────────────────────
// A module surfaced/used/requested stays for `stickyTurns` further live
// turns (default 2 — ward-tunable via toolStickyTurns). Server restart
// clears it; worst case is one request_tools round.
const _sticky = new Map();  // sessionId → Map(module → remaining turns)

export function stickyModulesFor(sessionId) {
  const m = _sticky.get(sessionId);
  return m ? new Set(m.keys()) : new Set();
}

/** Advance one live turn: decay TTLs, then refresh the surfaced set. */
export function tickSticky(sessionId, surfacedModules, stickyTurns = 2) {
  if (!sessionId) return;
  const ttl = Math.max(0, Math.min(10, Number(stickyTurns) || 0));
  let m = _sticky.get(sessionId);
  if (!m) { m = new Map(); _sticky.set(sessionId, m); }
  for (const [mod, left] of m) (left <= 1) ? m.delete(mod) : m.set(mod, left - 1);
  if (ttl > 0) for (const mod of surfacedModules) m.set(mod, ttl);
  if (_sticky.size > 200) _sticky.delete(_sticky.keys().next().value); // drift cap
}

export function resetSticky() { _sticky.clear(); }

/** Validate request_tools input → known module names ('all' → every one). */
export function normalizeRequestedModules(raw) {
  const asked = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean);
  if (asked.includes('all')) return { modules: ALL_MODULES.filter(m => m !== CORE), unknown: [] };
  const known = [], unknown = [];
  for (const a of asked) (ALL_MODULES.includes(a) && a !== CORE ? known : unknown).push(a);
  return { modules: known, unknown };
}
