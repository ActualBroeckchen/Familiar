#!/usr/bin/env node
/**
 * Mechanical wiring audit. Catches the classes of mistake I actually make.
 *
 * Written after four rounds of my human finding oversights I could have found
 * myself, and one where I called `refreshVoiceChosenLabel?.()` — a function
 * that does not exist, where `?.()` on an undeclared name throws rather than
 * shrugging. `node --check` does not catch that. Nor does it catch importing a
 * name a module never exported, or a `$('some-id')` whose id is not in the
 * markup.
 *
 * Eight checks, each mapping to a bug that shipped:
 *   1. imports that name something the source module does not export
 *   2. calls to identifiers nothing declares (the ReferenceError class)
 *   3. `$('id')` lookups with no matching id in index.html
 *   4. settings keys the client syncs that no one reads
 *   5. settings keys read server-side that nothing ever writes
 *   6. interactive controls in the markup that no script references
 *   7. env off-switches referenced in code but absent from the docs
 *   8. two keys of the same name in one object literal (a dispatch-table stub
 *      shadowed the real handler and cost four rounds of live testing)
 *
 * Reports and exits non-zero. Deliberately a script, not a test: it sweeps the
 * whole repo and is meant to be run deliberately, not on every `npm test`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = async (f) => { try { return await fs.readFile(path.join(ROOT, f), 'utf8'); } catch { return null; } };
const findings = [];
const note = (check, msg) => findings.push({ check, msg });

/** Every .js/.mjs we own, excluding vendored and generated trees. */
async function ourFiles() {
  const out = [];
  const walk = async (rel, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = await fs.readdir(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Vendored / caches — skip at ANY depth.
        if (['node_modules', '.git', '.venv', '__pycache__'].includes(e.name)) continue;
        // Runtime-state / generated trees live only at the repo ROOT; skip them
        // there, but do NOT skip a same-named SOURCE folder nested elsewhere —
        // e.g. src/tomes/ is real code, not the runtime tomes/ store.
        if (depth === 0 && ['models', 'media', 'voices', 'almanac', 'logs', 'tomes', 'data'].includes(e.name)) continue;
        await walk(r, depth + 1);
      } else if (/\.(js|mjs)$/.test(e.name)) out.push(r);
    }
  };
  await walk('');
  return out;
}


/**
 * Strip comments and string/template literals.
 *
 * ⚠️ Load-bearing. Without this the identifier sweep matched ordinary English
 * inside comments — `and()`, `me()`, `definitions()` — and reported 236
 * "undeclared calls", none of them real. A check that cries wolf is a check
 * nobody runs, which is worse than no check.
 *
 * Character-by-character rather than regex, because regexes cannot tell a
 * quote inside a comment from a quote that opens a string.
 */
function stripNonCode(body) {
  let out = '';
  let i = 0;
  const n = body.length;
  // The last significant character emitted, to tell a regex literal from a
  // division. Without this, a regex containing a quote — /['"]/ — opens a fake
  // string and swallows code until the next matching quote. It ate 247,000
  // characters of app.js and reported the functions it had eaten as undeclared.
  let prev = '';
  const REGEX_CAN_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);
  const regexAllowed = () => {
    if (REGEX_CAN_FOLLOW.has(prev)) return true;
    // a keyword ending in a letter, e.g. `return /x/`
    return /(?:^|[^\w$])(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(prev);
  };

  while (i < n) {
    const c = body[i], d = body[i + 1];

    if (c === '/' && d === '/') { while (i < n && body[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(body[i] === '*' && body[i + 1] === '/')) i++; i += 2; out += ' '; continue; }

    if (c === '/' && regexAllowed()) {
      // Regex literal. Skip to the unescaped closing slash, honouring [...]
      // classes (a `/` inside a class does not close it).
      i++;
      let inClass = false;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === '[') inClass = true;
        else if (body[i] === ']') inClass = false;
        else if (body[i] === '/' && !inClass) { i++; break; }
        else if (body[i] === '\n') break;   // unterminated; bail rather than run away
        i++;
      }
      while (i < n && /[gimsuyd]/.test(body[i])) i++;   // flags
      out += ' RE ';
      prev = ')';   // a regex is a value, so a following / is division
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i++;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (quote === '`' && body[i] === '$' && body[i + 1] === '{') {
          let depth = 1; i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (body[i] === '{') depth++;
            else if (body[i] === '}') depth--;
            if (depth > 0) i++;
          }
          // Template holes ARE code and can contain calls, so recurse.
          out += ' ' + stripNonCode(body.slice(start, i)) + ' ';
          i++; continue;
        }
        if (body[i] === quote) { i++; break; }
        i++;
      }
      out += ' "" ';
      prev = ')';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? (prev + c).slice(-8) : c;
    i++;
  }
  return out;
}

