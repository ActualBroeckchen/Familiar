/**
 * cdp-launcher.js — the "Set up my Chrome" one-click helper for CDP mode.
 *
 * CDP mode's first safety gate is "the ward launched Chrome with the debug port
 * open THEMSELVES" (docs/browser-cdp-mode-build-spec.md §3) — but hand-editing a
 * shortcut to add `--remote-debugging-port=9222` is exactly the fiddly, techie
 * step this app exists to spare its ward. This helper writes a double-clickable
 * launcher to the Desktop so the ward performs one deliberate physical act (open
 * the special Chrome) with none of the command-line surgery. The app still never
 * launches Chrome itself — it only lays down a shortcut the ward chooses to run.
 *
 * SAFER than the spec's "your everyday Chrome": the launcher points at a
 * DEDICATED, separate profile (`--user-data-dir`), so the Familiar-drivable
 * browser starts logged OUT and only ever holds the sites the ward deliberately
 * signs into there — the ward's real profile (bank, email) is never exposed to
 * the debug port. Ward-approved deviation.
 *
 * `launcherPlan` is pure (content + filename + mode); the endpoint owns the fs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CDP_PORT = 9222;

/** The ward's real Chrome (or Edge/Chromium) — the browser the launcher opens. */
export function findWardChrome(platform = process.platform, env = process.env) {
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  const cands = [];
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean)) {
      cands.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      cands.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    cands.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  for (const c of cands) if (exists(c)) return c;
  return null;
}

/** The dedicated, separate profile the Familiar-drivable Chrome uses. */
export function cdpChromeProfileDir() { return path.join(os.homedir(), '.proto-familiar', 'cdp-chrome'); }

/** Where to drop the launcher — the Desktop if there is one, else the home dir. */
export function desktopDir() {
  const d = path.join(os.homedir(), 'Desktop');
  try { if (fs.existsSync(d)) return d; } catch {}
  return os.homedir();
}

const CHROME_ARGS = (port, profileDir) => [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
];

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
// Quote a `--flag=value` only when the value has whitespace (a path); leave bare
// values (the numeric port) unquoted so shells/.desktop parse them cleanly.
const fmtArg = (a) => {
  const i = a.indexOf('=');
  if (i === -1) return a;
  const k = a.slice(0, i), v = a.slice(i + 1);
  return /\s/.test(v) ? `${k}=${q(v)}` : `${k}=${v}`;
};

/**
 * Build the launcher file for a platform. Inputs are resolved absolute paths.
 * Returns { filename, content, mode, argsPreview } — the caller writes it and
 * reports the path. Throws on an unsupported platform (the endpoint turns that
 * into manual guidance).
 */
export function launcherPlan({ platform, chromePath, profileDir, port = CDP_PORT }) {
  const args = CHROME_ARGS(port, profileDir);
  const argsPreview = args.join(' ');
  if (platform === 'win32') {
    // .cmd: `start ""` returns immediately so the console flashes only briefly.
    const line = `start "" ${q(chromePath)} ${args.map(fmtArg).join(" ")}`;
    return {
      filename: 'Start Familiar Chrome.cmd',
      mode: 0o644,
      argsPreview,
      content: `@echo off\r\nrem Opens a Chrome your Familiar can drive (debug port + its own profile).\r\n${line}\r\n`,
    };
  }
  if (platform === 'darwin') {
    const line = `${q(chromePath)} ${args.map(fmtArg).join(" ")} >/dev/null 2>&1 &`;
    return {
      filename: 'Start Familiar Chrome.command',
      mode: 0o755,
      argsPreview,
      content: `#!/bin/bash\n# Opens a Chrome your Familiar can drive (debug port + its own profile).\n${line}\ndisown\n`,
    };
  }
  if (platform === 'linux') {
    const exec = `${q(chromePath)} ${args.map(fmtArg).join(" ")}`;
    return {
      filename: 'Start Familiar Chrome.desktop',
      mode: 0o755,
      argsPreview,
      content: `[Desktop Entry]\nType=Application\nName=Start Familiar Chrome\nComment=Opens a Chrome your Familiar can drive (debug port + its own profile)\nExec=${exec}\nTerminal=false\n`,
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** A short, ward-facing "what to do next" for the returned launcher. */
export function launcherInstructions(platform) {
  const common = 'Double-click it whenever you want your Familiar to help on a site. A fresh Chrome opens — log into the sites you want help with (like Reddit) once, and it remembers.';
  if (platform === 'darwin') return `I put “Start Familiar Chrome” on your Desktop. The first time, right-click it → Open (macOS asks once). ${common}`;
  if (platform === 'win32') return `I put “Start Familiar Chrome” on your Desktop. Windows may ask “More info → Run anyway” the first time. ${common}`;
  return `I put “Start Familiar Chrome” on your Desktop. You may need to right-click → Allow Launching / Properties → mark it executable the first time. ${common}`;
}
