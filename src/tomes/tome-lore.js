/**
 * tome-lore.js — the keyword-lorebook activation engine, server-side.
 *
 * Tomes (world-info / lorebook entries) are keyword-triggered context: when a
 * recent message mentions an entry's key, that entry's content is injected into
 * the prompt. This ran ONLY in the browser (`activateTomeEntries` in
 * public/app.js, over `state.tomeCache`), so it never fired on the server-side
 * Discord turn — the Familiar was blind to its own lore there. This is the
 * server engine that closes that gap.
 *
 * ⚠️ PARITY: this is a faithful port of the algorithm in public/app.js
 * (matchKeyword / testSecondaryLogic / scanLoreEntries / applyGroupLogic /
 * activateTomeEntries). app.js is a classic browser script (no ES modules), so
 * the two can't share one source without a build step — keep them in sync by
 * hand, and the tests here pin the behavior. If you change matching logic in
 * one, change it in the other.
 *
 * Pure: every input is injected (entries, messages, the current text, the
 * scan/recursion settings, optional context + timed-effects state + rng), so
 * the Discord gateway, a voice turn, or a test can all drive it the same way.
 */

// SillyTavern position codes → the five injection slots.
const POS = { before_char: 0, after_char: 1, sys_top: 2, sys_bottom: 3, at_depth: 4 };

export function normEntryPos(pos) {
  if (typeof pos === 'number') return pos;
  return POS[pos] ?? 0;
}

/** Normalise SillyTavern field aliases to native names (in place, like the client). */
export function normalizeEntry(entry) {
  if ('key' in entry && !('keys' in entry))              entry.keys            = entry.key;
  if ('order' in entry && !('insertion_order' in entry)) entry.insertion_order = entry.order;
  if ('disable' in entry && !('enabled' in entry))       entry.enabled         = !entry.disable;
  return entry;
}

/** `/regex/flags` keyword → RegExp, else null. */
export function parseKeywordRegex(kw) {
  const m = String(kw).match(/^\/(.+)\/([gimsuy]*)$/);
  if (!m) return null;
  try { return new RegExp(m[1], m[2] || ''); } catch { return null; }
}

/**
 * One keyword against the corpus. Per-entry caseSensitive / matchWholeWords
 * override the globals; `/regex/` syntax supported. `globals` carries the
 * tome-wide defaults ({ caseSensitive, matchWholeWords }).
 */
