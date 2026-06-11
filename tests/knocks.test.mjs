import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

import { recordKnock, listKnocks, dismissKnock, KNOCKS_CAP,
         recordLocationKnock, listLocationKnocks, dismissLocationKnock, LOCATION_KNOCKS_CAP } from '../knocks.js';

let dir;
let file;
let n = 0;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-knocks-'));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

// Fresh file per test so ordering/caps don't bleed between cases.
function freshFile() {
  file = path.join(dir, `knocks-${n++}.json`);
  return { filePath: file };
}

describe('recordKnock', () => {
  it('records a new knock with count 1 and timestamps', async () => {
    const opts = freshFile();
    const r = await recordKnock({ platform: 'discord', id: '123', handle: 'chen_draws', context: 'dm' }, opts);
    assert.equal(r.ok, true);
    const list = await listKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, '123');
    assert.equal(list[0].count, 1);
    assert.ok(list[0].firstSeenAt);
    assert.ok(list[0].lastSeenAt);
  });

  it('upserts by platform+id: repeat knock bumps count, not entries', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'discord', id: '123', handle: 'chen' }, opts);
    await recordKnock({ platform: 'discord', id: '123', handle: 'chen_renamed' }, opts);
    const list = await listKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
    assert.equal(list[0].handle, 'chen_renamed', 'handle refreshes to latest');
  });

  it('same id on different platforms = separate knocks', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'discord',  id: '123' }, opts);
    await recordKnock({ platform: 'whatsapp', id: '123' }, opts);
    assert.equal((await listKnocks(opts)).length, 2);
  });

  it('platform is lowercased for matching', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'Discord', id: '123' }, opts);
    await recordKnock({ platform: 'discord', id: '123' }, opts);
    const list = await listKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
  });

  it('rejects missing platform or id without throwing', async () => {
    const opts = freshFile();
    assert.equal((await recordKnock({ platform: 'discord' }, opts)).ok, false);
    assert.equal((await recordKnock({ id: '123' }, opts)).ok, false);
    assert.equal((await listKnocks(opts)).length, 0);
  });

  it('never stores message content — only the identity-metadata fields', async () => {
    const opts = freshFile();
    await recordKnock({
      platform: 'discord', id: '123', handle: 'h', displayName: 'D',
      context: 'guild', locationKey: 'discord:guild:1:channel:2',
      content: 'secret message text', message: 'also secret',
    }, opts);
    const [k] = await listKnocks(opts);
    const allowed = ['platform', 'id', 'handle', 'displayName', 'context', 'locationKey', 'count', 'firstSeenAt', 'lastSeenAt'];
    for (const key of Object.keys(k)) {
      assert.ok(allowed.includes(key), `unexpected field stored: ${key}`);
    }
  });

  it(`caps the list at ${KNOCKS_CAP}, evicting least-recently-seen`, async () => {
    const opts = freshFile();
    for (let i = 0; i < KNOCKS_CAP + 5; i++) {
      await recordKnock({ platform: 'discord', id: `spam-${i}` }, opts);
    }
    const list = await listKnocks(opts);
    assert.equal(list.length, KNOCKS_CAP);
    // The oldest (spam-0 … spam-4) should be gone.
    assert.ok(!list.some(k => k.id === 'spam-0'));
    assert.ok(list.some(k => k.id === `spam-${KNOCKS_CAP + 4}`));
  });
});

describe('listKnocks', () => {
  it('returns most-recently-seen first', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'discord', id: 'a' }, opts);
    await new Promise(r => setTimeout(r, 5));
    await recordKnock({ platform: 'discord', id: 'b' }, opts);
    await new Promise(r => setTimeout(r, 5));
    await recordKnock({ platform: 'discord', id: 'a' }, opts); // a knocks again
    const list = await listKnocks(opts);
    assert.equal(list[0].id, 'a');
    assert.equal(list[1].id, 'b');
  });

  it('returns [] for a missing file', async () => {
    assert.deepEqual(await listKnocks(freshFile()), []);
  });
});

describe('dismissKnock', () => {
  it('removes the targeted knock only', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'discord', id: 'a' }, opts);
    await recordKnock({ platform: 'discord', id: 'b' }, opts);
    const r = await dismissKnock({ platform: 'discord', id: 'a' }, opts);
    assert.equal(r.ok, true);
    const list = await listKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'b');
  });

  it('unknown knock → ok:false, not a throw', async () => {
    const opts = freshFile();
    const r = await dismissKnock({ platform: 'discord', id: 'nope' }, opts);
    assert.equal(r.ok, false);
  });

  it('a dismissed person can knock again', async () => {
    const opts = freshFile();
    await recordKnock({ platform: 'discord', id: 'a' }, opts);
    await dismissKnock({ platform: 'discord', id: 'a' }, opts);
    await recordKnock({ platform: 'discord', id: 'a' }, opts);
    const list = await listKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 1, 'fresh knock starts a fresh count');
  });
});

