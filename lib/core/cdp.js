/**
 * Minimal CDP transport: HTTP discovery plus one WebSocket session.
 *
 * Zero dependencies on purpose (Node >= 22 provides a global WebSocket). Every
 * method here is transport-level; page semantics live in page.js.
 */

/** Default DevTools endpoint. Bound to loopback only, always. */
export const DEFAULT_CDP_BASE = 'http://127.0.0.1:9222';

/**
 * Human-readable error for a failed HTTP call, translating the two failure
 * shapes that actually happen into the one action that fixes each.
 * @param {string} base
 * @param {string} detail
 * @returns {Error}
 */
function connectError(base, detail) {
  return new Error(
    `连不上 ${base}——浏览器没在运行。用 edge_start 工具启动（它会打开一个有窗口的 Edge），或让用户双击插件目录下的 start-edge.cmd。\n原始错误：${detail}`
  );
}

/**
 * JSON call against the DevTools HTTP endpoints.
 * @param {string} base - e.g. http://127.0.0.1:9222
 * @param {string} route - e.g. /json/version
 * @param {string} [method] - GET or PUT (Chromium 111+ requires PUT for /json/new)
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export async function api(base, route, method = 'GET', timeoutMs = 8000) {
  const url = base.replace(/\/+$/, '') + route;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${route}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${base} ${timeoutMs} 毫秒无响应：端口被一个死掉的进程占着（陈旧端口）。先运行 edge_stop，再 edge_start。`);
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(String(e.message) + String(e.cause?.code ?? ''))) {
      throw connectError(base, e.cause?.code ?? e.message);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Browser identity, or null when nothing answers.
 * @param {string} base
 * @param {number} [timeoutMs]
 * @returns {Promise<{Browser:string, webSocketDebuggerUrl:string}|null>}
 */
export async function version(base, timeoutMs = 3000) {
  try { return await api(base, '/json/version', 'GET', timeoutMs); }
  catch { return null; }
}

/**
 * Page targets only, DevTools pages excluded.
 * @param {string} base
 * @returns {Promise<Array<{id:string,title:string,url:string,webSocketDebuggerUrl:string}>>}
 */
export async function listPages(base) {
  const list = await api(base, '/json/list');
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
}

/**
 * One WebSocket protocol session against a target.
 */
export class Session {
  /**
   * @param {WebSocket} ws
   * @param {number} timeoutMs
   */
  constructor(ws, timeoutMs) {
    this.ws = ws;
    this.id = 0;
    /** @type {Map<number, (msg:any)=>void>} */
    this.pending = new Map();
    /** @type {Array<{method:string, resolve:(params:any)=>void}>} */
    this.waiters = [];
    this.timeoutMs = timeoutMs;
  }

  /**
   * Open and await the handshake.
   * @param {string} wsUrl
   * @param {number} timeoutMs
   * @returns {Promise<Session>}
   */
  static async open(wsUrl, timeoutMs = 30000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 打开超时（10 秒）：目标页签可能刚被关闭')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`WebSocket 打不开：${wsUrl}`)); };
    });
    const session = new Session(ws, timeoutMs);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && session.pending.has(msg.id)) {
        session.pending.get(msg.id)(msg);
        session.pending.delete(msg.id);
        return;
      }
      if (!msg.method) return;
      const index = session.waiters.findIndex((w) => w.method === msg.method);
      if (index >= 0) {
        const waiter = session.waiters.splice(index, 1)[0];
        waiter.resolve(msg.params);
      }
    };
    return session;
  }

  /**
   * Send one protocol command.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** Close the socket without throwing. */
  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Evaluate an expression in a page (or one execution context).
 * @param {Session} session
 * @param {string} expression
 * @param {number} [contextId]
 * @returns {Promise<any>}
 */
export async function evaluate(session, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId) params.contextId = contextId;
  const result = await session.send('Runtime.evaluate', params);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(`页面内异常：${detail.exception?.description || detail.text || '未知'}`);
  }
  return result.result ? result.result.value : undefined;
}

/**
 * Poll document.readyState instead of Page.loadEventFired: the event can fire
 * before the listener is attached, which hangs forever on fast pages.
 * @param {Session} session
 * @param {number} limitMs
 * @returns {Promise<number>} elapsed ms, or -1 on timeout
 */
export async function waitReady(session, limitMs) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    try {
      const state = await evaluate(session, 'document.readyState');
      if (state === 'complete') return Date.now() - started;
    } catch { /* context swapping mid-navigation */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
}

/**
 * Wait for one animation frame (bounded): a hidden tab never produces frames,
 * so an unbounded rAF wait would hang until the command timeout.
 * @param {Session} session
 * @returns {Promise<string>}
 */
export async function waitFrames(session) {
  try {
    return await evaluate(session, `new Promise((r) => {
      if (document.visibilityState === 'hidden') return r('hidden');
      let n = 0;
      const tick = () => { if (++n >= 2) return r('ok'); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setTimeout(() => r('timeout'), 1500);
    })`);
  } catch {
    return 'error';
  }
}
