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

/** Verify that `pid` is a `node server.js`-shaped process rooted at
 *  this repo. Used to make "yes this is one of ours" cross-platform
 *  without trusting the PID file alone. We never kill a PID that
 *  fails this check. */
function isOurServerProcess(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`,
    ], { encoding: 'utf8' });
    const cmdline = (r.stdout ?? '').trim();
    return /node(\.exe)?\b/i.test(cmdline)
        && /server\.js/i.test(cmdline)
        // Win32 CommandLine may use either slash direction; normalise.
        && cmdline.replace(/\\/g, '/').includes(REPO_ROOT.replace(/\\/g, '/'));
  }
  // Linux: /proc/$pid/cwd is a symlink to the working directory.
  if (existsSync(`/proc/${pid}/cwd`)) {
    try {
      const cwd = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' }).stdout?.trim();
      if (cwd && path.resolve(cwd) === path.resolve(REPO_ROOT)) {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        return cmd.includes('node') && cmd.includes('server.js');
      }
    } catch { /* fall through */ }
  }
  // macOS: lsof tells us the cwd; cleaner than parsing ps output.
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { encoding: 'utf8' });
  const cwd = (r.stdout ?? '').split('\n').find(l => l.startsWith('n'))?.slice(1);
  if (!cwd || path.resolve(cwd) !== path.resolve(REPO_ROOT)) return false;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return /node\b/.test(ps.stdout ?? '') && /server\.js/.test(ps.stdout ?? '');
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

// Port is busy. First try the PID file (the launchers' own record),
// then ask the OS who owns the port. Either way, we only kill if we
// can confirm it's our own server process.
let candidate = readPidFile();
if (!candidate) candidate = findPortOwnerPid(PORT);

if (!candidate) {
  warn(`Port ${PORT} is in use but the owner couldn't be identified.`);
  warn(`  Run stop.bat (Windows) or ./stop.sh (Unix), or set PORT=<other>.`);
  process.exit(1);
}

if (!isOurServerProcess(candidate)) {
  warn(`Port ${PORT} is held by PID ${candidate}, which isn't a Proto-Familiar instance.`);
  warn(`  Stop that process or set PORT=<other> and try again.`);
  process.exit(1);
}

say(`Recycling stale Proto-Familiar (PID ${candidate}) holding port ${PORT}…`);
try { process.kill(candidate, 'SIGTERM'); } catch { /* already dying */ }

if (await waitForRelease(PORT, 5_000)) {
  process.exit(0);
}

// Stubborn — escalate.
warn(`PID ${candidate} didn't release port ${PORT} after 5s — sending SIGKILL.`);
try { process.kill(candidate, 'SIGKILL'); } catch { /* already gone */ }
if (await waitForRelease(PORT, 2_000)) process.exit(0);

warn(`Port ${PORT} is still busy after SIGKILL. Investigate manually.`);
process.exit(1);
