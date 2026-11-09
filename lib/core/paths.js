/**
 * Path layout for the edge-cdp plugin.
 *
 * Everything the plugin owns lives under ONE data root, outside the package:
 *
 *   <DSH_HOME>/edge-cdp/
 *     profile/   Chromium user-data-dir (login state -- treat as a password)
 *     tabs/      one claim record per browser tab
 *     logs/      Edge stderr/stdout capture
 *     edge.json  the single owner record for the running browser
 *
 * WHY NOT INSIDE THE PACKAGE
 * The package is installable from git, so pnpm owns that directory: an upgrade
 * replaces it wholesale. A browser profile kept there would be deleted by the
 * next `pnpm update` -- taking the user's login state with it. Runtime data
 * therefore belongs beside the user, not beside the code.
 *
 * Precedence: explicit config > EDGE_CDP_ROOT > <DSH_HOME>/edge-cdp.
 *
 * Pure: no cordis, no side effects beyond mkdir when asked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Plugin package root (lib/core -> lib -> package). */
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

/**
 * Resolve the Harness home the way DSH does: DSH_HOME wins, else ~/.dsh.
 * Reimplemented instead of imported so this module stays dependency-free.
 * @returns {string}
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);
  return path.join(os.homedir(), '.dsh');
}

/**
 * Default data root: <DSH_HOME>/edge-cdp.
 * @returns {string}
 */
export function defaultEdgeRoot() {
  return path.join(resolveDshHome(), 'edge-cdp');
}

/**
 * The legacy in-package location, recognised only to explain a migration.
 * @returns {string}
 */
export function legacyEdgeRoot() {
  return path.join(PACKAGE_ROOT, 'var');
}

/**
 * Resolve the plugin's directory layout.
 * @param {string} [edgeRoot] - absolute override, normally from plugin config.
 * @returns {{root:string, profile:string, tabs:string, logs:string, ownerFile:string}}
 */
export function paths(edgeRoot) {
  const root = edgeRoot
    ? path.resolve(edgeRoot)
    : (process.env.EDGE_CDP_ROOT || defaultEdgeRoot());
  return {
    root,
    profile: path.join(root, 'profile'),
    tabs: path.join(root, 'tabs'),
    logs: path.join(root, 'logs'),
    ownerFile: path.join(root, 'edge.json'),
  };
}

/**
 * Whether the layout still points at the in-package directory, which a git
 * install would wipe.
 * @param {ReturnType<typeof paths>} p
 * @returns {boolean}
 */
export function isInsidePackage(p) {
  const relative = path.relative(PACKAGE_ROOT, p.root);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Create every writable directory the plugin needs.
 * @param {ReturnType<typeof paths>} p
 */
export function ensureDirs(p) {
  for (const dir of [p.root, p.tabs, p.logs]) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a file atomically (same-directory rename), so a reader never sees a
 * half-written JSON document.
 * @param {string} file
 * @param {string} text
 */
export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Read UTF-8 text, tolerating a BOM written by Windows PowerShell.
 * @param {string} file
 * @returns {string}
 */
export function readText(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
