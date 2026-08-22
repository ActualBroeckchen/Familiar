import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EMBED_COLOR, btn, row, expiredView } from '../discord-menu-kit.js';
import {
  isQueueCommand, QUEUE_CID,
  buildQueueHomeView, buildQueueItemView, buildQueueDoneView, buildQueueText,
} from '../ward-consent-queue.js';
import {
  isConnectionCommand, CONN_CID, DEFAULT_VALUE, FEATURE_CONNECTIONS,
  buildConnHomeView, buildFeaturesView, buildFeatureView, buildConnDoneView, buildConnText,
} from '../ward-connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Collect every custom_id in a view's components (buttons + selects).
const cidsOf = (view) => {
  const out = [];
  for (const r of view.components ?? []) {
    for (const c of r.components ?? []) if (c.custom_id) out.push(c.custom_id);
  }
  return out;
};
const selectOf = (view) => {
  for (const r of view.components ?? []) {
    for (const c of r.components ?? []) if (c.type === 3) return c;
  }
  return null;
};

// ── discord-menu-kit ───────────────────────────────────────────────
describe('discord-menu-kit primitives', () => {
  it('btn builds a component-2 with style/label/id/disabled', () => {
    assert.deepEqual(btn('x:y', 'Go', 3, true), { type: 2, style: 3, label: 'Go', custom_id: 'x:y', disabled: true });
    assert.equal(btn('a', 'b').style, 2);       // default secondary
    assert.equal(btn('a', 'b').disabled, false);
  });
  it('row wraps components as a type-1 action row', () => {
    assert.deepEqual(row({ type: 2 }), { type: 1, components: [{ type: 2 }] });
  });
  it('expiredView strips controls and names the reopen command', () => {
    const v = expiredView('!queue');
    assert.deepEqual(v.components, []);
    assert.match(v.embeds[0].description, /!queue/);
  });
  it('EMBED_COLOR is the shared accent', () => assert.equal(typeof EMBED_COLOR, 'number'));
});

// ── ward-consent-queue (!queue) ────────────────────────────────────
describe('isQueueCommand', () => {
  it('matches !queue, not ordinary chat', () => {
    assert.equal(isQueueCommand('!queue'), true);
    assert.equal(isQueueCommand('  !QUEUE'), true);
    assert.equal(isQueueCommand('queue up'), false);
    assert.equal(isQueueCommand('!queued'), false);
    assert.equal(isQueueCommand(''), false);
  });
});

const qItems = (n) => Array.from({ length: n }, (_, i) => ({
  id: `fact-${i}`, brief: `thing number ${i}`, villagerName: i % 2 ? 'Sam' : '(no specific person)',
  villagerId: null, category: 'basics', date: '2026-08-20', reason: i % 2 ? 'third-party' : 'shared-room',
}));

describe('buildQueueHomeView', () => {
  it('empty queue: disables keep-all/drop-all, no picker', () => {
    const v = buildQueueHomeView({ items: [] });
    assert.match(v.embeds[0].title, /\(0\)/);
    assert.equal(selectOf(v), null);
    const all = (v.components.at(-1).components);
    assert.ok(all.find(b => b.custom_id === `${QUEUE_CID}:all:keep`).disabled);
    assert.ok(all.find(b => b.custom_id === `${QUEUE_CID}:all:drop`).disabled);
    assert.ok(all.find(b => b.custom_id === `${QUEUE_CID}:done`));
  });
  it('populated queue: a picker whose option values are item ids', () => {
    const v = buildQueueHomeView({ items: qItems(3) });
    const sel = selectOf(v);
    assert.equal(sel.custom_id, `${QUEUE_CID}:pick`);
    assert.deepEqual(sel.options.map(o => o.value), ['fact-0', 'fact-1', 'fact-2']);
    const all = v.components.at(-1).components;
    assert.equal(all.find(b => b.custom_id === `${QUEUE_CID}:all:keep`).disabled, false);
  });
  it('pages when over one page, with prev/next gated at the ends', () => {
    const v0 = buildQueueHomeView({ items: qItems(15), page: 0 });
    const pager = v0.components.find(r => r.components.some(c => String(c.custom_id).includes(':page:')));
    const prev = pager.components.find(c => c.custom_id === `${QUEUE_CID}:page:-1`);
    const next = pager.components.find(c => c.custom_id === `${QUEUE_CID}:page:1`);
    assert.equal(prev.disabled, true);    // no newer than page 0
    assert.equal(next.disabled, false);
    const vLast = buildQueueHomeView({ items: qItems(15), page: 2 });
    const nextLast = cidsOf(vLast).includes(`${QUEUE_CID}:page:3`);
    assert.equal(nextLast, true);   // button present…
    const pagerLast = vLast.components.find(r => r.components.some(c => String(c.custom_id).includes(':page:')));
    assert.equal(pagerLast.components.find(c => c.custom_id === `${QUEUE_CID}:page:3`).disabled, true); // …but disabled
  });
  it('renders a note when one is supplied', () => {
    const v = buildQueueHomeView({ items: qItems(1), note: '✓ Kept that one.' });
    assert.match(v.embeds[0].description, /Kept that one/);
  });
});

