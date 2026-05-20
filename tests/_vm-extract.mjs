/**
 * Shared test helper: pull a single named function's source text out
 * of a non-importable file (server.js has Express boot side effects;
 * public/app.js is a classic browser script) so it can be eval'd in a
 * fresh vm context and unit-tested in isolation.
 *
 * Brittle to renames (fails loudly at load time if the function is
 * gone), robust to body changes (balanced-brace matching handles any
 * nesting). Param-aware: skips the parameter list before locating the
 * body brace, so functions with destructuring defaults like
 * `fn({ a = 0 } = {})` extract correctly — the naive "first brace
 * after the name" approach would stop at the param brace instead.
 */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export function extractFunctionSource(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  // Walk past the parameter list first: find the ')' that closes the
  // params at paren-depth 0, so a destructuring default's braces
  // aren't mistaken for the body's opening brace.
  const parenOpen = text.indexOf('(', start);
  let pd = 0, afterParams = parenOpen;
  for (let i = parenOpen; i < text.length; i++) {
    if (text[i] === '(') pd++;
    else if (text[i] === ')') { pd--; if (pd === 0) { afterParams = i; break; } }
  }
  // Now balance-match the body braces from the first '{' after ')'.
  let depth = 0, inBraces = false;
  for (let i = text.indexOf('{', afterParams); i < text.length; i++) {
    if (text[i] === '{') { depth++; inBraces = true; }
    else if (text[i] === '}') {
      depth--;
      if (inBraces && depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/**
 * Convenience wrapper: read a file, extract a function by name
 * (optionally prefixed with module-level helper lines its body
 * references), eval it, and return the live function.
 *
 * @param {string|URL} filePath  source file to read
 * @param {string} name          function to extract + return
 * @param {object} [opts]
 * @param {RegExp} [opts.constsMatch]  if set, every top-level line
 *        matching this regex is prepended to the eval (for functions
 *        that reference module-level `const`s).
 */
export function loadFunction(filePath, name, { constsMatch } = {}) {
  const src = readFileSync(filePath, 'utf8');
  const preamble = constsMatch
    ? src.split('\n').filter(l => constsMatch.test(l)).join('\n') + '\n'
    : '';
  const fnSrc = extractFunctionSource(src, name);
  const ctx = {};
  runInNewContext(`${preamble}${fnSrc}\nresult = ${name};`, ctx);
  if (typeof ctx.result !== 'function') {
    throw new Error(`extracted ${name} is not a function`);
  }
  return ctx.result;
}
