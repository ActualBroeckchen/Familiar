/**
 * Pre-start hook: make sure the port we're about to bind to isn't held
 * by a previous Proto-Familiar instance. The .bat / .sh launchers
 * already do this in their own dialects; this script gives `npm start`
 * and `npm run dev` the same behaviour so any way you launch
 * Proto-Familiar converges on a working server.
 *
 * Rules:
 *   - Port free → exit 0 silently.
 *   - Port held by a recognisable previous Proto-Familiar (PID file
 *     points at a live `node server.js` process rooted in THIS repo) →
 *     SIGTERM, wait up to 5s for release, SIGKILL if needed, then
 *     exit 0.
 *   - Port held by anything else → exit 1 with a clear error naming
 *     the port and pointing at the obvious next steps (stop.bat /
 *     stop.sh, or PORT=<other>). Refusing to kill an unknown process
 *     is deliberate — prestart is the wrong layer for guessing.
 *
 * PORT resolves the same way server.js does: env PORT or 8742.
 */

import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PID_FILE  = path.join(REPO_ROOT, '.proto-familiar.pid');
const PORT      = Number(process.env.PORT) || 8742;

function say(msg)  { process.stdout.write(`[ensure-port-free] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[ensure-port-free] ${msg}\n`); }

/** Resolve via a quick listen probe. Race-free for our purposes since
 *  the only follow-up is server.js binding the same port a moment later
 *  — if a third party grabs it between probe and bind, server.js's own
 *  EADDRINUSE is still the right error to surface. */
function isPortInUse(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', e => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '0.0.0.0');
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM means alive but not ours to signal
}

/** Read the PID file written by start.sh / start.bat. Returns null if
 *  it's missing, malformed, or the PID is no longer alive. Doesn't
 *  attempt to verify whether the PID is *actually* server.js — the
 *  matching-cwd check below covers that for the cross-platform case
 *  too. */
function readPidFile() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pidAlive(pid) ? pid : null;
  } catch { return null; }
}

/** Cross-platform: ask the OS who's listening on `port`. Returns the
 *  PID or null. We need the OS layer because the PID file isn't
 *  written when the previous instance was started via `node server.js`
 *  directly (no launcher script), which is exactly the user the
 *  prestart hook exists to help. */
