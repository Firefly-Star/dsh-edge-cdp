/**
 * Claim records: one JSON file per tab, holding who claims it and what they did.
 *
 * The problem this solves: several agents share one browser, and "who navigated
 * this tab away while I was filling a form" used to be unanswerable. A record is
 * keyed by targetId, `claims` is a reference count, and mutating commands are
 * logged by the client rather than by agent discipline.
 *
 * Concurrency: a read-modify-write takes a pid-aware lock file. A lock left by
 * a dead process is stolen immediately, so a killed command cannot wedge the
 * tab for everyone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readText, writeTextAtomic } from './paths.js';

/** Any tab at all, as returned by CDP /json/list. */
const LOCK_TIMEOUT = 3000;

/** Commands that change the page and therefore require a named owner. */
export const MUTATING = new Set(['nav', 'click', 'fill', 'eval', 'newtab', 'claim', 'close']);

/**
 * @typedef {Object} ClaimRecord
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Record<string,{since:string,lastUsed:string|null}>} claims
 * @property {Array<Record<string,unknown>>} log
 * @property {'created'|'adopted'} origin
 */

const nowIso = () => new Date().toISOString();
const trim = (value, max = 90) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Upgrade older record shapes and drop junk.
 * @param {any} raw
 * @returns {ClaimRecord|null}
 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  // Legacy shape (<name>.json: {name,id,url,createdAt,lastUsedAt}) upgraded in place.
  if (!raw.claims && raw.name) {
    const at = raw.createdAt || nowIso();
    return {
      id: raw.id,
      url: raw.url || '',
      title: '',
      createdAt: at,
      updatedAt: at,
      claims: { [raw.name]: { since: at, lastUsed: raw.lastUsedAt || null } },
      log: [],
      origin: 'created',
    };
  }
  return {
    id: raw.id,
    url: raw.url || '',
    title: raw.title || '',
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.createdAt || nowIso(),
    claims: raw.claims && typeof raw.claims === 'object' ? raw.claims : {},
    log: Array.isArray(raw.log) ? raw.log : [],
    // created = opened by this workspace (closed when the count hits zero);
    // adopted = someone's existing page (never closed on our behalf).
    origin: raw.origin === 'created' ? 'created' : 'adopted',
  };
}

/**
 * Read one record.
 * @param {string} tabsDir
 * @param {string} id
 * @returns {ClaimRecord|null}
 */
export function readRecord(tabsDir, id) {
  const file = path.join(tabsDir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(readText(file)); }
  catch { throw new Error(`认领记录损坏：${file}（改名留档后重新 newtab / claim）`); }
  const record = normalizeRecord(raw);
  if (!record) throw new Error(`认领记录不可用（缺少 id 字段）：${file}`);
  return record;
}

/**
 * Read every record, reporting unparseable files instead of hiding them: a
 * silently dropped record is a silently lost owner.
 * @param {string} tabsDir
 * @returns {{byId:Map<string,ClaimRecord>, corrupt:Array<{file:string,reason:string}>}}
 */
