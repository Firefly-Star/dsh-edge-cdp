/**
 * Tab-level operations: resolve, open, claim, release, list, browse history.
 *
 * The refusal to guess is the point: with several agents on one browser, a
 * command that silently picks "the only tab it likes" is how someone else's
 * page gets navigated away mid-task.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cdp from './cdp.js';
import * as records from './records.js';
import { withSession } from './page.js';

/**
 * Resolve which page a command targets.
 * @param {{cdpBase:string, tabsDir:string, tab?:string, targetId?:string}} ctx
 * @returns {Promise<{page:any, record:records.ClaimRecord|null}>}
 */
export async function resolvePage({ cdpBase, tabsDir, tab, targetId }) {
  const pages = await cdp.listPages(cdpBase);

  if (targetId) {
    const hit = pages.find((p) => p.id === targetId);
    if (!hit) {
      throw new Error(`找不到 targetId ${targetId}。现有：\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}`);
    }
    return { page: hit, record: records.readRecord(tabsDir, hit.id) };
  }

  if (tab) {
    const record = records.claimByName(tabsDir, tab, pages);
    if (!record) {
      const { corrupt } = records.loadAll(tabsDir);
      const hint = corrupt.length
        ? `\n注意：tabs 目录里有 ${corrupt.length} 个损坏的记录（${corrupt.map((c) => c.file).join(', ')}），归属可能不可靠，先运行 edge_tabs 看看。`
        : '';
      throw new Error(`名字 "${tab}" 没有认领任何活着的页签。新建用 edge_new_tab，认领已有页签用 edge_claim。${hint}`);
    }
    const hit = pages.find((p) => p.id === record.id);
    if (!hit) throw new Error(`页签 "${tab}" 已经不在了（${record.id}），重新认领或新建。`);
    return { page: hit, record };
  }

  if (pages.length === 0) throw new Error('浏览器里没有任何页签。先用 edge_new_tab 开一个。');
  if (pages.length === 1) return { page: pages[0], record: records.readRecord(tabsDir, pages[0].id) };

  throw new Error(
    `有 ${pages.length} 个页签，且没有指定 tab / targetId，拒绝猜测。` +
    `\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}` +
    `\n\n指定归属：tab=<你的名字>（先认领），或 targetId=<id>。`
  );
}

/**
 * Open a tab and claim it.
 * @param {{cdpBase:string, tabsDir:string, name:string, url?:string, timeoutMs:number}} options
 * @returns {Promise<{targetId:string, claimed:string, url:string, readyMs:number|string}>}
 */
export async function newTab({ cdpBase, tabsDir, name, url, timeoutMs }) {
  const pages = await cdp.listPages(cdpBase);
  const used = records.claimByName(tabsDir, name, pages);
  if (used) throw new Error(`名字 "${name}" 已经认领着 "${used.title || used.url}"（${used.id}）。换个名字，或先释放它。`);

  // Create about:blank first, then Page.navigate: /json/new?<url> mangles ? and #.
  const target = await cdp.api(cdpBase, '/json/new?about:blank', 'PUT');
  let readyMs = 0;
  let info = null;
  await withSession(target, timeoutMs, async (session) => {
    if (url && url !== 'about:blank') {
      await session.send('Page.navigate', { url });
      readyMs = await cdp.waitReady(session, timeoutMs);
    }
    info = await cdp.evaluate(session, '({title: document.title, url: location.href})').catch(() => null);
  });

  const at = new Date().toISOString();
  records.updateRecord(tabsDir, target.id, () => ({
    id: target.id,
    url: info?.url || url || 'about:blank',
    title: info?.title || '',
    createdAt: at,
    updatedAt: at,
    claims: { [name]: { since: at, lastUsed: at } },
    log: [{ at, who: name, cmd: 'newtab', detail: url || 'about:blank', ok: true }],
    origin: 'created',
  }));

  return {
    targetId: target.id,
    claimed: name,
    url: info?.url || url || 'about:blank',
    title: info?.title || '',
    readyMs: readyMs < 0 ? 'TIMEOUT' : readyMs,
  };
}

