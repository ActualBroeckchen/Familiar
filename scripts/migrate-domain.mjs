// Deterministic domain migration: move a set of root modules into src/<domain>/
// and rewrite every relative import specifier (static `from`, dynamic `import()`,
// `export … from`, and `new URL('./x', import.meta.url)`) across the whole repo
// by RESOLVING against the old layout and recomputing for the new location.
//
// Usage: node migrate-domain.mjs <domain> <file1.js> <file2.js> ...
// Run from the repo root. Prints every file it rewrites. Does NOT git mv — it
// only rewrites text; the caller does `git mv` after (git tracks the rename).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const [, , domain, ...moveArgs] = process.argv;
if (!domain || !moveArgs.length) { console.error('need <domain> <files...>'); process.exit(1); }

const repo = process.cwd();
const destDir = `src/${domain}`;
const moveSet = new Set(moveArgs.map((f) => path.basename(f)));

// old repo-relative path (root) -> new repo-relative path
const newPathOf = (relPath) => {
  const base = path.basename(relPath);
  if (moveSet.has(base) && path.dirname(relPath) === '.') return `${destDir}/${base}`;
  return relPath;
};

const toSpec = (fromDir, targetRel) => {
  let p = path.relative(fromDir, targetRel).split(path.sep).join('/');
  if (!p.startsWith('.')) p = './' + p;
  return p;
};

const tracked = execSync('git ls-files "*.js" "*.mjs"', { cwd: repo, encoding: 'utf8' })
  .split('\n').filter(Boolean);

// Match relative specifiers in the four import forms.
const SPEC_RE = /(from\s*|import\s*\(\s*|export\s[^'"]*from\s*|new URL\(\s*)(['"])(\.[^'"]*?)\2/g;

let changed = 0;
for (const oldFP of tracked) {
  const abs = path.join(repo, oldFP);
  let src = await fs.readFile(abs, 'utf8');
  const oldDir = path.dirname(oldFP);
  const newFP = newPathOf(oldFP);
  const newDir = path.dirname(newFP);
  let touched = false;

  const out = src.replace(SPEC_RE, (m, pre, q, spec) => {
    // Resolve the specifier against the OLD location of THIS file.
    const targetOld = path.normalize(path.join(oldDir, spec)).split(path.sep).join('/');
    const targetNew = newPathOf(targetOld);
    // Nothing to do unless either this file moved OR the target moved.
    if (targetNew === targetOld && newFP === oldFP) return m;
    const respec = toSpec(newDir, targetNew);
    if (respec === spec) return m;
    touched = true;
    return `${pre}${q}${respec}${q}`;
  });

  if (touched) { await fs.writeFile(abs, out); changed++; console.log(`rewrote imports: ${oldFP}${newFP !== oldFP ? `  (moves → ${newFP})` : ''}`); }
}
console.log(`\n${changed} file(s) rewritten. Now: git mv the moved files into ${destDir}/, fix any __dirname repo-root paths, then test.`);
