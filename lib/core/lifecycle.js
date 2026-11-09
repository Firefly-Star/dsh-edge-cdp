/**
 * Browser lifecycle: reuse, start, stop, and the verdict "is it ours, is it
 * alive, who started it".
 *
 * The one rule that keeps this honest: the owner record is trusted only while
 * the live DevTools endpoint reports the same browser UUID. A pid alone can be
 * recycled; a port alone can belong to someone else's browser. The UUID pair
 * (recorded, observed) is proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cdp from './cdp.js';
import { readOwner, writeOwner, clearOwner, pidAlive } from './owner.js';
import { findEdge, launchEdge } from './launcher.js';
import { ensureDirs } from './paths.js';

/** @typedef {import('./owner.js').OwnerRecord} OwnerRecord */

/**
 * Describe the browser right now, without changing anything.
 * @param {{paths:ReturnType<typeof import('./paths.js').paths>, cdpBase:string}} ctx
 * @returns {Promise<{state:'running'|'stale-port'|'down'|'foreign', version:any, owner:OwnerRecord|null, ours:boolean, pidAlive:boolean|null, note:string}>}
 */
export async function status({ paths, cdpBase }) {
  const owner = readOwner(paths.ownerFile);
  const version = await cdp.version(cdpBase, 2500);

  if (version) {
    const ours = Boolean(owner && version.webSocketDebuggerUrl && version.webSocketDebuggerUrl.endsWith(owner.uuid));
    const alive = owner ? pidAlive(owner.pid) : null;
    return {
      state: ours ? 'running' : 'foreign',
      version,
      owner,
      ours,
      pidAlive: alive,
      note: ours
        ? '这是本插件启动的浏览器，可直接复用'
        : (owner
            ? '端口上有一台浏览器，但 UUID 和登记的不一致：它是别人启动的（或插件重启过浏览器的 profile 副本），不复用也不关闭'
            : '端口上有一台浏览器，但没有登记记录：可能是用户手动启动的，可以直接用，但 edge_stop 不会替你关它'),
    };
  }

  // Nothing answers. Distinguish "dead and gone" from "something holds the port
  // and cannot speak CDP" -- the second is the classic half-dead launch.
  const freed = await portIsFree(cdpBase);
  if (!freed) {
    return {
      state: 'stale-port',
      version: null,
      owner,
      ours: false,
      pidAlive: owner ? pidAlive(owner.pid) : null,
      note: '端口在监听但 CDP 不回包：这是启动到一半就死掉的残留，先 edge_stop 再 edge_start',
    };
  }
  return {
    state: 'down',
    version: null,
    owner,
    ours: false,
    pidAlive: owner ? pidAlive(owner.pid) : null,
    note: owner ? '浏览器已退出，但登记记录还在（用户关了窗口，或上次异常结束）' : '浏览器没有运行',
  };
}

/**
 * Whether nothing is listening on the CDP port.
 * @param {string} cdpBase
 * @returns {Promise<boolean>}
 */