/**
 * Claim an existing tab (multiple names may claim the same tab).
 * @param {{cdpBase:string, tabsDir:string, name:string, targetId:string}} options
 * @returns {Promise<{targetId:string, refCount:number, owners:string[], origin:string, note:string}>}
 */
export async function claimTab({ cdpBase, tabsDir, name, targetId }) {
  const pages = await cdp.listPages(cdpBase);
  const page = pages.find((p) => p.id === targetId);
  if (!page) throw new Error(`找不到 targetId ${targetId}。现有：\n${pages.map((p) => `  ${p.id}  ${p.title}  ${p.url}`).join('\n')}`);
  const existing = records.claimByName(tabsDir, name, pages);
  if (existing && existing.id !== targetId) {
    throw new Error(`名字 "${name}" 已经认领着另一个页签（${existing.id}）。先释放它。`);
  }

  const record = records.updateRecord(tabsDir, targetId, (current) => {
    const at = new Date().toISOString();
    const base = current || {
      id: targetId, url: '', title: '', createdAt: at, updatedAt: at, claims: {}, log: [], origin: 'adopted',
    };
    base.url = page.url || base.url;
    base.title = page.title || base.title;
    if (!base.claims) base.claims = {};
    if (!base.claims[name]) base.claims[name] = { since: at, lastUsed: at };
    base.log.push({ at, who: name, cmd: 'claim', detail: `认领已有页签（当前 ${records.ownersOf(base).length} 个引用）`, ok: true });
    return base;
  });

  const owners = records.ownersOf(record);
  return {
    targetId,
    refCount: owners.length,
    owners,
    origin: record.origin,
    note: owners.length > 1
      ? '这个页签有多个认领者：释放时只会减你自己的引用'
      : record.origin === 'created'
        ? '你是唯一认领者，释放时若计数归零会真的关闭页签'
        : '这是认领来的页签（不是插件新建的），释放只减引用，永远不关页面',
  };
}

/**
 * Release one claim; close the tab only if it was ours and the count hits zero.
 * @param {{cdpBase:string, tabsDir:string, name:string, archive?:boolean}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function releaseTab({ cdpBase, tabsDir, name }) {
  const pages = await cdp.listPages(cdpBase);
  const record = records.claimByName(tabsDir, name, pages);
  if (!record) throw new Error(`名字 "${name}" 没有认领任何活着的页签。`);

  let remaining = [];
  records.updateRecord(tabsDir, record.id, (current) => {
    if (!current) return current;
    delete current.claims[name];
    remaining = records.ownersOf(current);
    current.log.push({
      at: new Date().toISOString(),
      who: name,
      cmd: 'close',
      detail: remaining.length ? `释放引用，还剩 ${remaining.length} 个（页签不关）` : '最后一个引用',
      ok: true,
    });
    return current;
  });

  if (remaining.length > 0) {
    return { targetId: record.id, released: name, refCount: remaining.length, stillClaimedBy: remaining, closed: false, note: '页签没有关闭，还有别人认领' };
  }

  if (record.origin === 'created') {
    await cdp.api(cdpBase, `/json/close/${record.id}`).catch(() => null);
    // Archive rather than delete: the operation log of a finished tab is the
    // only record of what an agent did, and losing it silently contradicts
    // everything else here.
    archiveRecord(tabsDir, record.id);
    return { targetId: record.id, released: name, refCount: 0, closed: true, note: '引用归零，页签已关闭；操作流水已归档' };
  }

  // Adopted page: release the claim, never close someone else's tab.
  records.updateRecord(tabsDir, record.id, (current) => {
    if (!current) return current;
    if (records.ownersOf(current).length === 0) current.log.push({
      at: new Date().toISOString(), who: name, cmd: 'close', detail: '认领来的页签：只释放引用，不关页面', ok: true,
    });
    return current;
  });
  return { targetId: record.id, released: name, refCount: 0, closed: false, note: '认领来的页签：只释放引用，页面留着' };
}

/**
 * Move a record into tabs/archive/ instead of deleting it.
 * @param {string} tabsDir
 * @param {string} id
 */
