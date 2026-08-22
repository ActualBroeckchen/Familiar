#!/usr/bin/env node
/**
 * audit-mcp-contracts.mjs — cross-language MCP contract checker.
 *
 * WHY THIS EXISTS. thalamus (JS) talks to Phylactery and Unruh (Python) over MCP
 * by calling `callTool({ name, arguments })`. `arguments` is an opaque object —
 * nothing in the JS toolchain validates its KEYS against the Python tool's
 * parameter names. So a call that sends `heading` where the tool wants `section`,
 * or calls a tool that doesn't exist, or drops a required argument, fails
 * SILENTLY at runtime (a missing required arg comes back as an isError result the
 * caller often doesn't inspect; an extra/misnamed arg is dropped by pydantic).
 *
 * These bugs are invisible to the JS-only audits (imports/exports/endpoints) AND
 * to `node --check`. Three of them shipped before this check was written:
 *   - identity_update_section sent `heading`, tool wanted `section` (silent no-op).
 *   - graph_node_search sent `type`, tool ignored it (search silently unfiltered).
 *   - interest_report_surfacing_outcome — the Unruh tool never existed at all.
 *
 * This walks every thalamus MCP call site and cross-checks its argument keys
 * against the real Python tool signatures, flagging:
 *   - UNKNOWN     — a tool name that no Phylactery/Unruh @mcp.tool defines.
 *   - BAD-ARG     — an argument key that isn't a parameter of the tool.
 *   - MISSING-REQ — a required (no-default) parameter the call never sends.
 *
 * It parses inline object-literal arguments; a call whose `arguments` is a
 * variable is checked for tool existence only (its keys can't be read statically).
 * Run via `npm run audit:mcp`; also asserted in tests/mcp-contracts.test.mjs so a
 * future mismatch fails CI instead of silently reaching a ward's data.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse `@mcp.tool()`-decorated Python defs → { toolName: {params:Set, required:Set} }. */
function parsePythonTools(globPattern) {
  const files = execSync(`git ls-files '${globPattern}'`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const tools = {};
  for (const rel of files) {
    let code = '';
    try { code = readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*@mcp\.tool\(/.test(lines[i])) continue;
      let j = i + 1;
      while (j < lines.length && !/^\s*def\s+/.test(lines[j])) j++;
      if (j >= lines.length) continue;
      let sig = '', k = j;
      while (k < lines.length) { sig += lines[k] + '\n'; if (/\)\s*(->[^:]*)?:\s*$/.test(lines[k])) break; k++; }
      const m = sig.match(/def\s+([A-Za-z0-9_]+)\s*\(([\s\S]*)\)\s*(->[\s\S]*?)?:\s*$/);
      if (!m) continue;
      const params = splitTopLevel(m[2]);
      const pset = new Set(), req = new Set();
      for (let p of params) {
        p = p.trim();
        if (!p || p === 'self' || p.startsWith('*')) continue;
        const name = p.split(/[:=]/)[0].trim();
        if (!name) continue;
        pset.add(name);
        if (!p.includes('=')) req.add(name);
      }
      tools[m[1]] = { params: pset, required: req };
    }
  }
  return tools;
}

/** Split a comma-separated list at bracket depth 0 (params / object entries). */
function splitTopLevel(blob) {
  const out = []; let depth = 0, cur = '';
  for (const ch of blob) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Statically-determinable keys of the JS object literal whose opening `{` is at
 * src[open] — its own top-level keys PLUS keys contributed by a top-level
 * `...spread` of an object literal (e.g. a conditional
 * `...(isIdle ? { mode: 'idle' } : {})`, which is exactly how a `mode` arg slipped
 * past an earlier version of this checker). A spread of a plain variable can't be
 * resolved statically and is skipped — its keys are unknown, so it can't be checked.
 */
function objectKeys(src, open) {
  let depth = 0, i = open, body = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    if (depth >= 1) body += ch;
  }
  body = body.slice(1); // drop the leading {
  const keys = new Set();
  collectOwnKeys(body, keys);
  collectSpreadKeys(body, keys);
  return keys;
}

/** Depth-0 keys of an object BODY (`key: value` and shorthand). */
function collectOwnKeys(body, keys) {
  let d = 0, tok = '';
  const flush = () => { const t = tok.trim(); tok = ''; if (d === 0 && /^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t); };
  for (let x = 0; x < body.length; x++) {
    const ch = body[x];
    if ('([{'.includes(ch)) { d++; tok = ''; continue; }
    if (')]}'.includes(ch)) { d--; tok = ''; continue; }
    if (d === 0 && ch === ':') {           // key: value — skip the value to the next top-level comma
      flush();
      let vd = 0; x++;
      for (; x < body.length; x++) { const c = body[x]; if ('([{'.includes(c)) vd++; else if (')]}'.includes(c)) { if (vd === 0) break; vd--; } else if (c === ',' && vd === 0) break; }
      continue;
    }
    if (d === 0 && ch === ',') { flush(); continue; }
    if (d === 0) tok += ch;
  }
  if (tok.trim()) flush();
}

