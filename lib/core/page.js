/**
 * Page-level operations on top of the transport.
 *
 * Every exported action returns a plain JSON value and never prints, so the
 * same functions serve the agent tools, the CLI, and tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cdp from './cdp.js';
import * as records from './records.js';

const trim = (value, max = 90) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Open a session on one target with the two domains every action needs.
 * @param {{id:string, webSocketDebuggerUrl:string}} page
 * @param {number} timeoutMs
 * @param {(session:cdp.Session)=>Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withSession(page, timeoutMs, fn) {
  const session = await cdp.Session.open(page.webSocketDebuggerUrl, timeoutMs);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    return await fn(session);
  } finally {
    session.close();
  }
}

/**
 * Flatten a frame tree.
 * @param {any} node
 * @param {Array<{id:string,url:string,name:string}>} [out]
 * @returns {Array<{id:string,url:string,name:string}>}
 */
export function flattenFrames(node, out = []) {
  if (!node || !node.frame) return out;
  out.push({ id: node.frame.id, url: node.frame.url || node.frame.urlFragment || '', name: node.frame.name || '' });
  for (const child of node.childFrames || []) flattenFrames(child, out);
  return out;
}

/**
 * List frames.
 * @param {cdp.Session} session
 * @returns {Promise<Array<{id:string,url:string,name:string}>>}
 */
export async function listFrames(session) {
  return flattenFrames((await session.send('Page.getFrameTree')).frameTree);
}

/**
 * Resolve one frame and create an isolated world for it.
 * @param {cdp.Session} session
 * @param {string} needle
 * @returns {Promise<{ctxId:number, frame:{id:string,url:string,name:string}}>}
 */
export async function frameContext(session, needle) {
  const frames = await listFrames(session);
  const matches = frames.filter((f) => f.url.includes(needle) || f.name.includes(needle));
  if (matches.length === 0) {
    throw new Error(`没有匹配 "${needle}" 的 frame。现有：\n` + frames.map((f) => `  ${f.id}  ${f.url.slice(0, 120)}`).join('\n'));
  }
  if (matches.length > 1) {
    throw new Error(`"${needle}" 匹配到 ${matches.length} 个 frame，请给更长的片段：\n` + matches.map((f) => `  ${f.id}  ${f.url.slice(0, 120)}`).join('\n'));
  }
  const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: matches[0].id, worldName: '__dsh' });
  return { ctxId: executionContextId, frame: matches[0] };
}

/**
 * Navigate and wait for readiness.
 * @param {cdp.Session} session
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{url:string,title:string,readyMs:number|string}>}
 */
export async function navigate(session, url, timeoutMs) {
  const result = await session.send('Page.navigate', { url });
  const readyMs = await cdp.waitReady(session, timeoutMs);
  const info = await cdp.evaluate(session, '({title: document.title, url: location.href})').catch(() => ({}));
  return { ...info, readyMs: readyMs < 0 ? 'TIMEOUT' : readyMs, frameId: result?.frameId };
}

/**
 * Read body text, optionally inside one frame.
 * @param {cdp.Session} session
 * @param {string} [frame]
 * @returns {Promise<string>}
 */