export function loadAll(tabsDir) {
  const byId = new Map();
  const corrupt = [];
  let files = [];
  try { files = fs.readdirSync(tabsDir); } catch { return { byId, corrupt }; }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(tabsDir, file);
    let raw;
    try { raw = JSON.parse(readText(full)); }
    catch (e) { corrupt.push({ file, reason: trim(e.message, 70) }); continue; }
    const record = normalizeRecord(raw);
    if (!record) { corrupt.push({ file, reason: '没有可用的 id 字段' }); continue; }
    byId.set(record.id, record);
    if (file !== `${record.id}.json`) {
      try { writeTextAtomic(path.join(tabsDir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n'); fs.unlinkSync(full); }
      catch { /* migration is best-effort */ }
    }
  }
  return { byId, corrupt };
}

/**
 * Own the tab record lock.
 * @param {string} tabsDir
 * @param {string} id
 * @returns {string} lock path
 */
export function acquireLock(tabsDir, id) {
  fs.mkdirSync(tabsDir, { recursive: true });
  const lock = path.join(tabsDir, `${id}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(lock)) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() - started > LOCK_TIMEOUT) throw new Error(`页签记录被别的进程锁着（${lock}），稍后重试`);
      const until = Date.now() + 15;
      while (Date.now() < until) { /* brief spin */ }
    }
  }
}

/**
 * A lock is stale when its owner is provably gone.
 * @param {string} lock
 * @returns {boolean}
 */
function lockIsStale(lock) {
  let owner = 0;
  try { owner = parseInt(fs.readFileSync(lock, 'utf8'), 10) || 0; } catch { return true; }
  if (!owner) return true;
  if (owner === process.pid) return false;
  try { process.kill(owner, 0); return false; }
  catch (e) { if (e.code === 'ESRCH') return true; }
  try { return Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { return true; }
}

/**
 * Release a lock.
 * @param {string} lock
 */
export function releaseLock(lock) {
  try { fs.unlinkSync(lock); } catch { /* already released */ }
}

/**
 * Read-modify-write one record under its lock.
 * @param {string} tabsDir
 * @param {string} id
 * @param {(record:ClaimRecord|null)=>ClaimRecord|null} mutate - return null to delete
 * @returns {ClaimRecord|null}
 */
export function updateRecord(tabsDir, id, mutate) {
  const lock = acquireLock(tabsDir, id);
  try {
    let record = readRecord(tabsDir, id);
    const next = mutate(record);
    if (next === null) {
      try { fs.unlinkSync(path.join(tabsDir, `${id}.json`)); } catch { /* already gone */ }
      return null;
    }
    record = next;
    record.id = id;
    record.updatedAt = nowIso();
    if (!Array.isArray(record.log)) record.log = [];
    writeTextAtomic(path.join(tabsDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
    return record;
  } finally {
    releaseLock(lock);
  }
}

/**
 * Names claiming a record.
 * @param {ClaimRecord|null} record
 * @returns {string[]}
 */
export function ownersOf(record) {
  return record && record.claims ? Object.keys(record.claims) : [];
}

/**
 * Append one operation entry.
 *
 * Mutations always leave a trace (a record is created if needed). Read-only
 * commands only append when a record already exists, so browsing does not fill
 * the directory with noise -- but a shared tab still shows who screenshotted it.
 *
 * @param {string} tabsDir
 * @param {string} id
 * @param {string} who
 * @param {string} cmd
 * @param {string} detail
 * @param {boolean} ok
 * @param {string} [errText]
 */
export function note(tabsDir, id, who, cmd, detail, ok, errText) {
  if (!id) return;
  try {
    const exists = fs.existsSync(path.join(tabsDir, `${id}.json`));
    if (!exists) {
      if (!MUTATING.has(cmd)) return;
      updateRecord(tabsDir, id, () => ({
        id, url: '', title: '', createdAt: nowIso(), updatedAt: nowIso(), claims: {}, log: [], origin: 'created',
      }));
    }
    updateRecord(tabsDir, id, (record) => {
      if (!record) return record;
      const at = nowIso();
      record.log.push({
        at, who, cmd, detail: trim(detail), ok: ok !== false,
        ...(errText ? { error: trim(errText, 160) } : {}),
      });
      if (who && record.claims && record.claims[who]) record.claims[who].lastUsed = at;
      return record;
    });
  } catch (e) {
    // Bookkeeping failure must not fail the command, but must be visible.
    console.error(`WARN: 操作流水写入失败（${id}）：${e.message}`);
  }
}

/**
 * Find the live tab a name claims.
 * Also retires claims pointing at tabs that no longer exist.
 * @param {string} tabsDir
 * @param {string} name
 * @param {Array<{id:string,title?:string,url?:string}>} pages
 * @returns {ClaimRecord|null}
 */
export function claimByName(tabsDir, name, pages) {
  const { byId } = loadAll(tabsDir);
  const records = [...byId.values()].filter((r) => r.claims && r.claims[name]);
  if (records.length === 0) return null;
  const alive = [];
  for (const record of records) {
    if (pages.some((p) => p.id === record.id)) { alive.push(record); continue; }
    updateRecord(tabsDir, record.id, (current) => {
      if (!current) return current;
      delete current.claims[name];
      return ownersOf(current).length === 0 && current.log.length === 0 ? null : current;
    });
  }
  if (alive.length === 0) return null;
  if (alive.length > 1) {
    throw new Error(
      `名字 "${name}" 同时认领着 ${alive.length} 个页签，拒绝猜测：\n` +
      alive.map((r) => `  ${r.id}  ${r.title || ''}  ${r.url}`).join('\n') +
      `\n先 close 其中一个，或改用 targetId。`
    );
  }
  return alive[0];
}
