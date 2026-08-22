import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGrants, readVaultEntry, ACK_SENTENCE } from '../browser-grants.js';

// browser-grants reads fixed files under browser/. These tests write them, then
// ALWAYS clean up — browser/ is git-ignored, so nothing leaks into the repo.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser');
const grantsFile = path.join(dir, 'autonomy-grants.json');
const vaultFile  = path.join(dir, 'credentials-vault.json');

function withFiles(grants, vault, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const hadG = fs.existsSync(grantsFile), hadV = fs.existsSync(vaultFile);
  const bakG = hadG ? fs.readFileSync(grantsFile) : null, bakV = hadV ? fs.readFileSync(vaultFile) : null;
  try {
    if (grants === null) { try { fs.unlinkSync(grantsFile); } catch {} } else fs.writeFileSync(grantsFile, grants);
    if (vault === null)  { try { fs.unlinkSync(vaultFile); } catch {} }  else fs.writeFileSync(vaultFile, vault);
    return fn();
  } finally {
    if (bakG !== null) fs.writeFileSync(grantsFile, bakG); else { try { fs.unlinkSync(grantsFile); } catch {} }
    if (bakV !== null) fs.writeFileSync(vaultFile, bakV);  else { try { fs.unlinkSync(vaultFile); } catch {} }
  }
}

test('no grants file → every grant is false (the shipped state)', () => {
  withFiles(null, null, () => {
    const g = readGrants();
    assert.deepEqual({ c: g.credentials, p: g.payments, x: g.captchas, a: g.autoSubmit }, { c: false, p: false, x: false, a: false });
    assert.deepEqual(g.active, []);
  });
});

test('the acknowledgment content must match exactly or all grants read false', () => {
  // A changed WORD → refused. (Surrounding whitespace is tolerated on purpose —
  // an editor's trailing newline shouldn't revoke a real ward consent.)
  const oneWordOff = JSON.stringify({ acknowledgment: ACK_SENTENCE.replace('authority', 'permission'), credentials: true, payments: true });
  withFiles(oneWordOff, null, () => assert.deepEqual(readGrants().active, []));
  const wrong = JSON.stringify({ acknowledgment: 'I agree', credentials: true });
  withFiles(wrong, null, () => assert.deepEqual(readGrants().active, []));
  // Surrounding whitespace is fine.
  const spaced = JSON.stringify({ acknowledgment: '  ' + ACK_SENTENCE + '\n', credentials: true });
  withFiles(spaced, null, () => assert.deepEqual(readGrants().active, ['credentials']));
});

test('a valid file activates exactly the true grants', () => {
  const ok = JSON.stringify({ acknowledgment: ACK_SENTENCE, credentials: true, payments: false, captchas: false, autoSubmit: true });
  withFiles(ok, null, () => {
    const g = readGrants();
    assert.equal(g.credentials, true);
    assert.equal(g.autoSubmit, true);
    assert.equal(g.payments, false);
    assert.deepEqual(g.active.sort(), ['autoSubmit', 'credentials']);
  });
});

test('malformed JSON → all grants false, never throws', () => {
  withFiles('{ not json', null, () => assert.deepEqual(readGrants().active, []));
});

test('readVaultEntry returns null without a grant, the entry with one — never the value elsewhere', () => {
  const vault = JSON.stringify({ mastodon: { user: 'me', secret: 'hunter2' } });
  // No grant → vault is inert even though the entry exists.
  withFiles(null, vault, () => assert.equal(readVaultEntry('mastodon'), null));
  // With the credentials grant → the entry is readable (code-only).
  const grant = JSON.stringify({ acknowledgment: ACK_SENTENCE, credentials: true });
  withFiles(grant, vault, () => {
    const e = readVaultEntry('mastodon');
    assert.equal(e.user, 'me');
    assert.equal(e.secret, 'hunter2');
    assert.equal(readVaultEntry('nonexistent'), null);
  });
});
