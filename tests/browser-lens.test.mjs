import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRefTable, isProtectedField, renderSnapshot, computeDelta, LEVEL_CAPS, resolveTarget,
} from '../browser-lens.js';

// A small fixture page: a product card with a fillable qty, an add button, a
// password field (protected), and some structure. No browser involved.
const page = {
  url: 'https://shop.example/oat-milk',
  title: 'Oat Milk 1L',
  generation: 1,
  nodes: [
    { role: 'heading', name: 'Oat Milk 1L', tag: 'h1', interactable: false, inViewport: true },
    { role: 'textbox', name: 'Quantity', tag: 'input', type: 'number', interactable: true, inViewport: true, section: "product card 'Oat Milk'", nth: 0 },
    { role: 'button', name: 'Add to basket', tag: 'button', interactable: true, inViewport: true, section: "product card 'Oat Milk'", nth: 0 },
    { role: 'textbox', name: 'Password', tag: 'input', type: 'password', interactable: true, inViewport: true, section: 'account', nth: 0 },
    { role: 'link', name: 'Help', tag: 'a', interactable: true, inViewport: false, section: 'footer', nth: 0 },
  ],
  text: 'Creamy oat milk, 1 litre. Barista edition.',
};

test('buildRefTable mints MEANING-BEARING slug refs for interactables only, with locators', () => {
  const { order, byRef } = buildRefTable(page);
  assert.deepEqual(order, ['quantity', 'add-to-basket', 'password', 'help']); // name-derived, heading excluded
  assert.equal(byRef.get('quantity').node.name, 'Quantity');
  assert.deepEqual(byRef.get('add-to-basket').locator, { role: 'button', name: 'Add to basket', nth: 0 });
  assert.equal(byRef.get('password').protected, true); // password field
});

test('slug refs are unique — a collision gets a numeric suffix', () => {
  const dup = { nodes: [
    { role: 'button', name: 'Add', tag: 'button', interactable: true },
    { role: 'button', name: 'Add', tag: 'button', interactable: true },
    { role: 'button', name: 'Add', tag: 'button', interactable: true },
  ] };
  assert.deepEqual(buildRefTable(dup).order, ['add', 'add-2', 'add-3']);
});

test('an unnamed (icon) interactable falls back to a role-based slug', () => {
  const t = buildRefTable({ nodes: [{ role: 'button', name: '', tag: 'button', interactable: true }] });
  assert.deepEqual(t.order, ['button']);
});

test('resolveTarget: exact label → the one ref; substring works; role narrows; ambiguity is reported', () => {
  const t = buildRefTable(page);
  assert.deepEqual(resolveTarget(t, { target: 'Add to basket' }), { ref: 'add-to-basket' });
  assert.deepEqual(resolveTarget(t, { target: 'quantity' }), { ref: 'quantity' });        // case-insensitive
  assert.deepEqual(resolveTarget(t, { target: 'basket' }), { ref: 'add-to-basket' });      // substring
  assert.deepEqual(resolveTarget(t, { target: 'add-to-basket' }), { ref: 'add-to-basket' }); // by slug too
  assert.deepEqual(resolveTarget(t, { target: 'nope' }), { none: true });

  // Two same-named links, one narrowed by role.
  const two = buildRefTable({ nodes: [
    { role: 'link', name: 'Details', tag: 'a', interactable: true },
    { role: 'button', name: 'Details', tag: 'button', interactable: true },
  ] });
  const amb = resolveTarget(two, { target: 'Details' });
  assert.ok(Array.isArray(amb.ambiguous) && amb.ambiguous.length === 2, 'ambiguous → candidate refs');
  assert.deepEqual(resolveTarget(two, { target: 'Details', role: 'button' }), { ref: 'details-2' });
});