export function matchKeyword(haystack, keyword, entry = {}, globals = {}) {
  const re = parseKeywordRegex(keyword);
  if (re) return re.test(haystack);
  const cs = entry.caseSensitive ?? globals.caseSensitive ?? false;
  const ww = entry.matchWholeWords ?? globals.matchWholeWords ?? false;
  const h  = cs ? haystack : haystack.toLowerCase();
  const kw = cs ? keyword  : keyword.toLowerCase();
  if (ww) {
    const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)${kwEscaped}(?:$|\\W)`, cs ? '' : 'i').test(haystack);
  }
  return h.includes(kw);
}

/** Secondary keys per the entry's selectiveLogic: 0 AND_ANY,1 NOT_ANY,2 AND_ALL,3 NOT_ALL. */
export function testSecondaryLogic(corpus, entry, globals = {}) {
  const keys = (entry.keysecondary ?? []).filter(k => String(k).trim());
  if (!keys.length) return true;
  const logic = entry.selectiveLogic ?? 0;
  let allMatch = true;
  for (const kw of keys) {
    const m = matchKeyword(corpus, String(kw).trim(), entry, globals);
    if (!m) allMatch = false;
    if (logic === 0 && m)  return true;   // AND_ANY: first match wins
    if (logic === 1 && m)  return false;  // NOT_ANY: any match fails
    if (logic === 3 && !m) return true;   // NOT_ALL: first miss wins
  }
  if (logic === 0) return false;
  if (logic === 1) return true;
  if (logic === 2) return allMatch;
  if (logic === 3) return !allMatch;
  return true;
}

/** The last `depth` user/assistant messages + the current text (+ optional recursion extra). */
export function buildScanText(messages, userInput, depth, extra) {
  const d = Math.max(0, depth || 0);
  const relevant = (Array.isArray(messages) ? messages : []).filter(m => m.role === 'user' || m.role === 'assistant');
  const slice = d === 0 ? [] : relevant.slice(-d);
  const parts = [...slice.map(m => m.content || ''), userInput];
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join('\n');
}

/**
 * One activation scan pass. `getCorpus(scanDepthOverride, entry)` yields the
 * text to match against. `env` carries turnCount / generationMode / charName /
 * timedEffects / rng and the global case/whole-word defaults.
 */
function scanLoreEntries(entries, getCorpus, alreadyActivated, isRecursion, env) {
  const { turnCount = 0, generationMode = 'normal', charName = '', timedEffects = {}, rng = Math.random, globals = {} } = env;
  const out = [];
  for (const entry of entries) {
    normalizeEntry(entry);
    if (!entry.enabled) continue;
    if (alreadyActivated.has(entry.uid)) continue;
    if (isRecursion  && entry.excludeRecursion)    continue;
    if (!isRecursion && entry.delayUntilRecursion) continue;
    if ((entry.delay ?? 0) > 0 && turnCount < entry.delay) continue;
    if (entry.triggers?.length > 0 && !entry.triggers.includes(generationMode)) continue;
    if (entry.characterFilter) {
      const names = entry.characterFilter.names ?? [];
      if (names.length > 0) {
        const nameMatch = names.some(n => String(n).toLowerCase() === String(charName).toLowerCase());
        if (entry.characterFilter.isExclude ? nameMatch : !nameMatch) continue;
      }
    }
    const timed = timedEffects[entry.uid] ?? { stickyLeft: 0, cooldownLeft: 0 };
    if (timed.cooldownLeft > 0) continue;
    if (timed.stickyLeft  > 0) { out.push(entry); continue; }
    if (entry.constant) { out.push(entry); continue; }
    const prob = entry.probability ?? 100;
    if (prob < 100 && rng() * 100 > prob) continue;

    const corpus = getCorpus(entry.scanDepth ?? null, entry);
    const pkeys = (entry.keys ?? []).filter(k => String(k).trim());
    if (!pkeys.length) continue;
    if (!pkeys.some(k => matchKeyword(corpus, String(k).trim(), entry, globals))) continue;
    if (entry.selective && (entry.keysecondary ?? []).filter(k => String(k).trim()).length > 0) {
      if (!testSecondaryLogic(corpus, entry, globals)) continue;
    }
    out.push(entry);
  }
  return out;
}

/** Group exclusion: only the highest-weight (lowest insertion_order on tie) entry per group survives. */
export function applyGroupLogic(entries) {
  const groups = new Map();
  const result = [];
  for (const e of entries) {
    const g = String(e.group ?? '').trim();
    if (g) { const arr = groups.get(g) ?? []; arr.push(e); groups.set(g, arr); }
    else result.push(e);
  }
  for (const [, grp] of groups) {
    const pool = grp.some(e => e.groupOverride) ? grp.filter(e => e.groupOverride) : grp;
    pool.sort((a, b) => {
      const wA = a.groupWeight ?? 100, wB = b.groupWeight ?? 100;
      if (wA !== wB) return wB - wA;
      return (a.insertion_order ?? 100) - (b.insertion_order ?? 100);
    });
    result.push(pool[0]);
  }
  return result;
}

/**
 * Activate lore for a turn. Faithful mirror of app.js's activateTomeEntries.
 *
 * @param {object[]} tomes     enabled/disabled tomes, each { enabled?, entries }
 *                             (entries a map OR array of entry objects).
 * @param {object[]} messages  recent turn messages ({role, content}).
 * @param {string}   userInput the current message text.
 * @param {object}   opts      { scanDepth, recursive, maxRecursionSteps,
 *                               caseSensitive, matchWholeWords } — engine
 *                               options (NOT the app settings.json; the caller
 *                               maps `tome*` settings onto these names).
 * @param {object}   env       { turnCount, generationMode, charName,
 *                               characterProfile, userProfile, systemPrompt,
 *                               timedEffects, rng }.
 * @returns {{ sys_top, before_char, after_char, sys_bottom, at_depth }} entry arrays.
 */
export function activateLore(tomes, userInput, { messages = [], opts = {}, env = {} } = {}) {
  const empty = { sys_top: [], before_char: [], after_char: [], sys_bottom: [], at_depth: [] };
  const allEntries = (Array.isArray(tomes) ? tomes : [])
    .filter(t => t && t.enabled !== false)
    .flatMap(t => Array.isArray(t.entries) ? t.entries : Object.values(t.entries ?? {}));
  if (!allEntries.length) return empty;

  const globals = { caseSensitive: opts.caseSensitive ?? false, matchWholeWords: opts.matchWholeWords ?? false };
  const globalDepth = opts.scanDepth ?? 4;
  const scanEnv = {
    turnCount: env.turnCount ?? 0,
    generationMode: env.generationMode ?? 'normal',
    charName: env.charName ?? '',
    timedEffects: env.timedEffects ?? {},
    rng: env.rng ?? Math.random,
    globals,
  };

  const makeGetCorpus = (extra) => (depthOverride, entry) => {
    const d = depthOverride !== null && depthOverride !== undefined ? depthOverride : globalDepth;
    let text = buildScanText(messages, userInput, d, extra);
    if (entry) {
      if ((entry.matchCharacterDescription || entry.matchCharacterPersonality) && env.characterProfile) text += '\n' + env.characterProfile;
      if (entry.matchPersonaDescription && env.userProfile) text += '\n' + env.userProfile;
      if (entry.matchScenario && env.systemPrompt) text += '\n' + env.systemPrompt;
    }
    return text;
  };

  const activated = new Set();
  for (const e of scanLoreEntries(allEntries, makeGetCorpus(''), activated, false, scanEnv)) activated.add(e.uid);

  if (opts.recursive) {
    const maxSteps = opts.maxRecursionSteps ?? 3;
    let prev = '';
    for (let step = 0; step < maxSteps; step++) {
      const recursionContent = Array.from(activated)
        .map(uid => allEntries.find(e => e.uid === uid))
        .filter(e => e && !e.preventRecursion)
        .map(e => e.content || '')
        .join('\n');
      if (!recursionContent || recursionContent === prev) break;
      prev = recursionContent;
      const next = scanLoreEntries(allEntries, makeGetCorpus(recursionContent), activated, true, scanEnv);
      if (!next.length) break;
      for (const e of next) activated.add(e.uid);
    }
  }

  let entries = Array.from(activated).map(uid => allEntries.find(e => e.uid === uid)).filter(Boolean);
  entries = applyGroupLogic(entries);
  entries.sort((a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100));

  return {
    sys_top:     entries.filter(e => normEntryPos(e.position) === 2),
    before_char: entries.filter(e => normEntryPos(e.position) === 0),
    after_char:  entries.filter(e => normEntryPos(e.position) === 1),
    sys_bottom:  entries.filter(e => normEntryPos(e.position) === 3),
    at_depth:    entries.filter(e => normEntryPos(e.position) === 4),
  };
}

const renderEntries = (arr, resolve) =>
  (arr ?? []).map(e => resolve(String(e?.content ?? '')).trim()).filter(Boolean).join('\n\n');

/**
 * Fold activated lore into the shape the Discord/voice assembly needs:
 *   - `lead`  → the sys_top + before_char content, injected ABOVE the identity.
 *   - `tail`  → the after_char + sys_bottom content, injected BELOW the system block.
 *   - `atDepth` → the at_depth content, injected as a system message near the turn.
 * (The web's exact char-card boundary doesn't exist in the server assembly, so
 * top/before become the lead and after/bottom the tail — documented mapping.)
 *
 * `resolve(text)` is applied to each entry's content — pass the tome-macro
 * resolver so live macros ({{visionActive}} …) render; defaults to identity.
 */
export function foldLoreForPrompt(activated, resolve = (t) => t) {
  const a = activated ?? {};
  return {
    lead:    renderEntries([...(a.sys_top ?? []), ...(a.before_char ?? [])], resolve),
    tail:    renderEntries([...(a.after_char ?? []), ...(a.sys_bottom ?? [])], resolve),
    atDepth: renderEntries(a.at_depth ?? [], resolve),
  };
}

/** True if any lore activated (cheap check before building blocks). */
export function hasLore(activated) {
  const a = activated ?? {};
  return ['sys_top', 'before_char', 'after_char', 'sys_bottom', 'at_depth'].some(k => (a[k] ?? []).length > 0);
}