function findPortOwnerPid(port) {
  if (process.platform === 'win32') {
    // Get-NetTCPConnection returns one row per local socket; LISTEN
    // state filters away outbound connections that happen to share a
    // local port. Output is one OwningProcess per line.
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ], { encoding: 'utf8' });
    const pid = parseInt((r.stdout ?? '').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
  // macOS + Linux: lsof is the most portable. -t = terse (PIDs only),
  // -i = internet socket, sTCP:LISTEN keeps it to actual listeners.
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = parseInt((r.stdout ?? '').split('\n')[0]?.trim() ?? '', 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Describe a process by what's actually inspectable on each platform.
 *  We need enough signal to decide "is this one of ours" AND enough
 *  text to show the user when we refuse to kill — so they can see
 *  what they're dealing with without launching Task Manager. */
function describeProcess(pid) {
  if (process.platform === 'win32') {
    // Name + CommandLine, joined with a sentinel so paths can contain |.
    // We deliberately don't try to read cwd: Win32_Process doesn't
    // expose it, and pulling it via PEB inspection requires native
    // code. The Name + CommandLine combination is enough to identify
    // a `node server.js` process unambiguously in practice (see
    // isOurServerProcess for the rationale on dropping the cwd check).
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;` +
      `if ($p) { "$($p.Name)|||$($p.CommandLine)" }`,
    ], { encoding: 'utf8' });
    const out = (r.stdout ?? '').trim();
    if (!out) return { name: null, cmdline: null };
    const sep = out.indexOf('|||');
    if (sep < 0) return { name: out, cmdline: null };
    return { name: out.slice(0, sep), cmdline: out.slice(sep + 3) };
  }
  // Linux: cwd via /proc, cmdline via /proc.
  if (existsSync(`/proc/${pid}/cwd`)) {
    let cwd = null, cmd = null;
    try {
      cwd = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' }).stdout?.trim() || null;
    } catch { /* fall through */ }
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch { /* fall through */ }
    return { name: cmd?.split(/\s+/)[0]?.split('/').pop() ?? null, cmdline: cmd, cwd };
  }
  // macOS: lsof for cwd, ps for command.
  const lsofR = spawnSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { encoding: 'utf8' });
  const cwd = (lsofR.stdout ?? '').split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null;
  const psR = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  const cmdline = (psR.stdout ?? '').trim() || null;
  return { name: cmdline?.split(/\s+/)[0]?.split('/').pop() ?? null, cmdline, cwd };
}

/** Decide whether `pid` looks like a Proto-Familiar `node server.js`
 *  we should feel safe killing. On Unix we verify cwd against the
 *  repo root — strict and trustworthy. On Windows we can't get cwd
 *  reliably, so we accept "Name=node.exe + CommandLine contains
 *  server.js" — the chance of an unrelated node process called
 *  server.js happening to hold our exact port is vanishingly small,
 *  and the alternative (refuse to kill, force the user to chase the
 *  PID manually) is worse UX than the false-positive risk. */
function isOurServerProcess(pid, info) {
  if (process.platform === 'win32') {
    return /^node(\.exe)?$/i.test(info.name ?? '')
        && /server\.js/i.test(info.cmdline ?? '');
  }
  if (!info.cwd || path.resolve(info.cwd) !== path.resolve(REPO_ROOT)) return false;
  return /node\b/.test(info.cmdline ?? '') && /server\.js/.test(info.cmdline ?? '');
}

async function waitForRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── main ──────────────────────────────────────────────────────────────

if (!(await isPortInUse(PORT))) process.exit(0);

// Port is busy. The port owner is the canonical kill target — killing
// any other PID (e.g. a stale .proto-familiar.pid pointing at a since-
// recycled process) wouldn't free this port. The PID file matters
// only as a corroborating "yes this came from our launcher" signal.
const portOwner = findPortOwnerPid(PORT);
if (!portOwner) {
  warn(`Port ${PORT} is in use but the owning PID couldn't be identified.`);
  warn(`  Try stop.bat (Windows) or ./stop.sh (Unix), or set PORT=<other>.`);
  process.exit(1);
}

const info = describeProcess(portOwner);
const pidFilePid = readPidFile();
const inPidFile  = pidFilePid === portOwner;

if (!inPidFile && !isOurServerProcess(portOwner, info)) {
  warn(`Port ${PORT} is held by PID ${portOwner}, which doesn't look like a Proto-Familiar instance.`);
  if (info.name)    warn(`  Process name: ${info.name}`);
  if (info.cmdline) warn(`  CommandLine:  ${info.cmdline}`);
  warn(`  Stop that process or set PORT=<other> and try again.`);
  if (process.platform === 'win32') {
    warn(`  To force-kill manually: taskkill /PID ${portOwner} /F`);
  } else {
    warn(`  To force-kill manually: kill -9 ${portOwner}`);
  }
  process.exit(1);
}

// Print what we're about to kill so the user can intervene if the
// match was a false positive (Ctrl-C the npm start, then investigate).
const source = inPidFile ? 'from PID file' : 'identified by process inspection';
say(`Recycling stale Proto-Familiar (PID ${portOwner}, ${source}) holding port ${PORT}…`);
if (info.cmdline) say(`  CommandLine: ${info.cmdline}`);
try { process.kill(portOwner, 'SIGTERM'); } catch { /* already dying */ }

if (await waitForRelease(PORT, 5_000)) {
  process.exit(0);
}

// Stubborn — escalate.
warn(`PID ${portOwner} didn't release port ${PORT} after 5s — sending SIGKILL.`);
try { process.kill(portOwner, 'SIGKILL'); } catch { /* already gone */ }
if (await waitForRelease(PORT, 2_000)) process.exit(0);

warn(`Port ${PORT} is still busy after SIGKILL. Investigate manually.`);
process.exit(1);