test('isProtectedField catches password, file, and credential-named fields', () => {
  assert.equal(isProtectedField({ tag: 'input', type: 'password' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'file' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Card number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'CVV' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Search' }), false);
});

test('outline shows viewport interactables and flags the protected field', () => {
  const { text } = renderSnapshot(page, { level: 'outline' });
  assert.match(text, /add-to-basket button "Add to basket" \(in: product card 'Oat Milk'\)/);
  assert.match(text, /password textbox "Password".*protected — I can't fill this/);
  assert.doesNotMatch(text, /help link "Help"/); // not in viewport → excluded from outline
});

test('actions level includes whole-page interactables (the footer link)', () => {
  const { text } = renderSnapshot(page, { level: 'actions' });
  assert.match(text, /help link "Help"/);
});

test('scope narrows to one section', () => {
  const { text } = renderSnapshot(page, { level: 'actions', scope: 'add-to-basket' });
  assert.match(text, /scope: add-to-basket/);
  assert.match(text, /Add to basket/);
  assert.doesNotMatch(text, /Help/); // footer link is a different section
});

test('an unknown scope ref returns a re-observe hint, not a crash', () => {
  const { text } = renderSnapshot(page, { level: 'actions', scope: 'r99' });
  assert.match(text, /unknown ref r99 — browse_see to re-observe/);
});

test('a huge page truncates explicitly under the cap', () => {
  const big = {
    url: 'https://x', title: 'Big', generation: 1,
    nodes: Array.from({ length: 500 }, (_, i) => ({
      role: 'button', name: `Button number ${i} with a longish label`, tag: 'button',
      interactable: true, inViewport: true, section: 'grid', nth: i,
    })),
  };
  const { text, truncated } = renderSnapshot(big, { level: 'outline' });
  assert.equal(truncated, true);
  assert.match(text, /…\+\d+ more \[browse_see level=full or scope=rN\]/);
  // token estimate stays within the cap (+ a small tolerance for the hint line)
  assert.ok(Math.ceil(text.length / 4) <= LEVEL_CAPS.outline + 40);
});

test('computeDelta reports navigation, element delta, and a handled dialog', () => {
  const before = page;
  const after = { ...page, url: 'https://shop.example/basket', title: 'Basket', nodes: page.nodes.slice(0, 3) };
  const v = computeDelta(before, after, {
    actedRef: 'r2', actionLabel: 'clicked',
    event: { dialog: { type: 'confirm', message: 'Add to basket?', handled: 'dismissed' } },
  });
  assert.match(v, /ok — clicked r2/);
  assert.match(v, /navigated to https:\/\/shop\.example\/basket/);
  assert.match(v, /-2 elements/);
  assert.match(v, /dialog \(confirm\).*dismissed/);
});

test('computeDelta on a no-op act says no navigation', () => {
  const v = computeDelta(page, page, { actedRef: 'r1', actionLabel: 'filled' });
  assert.match(v, /ok — filled r1/);
  assert.match(v, /no navigation/);
});

test('computeDelta reports a page scroll (+ any newly-loaded elements)', () => {
  const before = { url: 'https://x', title: 'X', nodes: [{}, {}] };
  const after = { url: 'https://x', title: 'X', nodes: [{}, {}, {}, {}] };   // 2 lazy-loaded
  const v = computeDelta(before, after, { actionLabel: 'scrolled down', event: { scrolled: 'down' } });
  assert.match(v, /ok — scrolled down/);
  assert.match(v, /\+2 elements/);
  assert.match(v, /scrolled down/);
});

// ── Images the model can perceive + screenshot ─────────────────────────────
const imaged = {
  url: 'https://shop.example/oat-milk', title: 'Oat Milk', generation: 1,
  nodes: [
    { role: 'button', name: 'Buy', tag: 'button', interactable: true, inViewport: true },
    { role: 'image', name: 'Oat milk carton', alt: 'A 1L carton of barista oat milk', tag: 'img', isImage: true, interactable: false, inViewport: true, section: "product card", css: 'img.hero' },
    { role: 'image', name: '', alt: '', tag: 'canvas', isImage: true, interactable: false, inViewport: true, css: 'canvas.chart' },
  ],
  text: '',
};

test('images get refs (so a screenshot can scope to one) without being interactables', () => {
  const { order, byRef } = buildRefTable(imaged);
  assert.deepEqual(order, ['buy', 'oat-milk-carton', 'image']);   // named image → slug; unnamed → role slug
  assert.equal(byRef.get('oat-milk-carton').node.isImage, true);
  assert.equal(byRef.get('oat-milk-carton').node.css, 'img.hero'); // driver screenshots this via scope
  assert.equal(byRef.get('image').node.isImage, true);            // the canvas, unnamed
});

test('the snapshot names images (incl. alt text) so the model KNOWS pictures are on the page', () => {
  const { text } = renderSnapshot(imaged, { level: 'outline' });
  assert.match(text, /\[images\] 2 — browse_screenshot to look/);
  assert.match(text, /oat-milk-carton "Oat milk carton" \(alt: "A 1L carton of barista oat milk"\)/);
  assert.match(text, /image \(no caption\)/);   // the unnamed, alt-less canvas is still surfaced
});

test('an image whose only description is alt shows that alt', () => {
  const t = { nodes: [{ role: 'image', name: '', alt: 'Bar chart of monthly sales', tag: 'img', isImage: true, inViewport: true }] };
  const { text } = renderSnapshot(t, { level: 'outline' });
  assert.match(text, /\(alt: "Bar chart of monthly sales"\)/);
});

// ── Pass 3a: hardened credential/payment field detection ───────────────────
test('isProtectedField catches autocomplete + name/inputmode payment heuristics', () => {
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'cc-csc' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'current-password' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'IBAN' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', name: 'Routing number' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'tel', name: 'Card CVV' }), true);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', inputmode: 'numeric', name: 'security code' }), true);
  // A normal search/name field with a numeric mode is NOT protected.
  assert.equal(isProtectedField({ tag: 'input', type: 'text', inputmode: 'numeric', name: 'Quantity' }), false);
  assert.equal(isProtectedField({ tag: 'input', type: 'text', autocomplete: 'email', name: 'Email' }), false);
});

// ── Pass 3b: the fill-source gate (vault vs model bytes) ───────────────────
import { evaluateFill, protectedKind } from '../browser-lens.js';

test('protectedKind classifies payment vs credential vs plain', () => {
  assert.equal(protectedKind({ tag: 'input', type: 'text', autocomplete: 'cc-number' }), 'payment');
  assert.equal(protectedKind({ tag: 'input', type: 'password' }), 'credential');
  assert.equal(protectedKind({ tag: 'input', type: 'text', name: 'Search' }), null);
});

test('evaluateFill: a plain field takes model value; a stray secret is refused', () => {
  const plain = { tag: 'input', type: 'text', name: 'Search' };
  assert.deepEqual(evaluateFill(plain, { value: 'kittens' }), { ok: true, value: 'kittens', grantUsed: null });
  assert.equal(evaluateFill(plain, { secret: 'oops' }).ok, false); // no secrets into arbitrary boxes
});

test('evaluateFill: a protected field refuses model bytes and needs the matching grant', () => {
  const pw = { tag: 'input', type: 'password', name: 'Password' };
  assert.equal(evaluateFill(pw, { value: 'typed' }).ok, false);            // model bytes refused
  assert.equal(evaluateFill(pw, { secret: 's', grants: {} }).ok, false);   // vault but no grant
  const okd = evaluateFill(pw, { secret: 's', grants: { credentials: true } });
  assert.deepEqual(okd, { ok: true, value: 's', grantUsed: 'credentials' });
  // a payment field needs the payments grant, not credentials
  const card = { tag: 'input', type: 'text', autocomplete: 'cc-number' };
  assert.equal(evaluateFill(card, { secret: 's', grants: { credentials: true } }).ok, false);
  assert.equal(evaluateFill(card, { secret: 's', grants: { payments: true } }).grantUsed, 'payments');
});