export function archiveRecord(tabsDir, id) {
  const archiveDir = path.join(tabsDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  let dest = path.join(archiveDir, `${id}.json`);
  if (fs.existsSync(dest)) dest = path.join(archiveDir, `${id}.${Date.now()}.json`);
  try { fs.renameSync(path.join(tabsDir, `${id}.json`), dest); } catch { /* nothing to archive */ }
}

/**
 * List live tabs, stale records, and corrupt files.
 *
 * A browser that is not running is not an error here: "what tabs do I have"
 * is exactly the question someone asks before starting one, and the claim
 * records are on disk either way. So a dead endpoint yields the recorded tabs
 * marked stale, plus a `browserRunning: false` flag the caller can report.
 *
 * @param {{cdpBase:string, tabsDir:string}} ctx
 * @returns {Promise<{tabs:Array<Record<string, unknown>>, browserRunning:boolean}>}
 */
export async function listTabs({ cdpBase, tabsDir }) {
  let pages = [];
  let browserRunning = false;
  try {
    pages = await cdp.listPages(cdpBase);
    browserRunning = true;
  } catch {
    // Browser down: report recorded claims, which is still the useful answer.
    pages = [];
  }
  const { byId, corrupt } = records.loadAll(tabsDir);
  const live = new Set(pages.map((p) => p.id));
  const rows = pages.map((page) => {
    const record = byId.get(page.id);
    const log = record?.log ?? [];
    return {
      id: page.id,
      owners: records.ownersOf(record),
      origin: record?.origin ?? null,
      lastBy: log.length ? log[log.length - 1].who : null,
      entries: log.length,
      title: page.title,
      url: page.url,
    };
  });
  for (const record of byId.values()) {
    if (!live.has(record.id)) {
      rows.push({
        id: record.id,
        owners: records.ownersOf(record),
        stale: true,
        title: record.title || '',
        url: record.url || '',
      });
    }
  }
  for (const item of corrupt) rows.push({ file: item.file, corrupt: true, reason: item.reason });
  return { tabs: rows, browserRunning };
}

/**
 * Read the operation log of one tab.
 * @param {{cdpBase:string, tabsDir:string, tab?:string, targetId?:string, limit?:number, all?:boolean}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export function readLog({ tabsDir, tab, targetId, limit = 20, all = false }) {
  let record = null;
  if (targetId) record = records.readRecord(tabsDir, targetId);
  else if (tab) {
    const { byId } = records.loadAll(tabsDir);
    const candidates = [...byId.values()].filter((r) => r.claims && r.claims[tab]);
    record = candidates[0] ?? null;
  }
  if (!record) throw new Error('需要 tab 或 targetId 才能读操作流水。');

  const total = record.log.length;
  const entries = all ? record.log : record.log.slice(-Math.max(1, limit));
  return {
    targetId: record.id,
    url: record.url,
    title: record.title,
    owners: records.ownersOf(record),
    totalEntries: total,
    entries,
    truncated: entries.length < total,
  };
}

/**
 * Archive records whose tab is gone and that nobody claims.
 * @param {{cdpBase:string, tabsDir:string, browserUp:boolean}} options
 * @returns {Promise<{archived:string[], kept:Array<{id:string,why:string}>, corrupt:string[]}>}
 */
export async function prune({ tabsDir, cdpBase, browserUp }) {
  // Ask the caller's endpoint, never a hardcoded one: a plugin configured on
  // another port must not silently decide "no pages are live".
  const pages = browserUp ? await cdp.listPages(cdpBase).catch(() => []) : [];
  const live = new Set(pages.map((p) => p.id));
  const { byId, corrupt } = records.loadAll(tabsDir);
  const archived = [];
  const kept = [];
  for (const record of byId.values()) {
    const owners = records.ownersOf(record);
    if (owners.length > 0) { kept.push({ id: record.id, why: `还有 ${owners.length} 个认领（${owners.join(', ')}）` }); continue; }
    if (live.has(record.id)) { kept.push({ id: record.id, why: '页签还开着' }); continue; }
    archiveRecord(tabsDir, record.id);
    archived.push(record.id);
  }
  return { archived, kept, corrupt: corrupt.map((c) => c.file) };
}