const files = await ourFiles();
const src = {};       // raw, for doc/id greps where comments are harmless
const code = {};      // comments and literals removed, for identifier work
for (const f of files) {
  src[f] = await read(f);
  code[f] = src[f] ? stripNonCode(src[f]) : null;
}

// ── 1. Imports naming something the module does not export ────────
{
  const exportsOf = (body) => {
    const names = new Set();
    for (const m of body.matchAll(/export (?:async )?function\s+(\w+)/g)) names.add(m[1]);
    for (const m of body.matchAll(/export (?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
    // `export { a, b as c }`
    for (const m of body.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim().split(/\s+as\s+/);
        names.add((t[1] ?? t[0]).trim());
      }
    }
    if (/export\s+default/.test(body)) names.add('default');
    return names;
  };

  for (const [f, body] of Object.entries(code)) {
    if (!body) continue;
    for (const m of body.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]));
      const tgtBody = code[target];
      if (!tgtBody) continue;   // not ours, or a directory index — out of scope
      const have = exportsOf(tgtBody);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name || name.startsWith('//')) continue;
        if (!have.has(name)) note('import/export', `${f} imports { ${name} } from ${m[2]} — not exported there`);
      }
    }
  }
}

// ── 2. Called identifiers nothing declares ────────────────────────
//
// Scoped to public/app.js and public/voice-recorder.js: one flat script scope
// each, so a whole-file declaration sweep is sound. Doing this for modules
// would need real scope analysis; the browser files are where the bug hit.
{
  const GLOBALS = new Set([
    'window','document','console','fetch','setTimeout','clearTimeout','setInterval','clearInterval',
    'Promise','Object','Array','JSON','Math','Number','String','Boolean','Date','Error','Set','Map',
    'RegExp','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
    'Blob','File','FileReader','FormData','URL','URLSearchParams','Intl','navigator','location',
    'localStorage','sessionStorage','alert','confirm','prompt','requestAnimationFrame','structuredClone',
    'AudioContext','webkitAudioContext','OfflineAudioContext','webkitOfflineAudioContext','MediaRecorder',
    'Audio','Image','Event','CustomEvent','EventSource','WebSocket','AbortController','TextEncoder',
    'TextDecoder','Float32Array','Int16Array','Uint8Array','ArrayBuffer','DataView','DOMParser','Node',
    'HTMLElement','getComputedStyle','matchMedia','performance','crypto','queueMicrotask','Symbol',
    'Function','Reflect','Proxy','WeakMap','WeakSet','BigInt','globalThis','undefined','NaN','Infinity',
    'require','module','exports','process','import','super','this','arguments','eval','ResizeObserver',
    'IntersectionObserver','MutationObserver','Notification','speechSynthesis','scrollTo','history',
    'cancelAnimationFrame','btoa','atob','Uint16Array','Int32Array','Float64Array','Headers','Response',
    'Request','AbortSignal','CSS','SVGElement','Range','Selection','getSelection','open','close','print',
  ]);

  // app.js is a classic script and shares one global scope with everything
  // index.html loads before it — `msIcon` lives in icons.js, `createGraphMap`
  // in graph-map.js. Checking app.js alone reported both as undeclared, which
  // is the checker being wrong rather than the code.
  const html = (await read('public/index.html')) ?? '';
  const siblings = [...html.matchAll(/<script src="([^"]+\.js)"><\/script>/g)]
    .map((m) => `public/${m[1]}`)
    .filter((f) => code[f] && f !== 'public/app.js');

  for (const f of ['public/app.js', 'public/voice-recorder.js']) {
    const body = code[f];
    if (!body) continue;
    const declared = new Set(GLOBALS);
    // Globals contributed by classic scripts loaded ahead of this one.
    if (f === 'public/app.js') {
      for (const sib of siblings) {
        for (const m of code[sib].matchAll(/function\s+([\w$]+)/g)) declared.add(m[1]);
        for (const m of code[sib].matchAll(/(?:const|let|var)\s+([\w$]+)/g)) declared.add(m[1]);
        for (const m of code[sib].matchAll(/global\.([\w$]+)\s*=/g)) declared.add(m[1]);
        for (const m of code[sib].matchAll(/window\.([\w$]+)\s*=/g)) declared.add(m[1]);
      }
    }
    // `(function name()` too: a named function expression declares its own
    // name, and requiring whitespace before `function` missed every IIFE.
    for (const m of body.matchAll(/(?:^|[\s(])(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) declared.add(m[1]);
    for (const m of body.matchAll(/(?:const|let|var)\s+([\w$]+)/g)) declared.add(m[1]);
    // Destructuring, in declarations AND in parameter lists — `({ onTick } = {})`
    // is how the recorder takes its options, and missing it reported the
    // options as undeclared calls.
    for (const m of body.matchAll(/\{([^{}]+)\}\s*=/g)) {
      for (const p of m[1].split(',')) declared.add(p.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim());
    }
    // Object-literal methods and getters are declarations of a sort: `stop() {`
    // and `get state() {` are not calls to anything.
    for (const m of body.matchAll(/(?:^|[\s,{])(?:get|set)?\s*([\w$]+)\s*\([^)]*\)\s*\{/g)) declared.add(m[1]);
    for (const m of body.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]\s*=/g)) {
      for (const p of m[1].split(',')) declared.add(p.trim().split(/[:=]/)[0].trim());
    }
    for (const m of body.matchAll(/import\s*\{([^}]+)\}/g)) {
      for (const p of m[1].split(',')) declared.add(p.trim().split(/\s+as\s+/).pop().trim());
    }
    for (const m of body.matchAll(/class\s+(\w+)/g)) declared.add(m[1]);
    // Parameters and catch bindings — approximate but enough to avoid noise.
    for (const m of body.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const p of m[1].split(',')) {
        const n = p.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim();
        if (/^\w+$/.test(n)) declared.add(n);
      }
    }
    for (const m of body.matchAll(/catch\s*\(\s*(\w+)/g)) declared.add(m[1]);
    for (const m of body.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\w+)/g)) declared.add(m[1]);

    // Call sites: `name(` and `name?.(`, not preceded by a dot (those are methods).
    const called = new Set();
    for (const m of body.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\??\.?\(/g)) called.add(m[2]);
    const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','function','await','new','do','else','case','delete','void','in','of','instanceof','yield','throw','async','constructor','super']);
    for (const name of called) {
      if (KEYWORDS.has(name) || declared.has(name)) continue;
      note('undeclared call', `${f} calls ${name}() — nothing declares it (ReferenceError at runtime)`);
    }
  }
}

