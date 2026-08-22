import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createGuardedProxy } from '../browser-proxy.js';

// Issue a raw CONNECT through the proxy and return the first status line.
function connectVia(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); sock.destroy(); }
    });
    sock.on('error', reject);
    setTimeout(() => { resolve(buf.split('\r\n')[0] || '(no response)'); sock.destroy(); }, 2000);
  });
}

test('a host that RESOLVES to a private IP is refused (rebinding defence)', async () => {
  // The attacker's DNS returns a loopback address; the proxy must refuse.
  const proxy = createGuardedProxy({ lookupFn: async () => [{ address: '127.0.0.1' }] });
  const port = await proxy.listen();
  try {
    const status = await connectVia(port, 'evil.example:443');
    assert.match(status, /403/);
    assert.equal(proxy.stats().blocked, 1);
  } finally { await proxy.close(); }
});

test('a raw private-IP CONNECT target is refused without any lookup', async () => {
  const proxy = createGuardedProxy({ lookupFn: async () => { throw new Error('should not resolve a literal IP'); } });
  const port = await proxy.listen();
  try {
    const status = await connectVia(port, '169.254.169.254:80'); // cloud metadata
    assert.match(status, /403/);
  } finally { await proxy.close(); }
});

test('a host resolving to BOTH public and private is refused (fail-closed)', async () => {
  const proxy = createGuardedProxy({ lookupFn: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }] });
  const port = await proxy.listen();
  try {
    const status = await connectVia(port, 'mixed.example:443');
    assert.match(status, /403/);
  } finally { await proxy.close(); }
});

test('a host resolving to a public IP is allowed through the guard (200 or upstream failure, never 403)', async () => {
  // Point at a local throwaway TCP server standing in for the "public" host, so
  // no real network is needed; the guard sees a non-blocked address and tunnels.
  const upstream = net.createServer((s) => s.end());
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  // lookupFn returns a public-looking address, but we can't actually route there
  // in a test; assert only that the guard did NOT refuse it (status is not 403).
  const proxy = createGuardedProxy({ lookupFn: async () => [{ address: '93.184.216.34' }] });
  const port = await proxy.listen();
  try {
    const status = await connectVia(port, 'example.com:443');
    assert.doesNotMatch(status, /403/);
    assert.equal(proxy.stats().blocked, 0);
  } finally { await proxy.close(); upstream.close(); }
});