/** For each top-level `...spread`, add the keys of any object literal inside it. */
function collectSpreadKeys(body, keys) {
  let d = 0;
  for (let x = 0; x < body.length; x++) {
    const ch = body[x];
    if ('([{'.includes(ch)) { d++; continue; }
    if (')]}'.includes(ch)) { d--; continue; }
    if (d === 0 && body.startsWith('...', x)) {
      let j = x + 3, sd = 0;                // scan the spread expression to the next depth-0 comma / end
      for (; j < body.length; j++) { const c = body[j]; if ('([{'.includes(c)) sd++; else if (')]}'.includes(c)) { if (sd === 0) break; sd--; } else if (c === ',' && sd === 0) break; }
      const expr = body.slice(x + 3, j);
      for (let k = 0; k < expr.length; k++) {   // collect keys of every object literal within
        if (expr[k] !== '{') continue;
        let dd = 0, e = k;
        for (let m = k; m < expr.length; m++) { const cm = expr[m]; if (cm === '{') dd++; else if (cm === '}') { dd--; if (dd === 0) { e = m; break; } } }
        const inner = expr.slice(k + 1, e);
        collectOwnKeys(inner, keys);
        collectSpreadKeys(inner, keys);       // nested spreads
        k = e;
      }
      x = j;
    }
  }
}

/** Cross-check thalamus.js MCP call sites against the parsed tool signatures. */
export function findContractMismatches() {
  const phyl = parsePythonTools('phylactery/src/**/*.py');
  const unruh = parsePythonTools('unruh/src/**/*.py');
  const js = readFileSync(path.join(ROOT, 'thalamus.js'), 'utf8');
  const findings = [];
  const lineAt = (idx) => js.slice(0, idx).split('\n').length;

  const check = (tool, keys, tools, server, idx) => {
    const sig = tools[tool];
    const loc = `thalamus.js:${lineAt(idx)}`;
    if (!sig) { findings.push(`UNKNOWN ${server} tool '${tool}' (${loc})`); return; }
    if (keys) {
      for (const key of keys) if (!sig.params.has(key)) {
        findings.push(`BAD-ARG ${server}.${tool}: sends '${key}' — not a parameter [params: ${[...sig.params].join(', ')}] (${loc})`);
      }
      for (const r of sig.required) if (!keys.has(r)) {
        findings.push(`MISSING-REQ ${server}.${tool}: required '${r}' not sent [sends: ${[...keys].join(', ') || '∅'}] (${loc})`);
      }
    }
  };

  // callTool('name', { ...args })  → Phylactery (thalamus helper, uses mcpClient)
  for (const m of js.matchAll(/[^.\w]callTool\(\s*'([A-Za-z0-9_]+)'\s*,\s*\{/g)) {
    check(m[1], objectKeys(js, m.index + m[0].length - 1), phyl, 'phylactery', m.index);
  }
  // (mcpClient|unruhClient).callTool({ name:'x', arguments:{...}|var })
  for (const m of js.matchAll(/(mcpClient|unruhClient)\.callTool\(\s*\{/g)) {
    const server = m[1] === 'unruhClient' ? 'unruh' : 'phylactery';
    const tools = server === 'unruh' ? unruh : phyl;
    const head = js.slice(m.index, m.index + 500);
    const nameM = head.match(/name:\s*'([A-Za-z0-9_]+)'/);
    if (!nameM) continue;
    const argsAt = js.indexOf('arguments:', m.index);
    if (argsAt < 0 || argsAt > m.index + 700) { check(nameM[1], null, tools, server, m.index); continue; }
    const braceAt = js.indexOf('{', argsAt);
    const between = js.slice(argsAt + 'arguments:'.length, braceAt);
    // `arguments: someVar` — not an inline object. Resolve the variable to the
    // NEAREST-PRECEDING `const/let <var> = { ... }` (var names like `args` are
    // reused across functions, so a global first-match resolves the wrong one),
    // then fold in incremental `<var>.key = …` assignments up to the call site
    // (objects are often built literal-then-mutated). This is how the
    // temporal_context `mode` arg hid — assembled in a separate `const unruhArgs`.
    if (/[A-Za-z_$]/.test(between) && !between.includes('{')) {
      const varName = (between.match(/[A-Za-z_$][\w$]*/) || [])[0];
      const pre = js.slice(0, m.index);
      const defRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`, 'g');
      let defIdx = -1, dm; while ((dm = defRe.exec(pre)) !== null) defIdx = dm.index;
      if (defIdx >= 0) {
        const keys = objectKeys(js, js.indexOf('{', defIdx));
        for (const am of js.slice(defIdx, m.index).matchAll(new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)\\s*=[^=]`, 'g'))) keys.add(am[1]);
        check(nameM[1], keys, tools, server, m.index);
      } else check(nameM[1], null, tools, server, m.index);   // truly unresolvable → name only
      continue;
    }
    check(nameM[1], objectKeys(js, braceAt), tools, server, m.index);
  }
  return findings;
}

// CLI: print + exit non-zero on any finding.
if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = findContractMismatches();
  if (findings.length) {
    console.error(`✗ MCP contract mismatches (${findings.length}):\n  ${findings.join('\n  ')}`);
    process.exit(1);
  }
  console.log('✓ MCP contracts — every thalamus call matches a Phylactery/Unruh tool signature.');
}