// ── 3. $('id') lookups with no matching id in the markup ──────────
{
  const html = await read('public/index.html');
  const app = src['public/app.js'];
  if (html && app) {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const looked = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    // Ids created at runtime are legitimate; only flag ones that are never
    // created anywhere either.
    for (const id of looked) {
      if (ids.has(id)) continue;
      const madeAtRuntime = new RegExp(`id\\s*=\\s*['"\`]${id}['"\`]|\\.id\\s*=\\s*['"\`]${id}['"\`]`).test(app);
      if (!madeAtRuntime) note('dead lookup', `public/app.js looks up #${id} — no such id in index.html or created at runtime`);
    }
  }
}

// ── 4. Settings keys: synced but unread, or read but unsynced ──────
{
  const app = code['public/app.js'];
  const serverish = ['server.js', 'thalamus.js', 'cerebellum.js', 'discord-gateway.js', 'voice-backend.js', 'voice-transcribe.js']
    .map((f) => code[f] ?? '').join('\n');
  if (app) {
    const block = app.slice(app.indexOf('SERVER_SYNCED_KEYS'), app.indexOf('function extractServerSettings'));
    const keys = [...block.matchAll(/'([A-Za-z][\w]*)'/g)].map((m) => m[1]);
    for (const k of keys) {
      // Read anywhere server-side, or at least present in the settings doc?
      if (!new RegExp(`\\b${k}\\b`).test(serverish)) {
        note('setting unread', `${k} is synced to the server but nothing server-side reads it`);
      }
    }
  }
}