// ── Location knock list ──────────────────────────────────────────

describe('recordLocationKnock', () => {
  it('records a new location knock with count 1 and timestamps', async () => {
    const opts = freshFile();
    const r = await recordLocationKnock(
      { key: 'discord:guild:1:channel:2', platform: 'discord', guildId: '1', channelId: '2' },
      opts,
    );
    assert.equal(r.ok, true);
    const list = await listLocationKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].key, 'discord:guild:1:channel:2');
    assert.equal(list[0].count, 1);
    assert.ok(list[0].firstSeenAt);
    assert.ok(list[0].lastSeenAt);
  });

  it('upserts by key: repeat knock bumps count, not entries', async () => {
    const opts = freshFile();
    await recordLocationKnock({ key: 'discord:guild:1:channel:2' }, opts);
    await recordLocationKnock({ key: 'discord:guild:1:channel:2' }, opts);
    const list = await listLocationKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
  });

  it('different keys = separate entries', async () => {
    const opts = freshFile();
    await recordLocationKnock({ key: 'discord:guild:1:channel:2' }, opts);
    await recordLocationKnock({ key: 'discord:guild:1:channel:3' }, opts);
    assert.equal((await listLocationKnocks(opts)).length, 2);
  });

  it('rejects missing key without throwing', async () => {
    const opts = freshFile();
    assert.equal((await recordLocationKnock({}, opts)).ok, false);
    assert.equal((await listLocationKnocks(opts)).length, 0);
  });

  it('never stores message content — only the allowed metadata fields', async () => {
    const opts = freshFile();
    await recordLocationKnock({
      key: 'discord:guild:1:channel:2', platform: 'discord',
      guildId: '1', channelId: '2',
      content: 'secret message', message: 'also secret',
    }, opts);
    const [lk] = await listLocationKnocks(opts);
    const allowed = ['key', 'platform', 'guildId', 'channelId', 'count', 'firstSeenAt', 'lastSeenAt'];
    for (const field of Object.keys(lk)) {
      assert.ok(allowed.includes(field), `unexpected field stored: ${field}`);
    }
  });

  it(`caps the list at ${LOCATION_KNOCKS_CAP}, evicting least-recently-seen`, async () => {
    const opts = freshFile();
    for (let i = 0; i < LOCATION_KNOCKS_CAP + 5; i++) {
      await recordLocationKnock({ key: `discord:guild:1:channel:${i}` }, opts);
    }
    const list = await listLocationKnocks(opts);
    assert.equal(list.length, LOCATION_KNOCKS_CAP);
    assert.ok(!list.some(k => k.key === 'discord:guild:1:channel:0'));
    assert.ok(list.some(k => k.key === `discord:guild:1:channel:${LOCATION_KNOCKS_CAP + 4}`));
  });
});

describe('listLocationKnocks', () => {
  it('returns most-recently-seen first', async () => {
    const opts = freshFile();
    await recordLocationKnock({ key: 'a' }, opts);
    await new Promise(r => setTimeout(r, 5));
    await recordLocationKnock({ key: 'b' }, opts);
    await new Promise(r => setTimeout(r, 5));
    await recordLocationKnock({ key: 'a' }, opts); // a seen again
    const list = await listLocationKnocks(opts);
    assert.equal(list[0].key, 'a');
    assert.equal(list[1].key, 'b');
  });

  it('returns [] for a missing file', async () => {
    assert.deepEqual(await listLocationKnocks(freshFile()), []);
  });
});

describe('dismissLocationKnock', () => {
  it('removes the targeted knock only', async () => {
    const opts = freshFile();
    await recordLocationKnock({ key: 'a' }, opts);
    await recordLocationKnock({ key: 'b' }, opts);
    const r = await dismissLocationKnock({ key: 'a' }, opts);
    assert.equal(r.ok, true);
    const list = await listLocationKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].key, 'b');
  });

  it('unknown knock → ok:false, not a throw', async () => {
    const opts = freshFile();
    const r = await dismissLocationKnock({ key: 'nope' }, opts);
    assert.equal(r.ok, false);
  });

  it('a dismissed location can knock again', async () => {
    const opts = freshFile();
    await recordLocationKnock({ key: 'a' }, opts);
    await dismissLocationKnock({ key: 'a' }, opts);
    await recordLocationKnock({ key: 'a' }, opts);
    const list = await listLocationKnocks(opts);
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 1, 'fresh knock starts a fresh count');
  });
});