describe('buildQueueItemView', () => {
  it('present item → keep/drop/back with the id in the set cids', () => {
    const v = buildQueueItemView({ item: qItems(1)[0] });
    const cids = cidsOf(v);
    assert.ok(cids.includes(`${QUEUE_CID}:set:fact-0:keep`));
    assert.ok(cids.includes(`${QUEUE_CID}:set:fact-0:drop`));
    assert.ok(cids.includes(`${QUEUE_CID}:home`));
  });
  it('missing item → just a back button', () => {
    const v = buildQueueItemView({ item: null });
    assert.deepEqual(cidsOf(v), [`${QUEUE_CID}:home`]);
  });
});

describe('buildQueueDoneView / buildQueueText', () => {
  it('done view strips controls', () => assert.deepEqual(buildQueueDoneView().components, []));
  it('text fallback lists items with ids, or says nothing pending', () => {
    assert.match(buildQueueText({ items: [] }), /Nothing/i);
    const t = buildQueueText({ items: qItems(2) });
    assert.match(t, /id: fact-0/);
    assert.match(t, /!queue/);
  });
});

// ── ward-connections (!connection) ─────────────────────────────────
describe('isConnectionCommand', () => {
  it('matches !connection / !conn / !model', () => {
    for (const c of ['!connection', '!conn', '!model', '  !CONNECTION']) assert.equal(isConnectionCommand(c), true);
    for (const c of ['!connections', '!conns', '!models']) assert.equal(isConnectionCommand(c), true);  // natural plurals
    assert.equal(isConnectionCommand('connection?'), false);
    assert.equal(isConnectionCommand('!modeling'), false);
  });
});

const conns = [
  { id: 'glm-x1', name: 'GLM', provider: 'zai', model: 'glm-4.6', apiKey: 'k' },
  { id: 'gpt-y2', name: 'GPT', provider: 'openai', model: 'gpt-5', apiKey: 'k' },
  { id: 'dead-z3', name: 'NoKey', provider: 'x', model: '' },   // unusable
];

describe('buildConnHomeView', () => {
  it('shows the active connection and marks it default in the picker', () => {
    const v = buildConnHomeView({ connections: conns, primaryId: 'gpt-y2', featureConnections: {} });
    assert.match(v.embeds[0].description, /GPT/);
    const sel = selectOf(v);
    assert.equal(sel.custom_id, `${CONN_CID}:primary`);
    assert.equal(sel.options.find(o => o.value === 'gpt-y2').default, true);
    assert.equal(sel.options.find(o => o.value === 'glm-x1').default, false);
  });
  it('summarises per-feature overrides', () => {
    const v = buildConnHomeView({ connections: conns, primaryId: 'glm-x1', featureConnections: { triage: 'gpt-y2' } });
    assert.match(v.embeds[0].description, /Crisis triage/);
    assert.match(v.embeds[0].description, /GPT/);
  });
  it('no connections → picker suppressed, features button disabled', () => {
    const v = buildConnHomeView({ connections: [], primaryId: null });
    assert.equal(selectOf(v), null);
    const feat = v.components.at(-1).components.find(b => b.custom_id === `${CONN_CID}:features`);
    assert.equal(feat.disabled, true);
  });
});

describe('buildFeaturesView / buildFeatureView', () => {
  it('features list picker offers every routable feature', () => {
    const sel = selectOf(buildFeaturesView({ featureConnections: {}, connections: conns }));
    assert.equal(sel.custom_id, `${CONN_CID}:feat`);
    assert.deepEqual(sel.options.map(o => o.value).sort(), FEATURE_CONNECTIONS.map(f => f.key).sort());
  });
  it('feature view: Primary(default) sentinel + one option per connection; current marked default', () => {
    const v = buildFeatureView({ feature: 'vision', featureConnections: { vision: 'glm-x1' }, connections: conns });
    const sel = selectOf(v);
    assert.equal(sel.custom_id, `${CONN_CID}:featset:vision`);
    const def = sel.options.find(o => o.value === DEFAULT_VALUE);
    assert.ok(def);
    assert.equal(def.default, false);                                   // an override is set, so default isn't the pick
    assert.equal(sel.options.find(o => o.value === 'glm-x1').default, true);
    assert.match(sel.options.find(o => o.value === 'dead-z3').description, /unusable/);
  });
  it('feature view with no override marks Primary(default) as the pick', () => {
    const sel = selectOf(buildFeatureView({ feature: 'pondering', featureConnections: {}, connections: conns }));
    assert.equal(sel.options.find(o => o.value === DEFAULT_VALUE).default, true);
  });
});

describe('buildConnDoneView / buildConnText', () => {
  it('done view strips controls', () => assert.deepEqual(buildConnDoneView().components, []));
  it('text fallback names the active connection and any overrides', () => {
    const t = buildConnText({ connections: conns, primaryId: 'glm-x1', featureConnections: { reachout: 'gpt-y2' } });
    assert.match(t, /active: GLM/);
    assert.match(t, /Warm reach-outs/);
    assert.match(t, /!connection/);
  });
});

// ── drift guard: the module's feature list must match the web UI's ──
describe('FEATURE_CONNECTIONS parity with public/app.js', () => {
  it('same keys as the web Connections modal (no silent drift)', () => {
    const src = readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const block = src.match(/const FEATURE_CONNECTIONS = \[([\s\S]*?)\];/);
    assert.ok(block, 'could not locate FEATURE_CONNECTIONS in public/app.js');
    const webKeys = [...block[1].matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]).sort();
    const modKeys = FEATURE_CONNECTIONS.map(f => f.key).sort();
    assert.deepEqual(modKeys, webKeys);
  });
});
