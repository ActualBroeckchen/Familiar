// repo-root.js — the absolute path to the repository root, computed from THIS
// file's own location. This file lives at the root and does not move, so modules
// that need a repo-root-relative path (tomes/, models/, root data files) should
// import REPO_ROOT from here instead of deriving it from their own __dirname —
// otherwise moving a module into src/<domain>/ silently breaks those paths
// (they'd point beside the moved file). Depth-independent: later moves are safe.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