async function portIsFree(cdpBase) {
  try {
    const url = new URL(cdpBase);
    const port = Number(url.port || 80);
    const probe = await fetch(`http://${url.hostname}:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    }).catch((e) => e);
    // A rejected fetch means nothing is listening.
    return probe instanceof Error;
  } catch {
    return true;
  }
}

/**
 * Reuse a live browser or start a headed one.
 *
 * Reuse-first is deliberate: with a resident browser, "start" must never mean
 * "open another window", or the user's desktop fills with Edge instances.
 *
 * @param {{paths:ReturnType<typeof import('./paths.js').paths>, cdpBase:string, edgePath?:string, startUrl?:string, spawnedBy:Record<string,unknown>}} options
 * @returns {Promise<{reused:boolean, owner:OwnerRecord, pid:number|null, note:string}>}
 */
export async function ensureBrowser(options) {
  const { paths, cdpBase, edgePath, startUrl, spawnedBy } = options;
  ensureDirs(paths);

  const current = await cdp.version(cdpBase, 2500);
  if (current) {
    const recorded = readOwner(paths.ownerFile);
    const uuid = browserUuid(current.webSocketDebuggerUrl);
    const ours = Boolean(recorded && recorded.uuid === uuid);
    const owner = {
      pid: ours ? recorded.pid : null,
      port: Number(new URL(cdpBase).port || 9222),
      uuid,
      wsUrl: current.webSocketDebuggerUrl ?? '',
      startedAt: ours ? recorded.startedAt : new Date().toISOString(),
      headed: true,
      profileDir: paths.profile,
      spawnedBy: ours ? recorded.spawnedBy : { note: 'adopted: 不是本插件启动的，无法证明归属' },
      logFile: ours ? recorded.logFile ?? null : null,
    };
    if (ours) writeOwner(paths.ownerFile, owner);
    return {
      reused: true,
      owner,
      pid: owner.pid,
      note: ours
        ? '浏览器已在运行，直接复用（没有新开窗口）'
        : '复用了端口上已有的浏览器，但它不是本插件启动的：不会替它关窗口',
    };
  }

  // Nothing answers. Refuse to start onto a port something else is holding.
  const free = await portIsFree(cdpBase);
  if (!free) {
    throw new Error('端口在监听但 CDP 不回包（陈旧端口）。先运行 edge_stop 清掉它，再 edge_start。');
  }

  const exe = findEdge(edgePath);
  if (!exe) throw new Error('找不到 msedge.exe。请在插件配置里设置 edgePath。');

  fs.mkdirSync(paths.profile, { recursive: true });
  const logFile = path.join(paths.logs, `edge-${Date.now()}.log`);

  const launched = launchEdge({
    edgePath: exe,
    port: Number(new URL(cdpBase).port || 9222),
    profileDir: paths.profile,
    logFile,
    startUrl,
  });

  const version = await waitForBrowser(cdpBase, 30000, launched.pid);
  if (!version) {
    const logTail = tailLog(logFile);
    throw new Error(
      'Edge 启动了但 30 秒内没有响应 CDP。' +
      (logTail ? `\n最近的浏览器日志：\n${logTail}` : '') +
      '\n若日志里出现 platform_channel / Access denied (0x5)，说明它被受限令牌启动了：必须由插件（而不是 agent 的 pwsh 工具）来启动。'
    );
  }

  const owner = {
    pid: launched.pid,
    port: Number(new URL(cdpBase).port || 9222),
    uuid: browserUuid(version.webSocketDebuggerUrl),
    wsUrl: version.webSocketDebuggerUrl ?? '',
    startedAt: new Date().toISOString(),
    headed: true,
    profileDir: paths.profile,
    spawnedBy,
    logFile,
  };
  writeOwner(paths.ownerFile, owner);
  return { reused: false, owner, pid: launched.pid, note: '已启动一个有窗口的 Edge，并登记了归属' };
}

/**
 * Poll /json/version until the browser answers or the deadline passes.
 * @param {string} cdpBase
 * @param {number} timeoutMs
 * @param {number|null} pid
 * @returns {Promise<any|null>}
 */
async function waitForBrowser(cdpBase, timeoutMs, pid) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const version = await cdp.version(cdpBase, 2000);
    if (version) return version;
    if (pid && !pidAlive(pid)) return null;
  }
  return null;
}

/**
 * Extract the browser UUID from a DevTools websocket URL.
 * @param {string} wsUrl
 * @returns {string}
 */
export function browserUuid(wsUrl) {
  return String(wsUrl || '').split('/').pop() ?? '';
}

/**
 * Last lines of a browser log, for a failure message.
 * @param {string} logFile
 * @returns {string}
 */
function tailLog(logFile) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.split('\n').slice(-12).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Stop the browser this plugin started.
 *
 * Refuses to touch a browser it cannot prove it owns: closing someone else's
 * browser (including the user's everyday Edge) is far worse than a stale one.
 *
 * @param {{paths:ReturnType<typeof import('./paths.js').paths>, cdpBase:string, force?:boolean}} options
 * @returns {Promise<{closed:boolean, reason:string, pid:number|null}>}
 */
export async function stopBrowser({ paths, cdpBase }) {
  const owner = readOwner(paths.ownerFile);
  const version = await cdp.version(cdpBase, 2000);

  if (!version) {
    clearOwner(paths.ownerFile);
    return { closed: false, reason: '浏览器本来就没在运行；已清理过期登记', pid: null };
  }

  const liveUuid = browserUuid(version.webSocketDebuggerUrl);
  if (!owner || owner.uuid !== liveUuid) {
    return {
      closed: false,
      reason: '端口上的浏览器不是本插件启动的（UUID 不匹配）。不替你关别人或你自己的日常浏览器。',
      pid: null,
    };
  }

  if (!owner.pid || !pidAlive(owner.pid)) {
    clearOwner(paths.ownerFile);
    return { closed: false, reason: '登记的主进程已不存在，但端口还有响应：请手动关闭那个 Edge 窗口', pid: owner.pid };
  }

  try { process.kill(owner.pid); } catch { /* fall through to the report below */ }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await cdp.version(cdpBase, 1000))) {
      clearOwner(paths.ownerFile);
      return { closed: true, reason: '已关闭本插件启动的浏览器，端口已释放', pid: owner.pid };
    }
  }

  return {
    closed: false,
    reason: `已向 pid ${owner.pid} 发送关闭信号，但端口 10 秒后仍在响应。可能还有子进程持有监听，请手动确认。`,
    pid: owner.pid,
  };
}
