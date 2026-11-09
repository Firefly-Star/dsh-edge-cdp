/**
 * Argv construction and launch for the headed, resident Edge.
 *
 * Design constraints, each one earned:
 *  1. HEADED. The user must see what the agent does and must be able to log in
 *     by hand. A headless browser cannot be helped, only worked around.
 *  2. RESIDENT. Detached from the caller, so a DSH restart or a finished
 *     session never takes the window (and a half-finished login) with it.
 *  3. NOT managed by the DSH subprocess seam. That seam runs children in a
 *     Windows Job with a hidden initial window, which is exactly wrong here.
 *  4. One instance per user-data-dir: Chromium silently ignores
 *     --remote-debugging-port on a second launch against the same profile, so
 *     a "successful" second start would open a window with no debug port.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Candidate Edge locations, most specific first. */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Locate msedge.exe.
 * @param {string} [override] - explicit path from config
 * @returns {string|null}
 */
export function findEdge(override) {
  if (override) return fs.existsSync(override) ? override : null;
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : '';
  return local && fs.existsSync(local) ? local : null;
}

/**
 * Build the launch argv. Kept pure so it can be asserted in tests.
 * @param {{port:number, profileDir:string, logFile?:string|null, startUrl?:string}} options
 * @returns {string[]}
 */
export function buildArgs({ port, profileDir, logFile, startUrl }) {
  const args = [
    `--remote-debugging-port=${port}`,
    // Loopback only. Never 0.0.0.0: a debug port is full control of the browser.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    // Keep the browser alive after the last window closes? No: the user
    // closing the window MUST mean the browser exits, otherwise "I closed it"
    // and "the port is still taken" disagree.
    '--disable-background-mode',
  ];
  if (logFile) {
    args.push('--enable-logging', `--log-file=${logFile}`);
  }
  args.push(startUrl || 'about:blank');
  return args;
}

/**
 * Launch Edge detached from the caller.
 *
 * `detached: true` + `unref()` is what makes the browser survive a DSH
 * restart. `windowsHide: false` is what keeps a native window visible.
 * stdio is ignored: the browser owns its own log file via --log-file, and
 * holding our pipes open would tie the child to our lifetime.
 *
 * @param {{edgePath:string, port:number, profileDir:string, logFile:string|null, startUrl?:string}} options
 * @returns {{pid:number|null}}
 */
export function launchEdge(options) {
  const args = buildArgs(options);
  const child = spawn(options.edgePath, args, {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid ?? null };
}