// ── 5. Env off-switches referenced in code but undocumented ───────
{
  const docs = [
    await read('README.md'), await read('docs/troubleshooting.md'),
    await read('docs/architecture.md'), await read('CLAUDE.md'),
    await read('docs/voice-build-spec.md'),
  ].join('\n');
  const switches = new Set();
  for (const body of Object.values(src)) {
    if (!body) continue;
    for (const m of body.matchAll(/PROTO_FAMILIAR_[A-Z0-9_]+/g)) switches.add(m[0]);
  }
  for (const s of switches) {
    if (!docs.includes(s)) note('undocumented switch', `${s} exists in code but appears in no doc`);
  }
}

// ── 6. Settings keys read server-side that nothing ever writes ────
//
// A misspelled settings key reads `undefined` forever and never errors — the
// same silent shape as `e.stage` where the field was `e.phase`. So: every key
// the server reads off settings must be one the client syncs, or one something
// writes explicitly.
{
  // ⚠️ RAW app.js, not the stripped copy. The key names live in string
  // literals, and the stripper replaces those with "" — reading `code` here
  // found zero synced keys and reported all 88 as drift. A checker that reports
  // everything reports nothing.
  const appRaw = src['public/app.js'] ?? '';
  const synced = new Set([...appRaw.slice(appRaw.indexOf('SERVER_SYNCED_KEYS'), appRaw.indexOf('function extractServerSettings'))
    .matchAll(/'([A-Za-z][\w]*)'/g)].map((m) => m[1]));

  // Keys the server WRITES (so they exist even if the client never syncs them).
  const serverFiles = files.filter((f) => !f.startsWith('public/') && !f.startsWith('tests/') && !f.startsWith('scripts/'));
  const written = new Set();
  for (const f of [...serverFiles, 'public/app.js']) {
    for (const m of (code[f] ?? '').matchAll(/(?:settings|prior|merged|state|s)\.([A-Za-z]\w*)\s*=[^=]/g)) written.add(m[1]);
    for (const m of (code[f] ?? '').matchAll(/\{\s*([A-Za-z]\w*)\s*:/g)) written.add(m[1]);
    // Defaults written into the settings file, and keys named in string form.
    for (const m of (src[f] ?? '').matchAll(/['"]([A-Za-z]\w*)['"]\s*:/g)) written.add(m[1]);
  }

  // Methods that exist on every String/Array/Object, so `settings.trim()` is a
  // variable coincidentally named `settings` — not a settings key. Dropping the
  // bare `s` alias for the same reason: it matched every short-named string.
  const NOT_A_KEY = new Set([
    'length','startsWith','endsWith','slice','trim','split','join','map','filter','includes','replace',
    'toLowerCase','toUpperCase','push','pop','forEach','some','every','find','indexOf','match','concat',
    'toString','valueOf','then','catch','finally','flag','mtimeMs','voiceTts',
  ]);
  // Verified-intentional reads. Each needs a REASON, so a genuinely drifting
  // key cannot be silenced by adding a name to a list.
  const DELIBERATE = new Map([
    ['entityCoreConnectionId',
      'legacy-compat read: `phylacteryConnectionId ?? entityCoreConnectionId` keeps pre-0.6 settings.json working. Nothing writes it by design.'],
    ['readinessLeadHours',
      'file-only tuning knob, documented in docs/troubleshooting.md. Survives a UI sync because mergeSettings preserves unmentioned keys.'],
    ['discordMediaPerHour',
      'file-only tuning knob, same as above.'],
  ]);

  const seen = new Set();
  for (const f of serverFiles) {
    for (const m of (code[f] ?? '').matchAll(/\b(?:settings|readSettingsSync\(\))\??\.([A-Za-z]\w*)/g)) {
      const k = m[1];
      if (seen.has(k) || synced.has(k) || written.has(k) || NOT_A_KEY.has(k) || DELIBERATE.has(k)) continue;
      seen.add(k);
      note('settings key drift', `${f} reads settings.${k} — the client never syncs it and nothing writes it`);
    }
  }
}

// ── 7. Interactive ids in the markup with no JS reference ─────────
//
// A control nobody wired is the `#voice-picker-chosen` shape: present in the
// page, never written to, silently doing nothing.
{
  const html = (await read('public/index.html')) ?? '';
  // RAW again — ids are string literals, and I made this exact mistake in the
  // check directly above this one before noticing. Twice in a row, same cause:
  // reaching for the stripped copy out of habit when the thing being looked for
  // only exists in the literals it strips.
  const js = files.filter((f) => f.startsWith('public/')).map((f) => src[f] ?? '').join('\n');
  for (const m of html.matchAll(/<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"/g)) {
    const id = m[2];
    if (!new RegExp(`['"\`]${id}['"\`]`).test(js)) {
      note('unwired control', `#${id} is a <${m[1]}> in the markup that no script ever references`);
    }
  }
}

// ── 8. Duplicate members in a top-level dispatch table ───────────
//
// ⚠️ The bug that cost four rounds of my human's testing. `audio-worker.mjs`'s
// OPS table had TWO `transcribe` keys — the real implementation, and a leftover
// "not implemented yet" stub below it. The later one silently wins, so the real
// handler was dead from the day it landed and every voice note answered
// `unsupported`. `node --check` accepts a duplicate key without complaint.
//
// Scoped to `const NAME = {` at column 0 through its matching `};` at column 0
// — a dispatch table, which is the shape that bit. A general duplicate-key
// detector needs a parser: I tried two broader versions first and they reported
// 1759 then 431 findings, all of them separate objects that merely shared an
// indent. Narrow and true beats broad and ignored.
{
  for (const [f, body] of Object.entries(code)) {
    if (!body) continue;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^(?:export )?const ([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\()?\{\s*$/);
      if (!open) continue;
      const seen = new Map();
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\}\)?;?\s*$/.test(lines[j])) break;             // table closed
        const m = lines[j].match(/^  (?:async\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*(?:\(|:)/);
        if (!m) continue;
        if (seen.has(m[1])) {
          note('duplicate key', `${f}: \`${open[1]}\` declares \`${m[1]}\` at lines ${seen.get(m[1])} and ${j + 1} — the later one silently wins`);
        } else seen.set(m[1], j + 1);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────
const byCheck = {};
for (const f of findings) (byCheck[f.check] ??= []).push(f.msg);
const order = ['import/export', 'undeclared call', 'duplicate key', 'dead lookup', 'setting unread', 'settings key drift', 'unwired control', 'undocumented switch'];
console.log('');
for (const c of order) {
  const list = byCheck[c] ?? [];
  console.log(`${list.length ? '✗' : '✓'} ${c}  (${list.length})`);
  for (const m of list) console.log(`    ${m}`);
}
console.log('');
console.log(`${findings.length} finding(s) across ${files.length} files.`);
process.exitCode = findings.length ? 1 : 0;
