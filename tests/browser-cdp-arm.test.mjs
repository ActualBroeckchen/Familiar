import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArmDomain, isPrivateOrLoopbackHost, armCdp, disarmCdp, cdpArmActive,
  cdpArmState, armAllowsHost, consumeCdpExpiryNote, _resetCdpArm,
  DEFAULT_ARM_MINUTES, ARM_CEILING_MINUTES, CDP_ENDPOINT,
} from '../src/browser/browser-cdp-arm.js';

function fresh() { _resetCdpArm(); }

test('CDP_ENDPOINT is loopback only', () => {
  assert.equal(new URL(CDP_ENDPOINT).hostname, '127.0.0.1');
});

test('isPrivateOrLoopbackHost: loopback/private/metadata literals are all caught', () => {
  for (const h of ['localhost', 'a.localhost', '127.0.0.1', '10.0.0.5', '192.168.1.9',
    '172.16.0.1', '169.254.169.254', 'metadata.google.internal', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateOrLoopbackHost(h), true, `${h} should be private/loopback`);
  }
  assert.equal(isPrivateOrLoopbackHost('github.com'), false);
  assert.equal(isPrivateOrLoopbackHost('8.8.8.8'), false);
});

test('normalizeArmDomain: strips scheme/path/port/www; refuses IPs + private + junk', () => {
  assert.equal(normalizeArmDomain('github.com'), 'github.com');
  assert.equal(normalizeArmDomain('https://www.github.com/foo?x=1'), 'github.com');
  assert.equal(normalizeArmDomain('GitHub.com:443'), 'github.com');
  assert.equal(normalizeArmDomain('sub.example.co.uk'), 'sub.example.co.uk');
  assert.equal(normalizeArmDomain('127.0.0.1'), null);
  assert.equal(normalizeArmDomain('localhost'), null);
  assert.equal(normalizeArmDomain('169.254.169.254'), null);
  assert.equal(normalizeArmDomain('10.0.0.5'), null);
  assert.equal(normalizeArmDomain('not a domain'), null);
  assert.equal(normalizeArmDomain('nodot'), null);
  assert.equal(normalizeArmDomain(''), null);
});

test('armCdp: valid arm activates, clamps minutes to the ceiling, defaults sanely', () => {
  fresh();
  const r = armCdp({ domain: 'github.com', minutes: 999 });
  assert.equal(r.ok, true);
  assert.equal(r.domain, 'github.com');
  assert.equal(r.minutes, ARM_CEILING_MINUTES);       // clamped
  assert.equal(cdpArmActive(), true);
  fresh();
  assert.equal(armCdp({ domain: 'github.com' }).minutes, DEFAULT_ARM_MINUTES);   // default
  assert.equal(armCdp({ domain: 'bad domain' }).ok, false);
});

test('armAllowsHost: only the armed domain + its subdomains; everything else refused', () => {
  fresh();
  armCdp({ domain: 'github.com', minutes: 15 });
  assert.equal(armAllowsHost('github.com'), true);
  assert.equal(armAllowsHost('api.github.com'), true);
  assert.equal(armAllowsHost('www.github.com'), true);       // www normalised
  assert.equal(armAllowsHost('evil.com'), false);
  assert.equal(armAllowsHost('github.com.evil.com'), false); // suffix trick refused
  assert.equal(armAllowsHost('127.0.0.1'), false);           // private literal refused
  assert.equal(armAllowsHost('notgithub.com'), false);
});

test('armAllowsHost + cdpArmActive: fail-closed when nothing is armed', () => {
  fresh();
  assert.equal(cdpArmActive(), false);
  assert.equal(armAllowsHost('github.com'), false);
  assert.equal(cdpArmState().armed, false);
});

test('expiry: an arm past its window is inactive, flags the one-shot note once', () => {
  fresh();
  const realNow = Date.now;
  try {
    const r = armCdp({ domain: 'github.com', minutes: 15 });
    assert.equal(cdpArmActive(), true);
    Date.now = () => r.expiresAt + 1000;                     // jump past expiry
    assert.equal(cdpArmActive(), false);                     // clears on read
    assert.equal(armAllowsHost('github.com'), false);
    assert.equal(consumeCdpExpiryNote(), true);              // note set exactly once
    assert.equal(consumeCdpExpiryNote(), false);             // and consumed
  } finally { Date.now = realNow; }
});

test('disarm: clears immediately and does NOT raise the "lapsed" note', () => {
  fresh();
  armCdp({ domain: 'github.com', minutes: 15 });
  const r = disarmCdp('ward');
  assert.equal(r.wasArmed, true);
  assert.equal(cdpArmActive(), false);
  assert.equal(consumeCdpExpiryNote(), false);               // deliberate disarm ≠ expiry
});

test('env hard-disable: arming refused, nothing goes active', () => {
  fresh();
  process.env.PROTO_FAMILIAR_BROWSER_CDP_DISABLED = '1';
  try {
    assert.equal(armCdp({ domain: 'github.com' }).ok, false);
    assert.equal(cdpArmActive(), false);
  } finally { delete process.env.PROTO_FAMILIAR_BROWSER_CDP_DISABLED; }
});