export async function text(session, frame) {
  const ctxId = frame ? (await frameContext(session, frame)).ctxId : undefined;
  const value = await cdp.evaluate(session, 'document.body ? document.body.innerText : ""', ctxId);
  return String(value ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Read full HTML, optionally inside one frame.
 * @param {cdp.Session} session
 * @param {string} [frame]
 * @returns {Promise<string>}
 */
export async function html(session, frame) {
  const ctxId = frame ? (await frameContext(session, frame)).ctxId : undefined;
  return cdp.evaluate(session, 'document.documentElement.outerHTML', ctxId);
}

/**
 * Evaluate an expression, optionally inside one frame.
 * @param {cdp.Session} session
 * @param {string} expression
 * @param {string} [frame]
 * @returns {Promise<any>}
 */
export async function evaluateIn(session, expression, frame) {
  const ctxId = frame ? (await frameContext(session, frame)).ctxId : undefined;
  return cdp.evaluate(session, expression, ctxId);
}

/**
 * Real mouse click (DOM click() is ignored by most SPAs and courseware).
 *
 * `--text` matching prefers genuinely clickable elements and only then falls
 * back to leaf text nodes, so a wrapper div cannot swallow the click.
 * @param {cdp.Session} session
 * @param {{selector?:string, text?:string}} target
 * @returns {Promise<{x:number,y:number,tag:string,text:string,label:string}>}
 */
export async function click(session, target) {
  const finder = target.selector
    ? `document.querySelector(${JSON.stringify(target.selector)})`
    : `(() => {
        const want = ${JSON.stringify(String(target.text))};
        const norm = (e) => (e.innerText || e.value || '').trim();
        const pool = [...document.querySelectorAll('button,input[type=submit],input[type=button],a,[role=button]')];
        return pool.find((e) => norm(e) === want)
          || pool.find((e) => norm(e).includes(want))
          || [...document.querySelectorAll('span,div,li,label,td')].filter((e) => e.children.length === 0).find((e) => norm(e) === want)
          || null;
      })()`;
  const label = target.selector || `按钮 "${target.text}"`;
  const box = await cdp.evaluate(session, `(() => {
    const el = ${finder};
    if (!el) return { ok: false, why: 'not found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return { ok: false, why: 'zero size (display:none?)' };
    return { ok: true, x: b.left + b.width / 2, y: b.top + b.height / 2, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 60) };
  })()`);
  if (!box || !box.ok) throw new Error(`点不到 ${label}：${(box && box.why) || '页面没有返回元素信息'}`);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return { x: Math.round(box.x), y: Math.round(box.y), tag: box.tag, text: box.text, label };
}

/**
 * Fill a field through the native value setter, then dispatch input+change.
 *
 * Assigning `el.value` directly bypasses React/Vue's value tracker, so the
 * framework never sees the edit and submits an empty field.
 * @param {cdp.Session} session
 * @param {string} selector
 * @param {string} value
 * @returns {Promise<{tag:string,value:string}>}
 */
export async function fill(session, selector, value) {
  const result = await cdp.evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, why: 'not found' };
    el.focus();
    const v = ${JSON.stringify(value)};
    if (el.isContentEditable) {
      el.textContent = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else if (el instanceof HTMLSelectElement) {
      const match = [...el.options].find((o) => o.value === v || o.text.trim() === v);
      if (!match) return { ok: false, why: 'no option matching ' + v };
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc || !desc.set) return { ok: false, why: 'no native value setter on ' + el.tagName };
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, tag: el.tagName, value: String(el.value ?? el.textContent).slice(0, 80) };
  })()`);
  if (!result.ok) throw new Error(`填不了 ${selector}：${result.why}`);
  return result;
}

/**
 * Poll for an element or a text fragment.
 * @param {cdp.Session} session
 * @param {{selector?:string, text?:string, timeoutMs:number}} options
 * @returns {Promise<{found:boolean, ms:number}>}
 */
export async function wait(session, { selector, text: needle, timeoutMs }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = needle
      ? await cdp.evaluate(session, `(document.body ? document.body.innerText : '').includes(${JSON.stringify(needle)})`).catch(() => false)
      : await cdp.evaluate(session, `!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
    if (hit) return { found: true, ms: Date.now() - started };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { found: false, ms: Date.now() - started };
}

/**
 * Capture a PNG.
 * @param {cdp.Session} session
 * @param {string} file - absolute path
 * @returns {Promise<{file:string,bytes:number,w:number|null,h:number|null}>}
 */
export async function screenshot(session, file) {
  await cdp.waitFrames(session);
  const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const buffer = Buffer.from(shot.data, 'base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  const size = pngSize(buffer);
  return { file, bytes: buffer.length, w: size?.w ?? null, h: size?.h ?? null };
}

/**
 * Read pixel dimensions from a PNG header.
 * @param {Buffer} buffer
 * @returns {{w:number,h:number}|null}
 */
function pngSize(buffer) {
  if (buffer.length < 24) return null;
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

/**
 * Current page identity plus claim owners.
 * @param {cdp.Session} session
 * @param {string} targetId
 * @param {string} tabsDir
 * @returns {Promise<Record<string, unknown>>}
 */
export async function whoami(session, targetId, tabsDir) {
  const info = await cdp.evaluate(session, '({title: document.title, url: location.href, readyState: document.readyState})');
  const record = records.readRecord(tabsDir, targetId);
  const owners = records.ownersOf(record);
  return { targetId, ...info, owners, shared: owners.length > 1, origin: record?.origin ?? 'adopted' };
}

export { trim };
