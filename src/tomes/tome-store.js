/**
 * tome-store.js — read the tome (lorebook) files from disk, server-side.
 *
 * Tomes live as JSON files under `tomes/` (the same files the `/api/tomes`
 * endpoints in server.js write; the browser loads them into `state.tomeCache`).
 * The web path matches keywords against that client cache; a server-side turn
 * (Discord, voice) has no cache, so it reads the files directly here.
 *
 * `isTomeFile` mirrors server.js exactly: a real tome is a non-dotfile `.json`
 * (dotfiles like `.consent-pending.json` / `.memorization-queue.json` are
 * bookkeeping, never lore).
 */
import { promises as fsp } from 'fs';
import path from 'path';

export function isTomeFile(f) {
  return f.endsWith('.json') && !f.startsWith('.');
}

/**
 * Every tome on disk, parsed. Never throws — a missing dir returns [], a
 * corrupt file is skipped (a bad lore file must never break a chat turn).
 * @param {string} tomesDir  absolute path to the tomes directory.
 * @returns {Promise<object[]>} tome objects ({ id, name, enabled?, entries }).
 */
export async function readAllTomes(tomesDir) {
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    if (!isTomeFile(f)) continue;
    try {
      const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') out.push(data);
    } catch { /* skip a corrupt or unreadable tome */ }
  }
  return out;
}
