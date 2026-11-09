#!/usr/bin/env node
/**
 * Optional CLI over the same core the tools use.
 *
 * Why keep a CLI at all: a person debugging by hand wants `node cdp.mjs tabs`
 * without going through an agent turn, and platforms that cannot load a plugin
 * (a plain PowerShell session in this workspace) still get read access.
 *
 * It is deliberately thin -- every command delegates to lib/core and prints the
 * JSON value it returns. Exit codes: 0 ok, 1 error, 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as lifecycle from '../lib/core/lifecycle.js';
import * as page from '../lib/core/page.js';
import * as tabRecords from '../lib/core/records.js';
import * as tabs from '../lib/core/tabs.js';
import { paths as resolvePaths } from '../lib/core/paths.js';

// Data root comes from lib/core/paths.js: <DSH_HOME>/edge-cdp, overridable by
// EDGE_CDP_ROOT. It is deliberately NOT inside the package -- a git-installed
// package gets replaced on upgrade, and the browser profile lives there.
const layout = resolvePaths(process.env.EDGE_CDP_ROOT);
const cdpBase = process.env.EDGE_CDP_BASE || 'http://127.0.0.1:9222';

const USAGE = `用法：node bin/cdp.mjs <命令> [参数...] [--tab 名字 | --target ID] [--frame 片段] [--timeout 毫秒]

  status                                 浏览器状态（谁起的、在不在、端口、profile）
  start [url]                            启动有窗口的 Edge；已在跑则复用
  stop                                   只关闭本插件启动的浏览器
  tabs                                   列出页签、认领者、失效与损坏记录
  newtab --tab <名字> [url]              新建页签并认领
  claim --tab <名字> --target <id>       认领已有页签
  release --tab <名字>                   释放自己那份引用
  log (--tab <名字>|--target <id>) [--limit N|--all]
                                         看操作流水
  whoami                                 当前页签身份与认领者
  nav <url>                              导航并等就绪
  text | html | eval <表达式> [--file f] 读正文 / 整页 HTML / 求值
  frames                                 列出 iframe
  click <css> | click --text "文字"      真实鼠标点击
  fill <css> <文本>                      填值
  wait <css> | wait --text "..." [--timeout ms]
                                         等元素或文字；未命中退出码 3
  shot [文件]                            截图（相对路径按当前目录解析）
  prune                                  归档"页签已消失且无人认领"的记录

退出码：0 成功，1 出错，2 用法错，3 wait 未命中。
`;

/**
 * Parse argv into flags and positionals.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--') && arg.length > 2) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith('--') && next.length > 2)) { opts[key] = next; i++; }
      else opts[key] = true;
    } else opts._.push(arg);
  }
  return opts;
}

const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const opts = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = opts._;
const timeoutMs = num(opts.timeout, 30000);

/** Resolve the caller's page context. */
const context = () => ({ cdpBase, tabsDir: layout.tabs, tab: opts.tab, targetId: opts.target });

/** Run one page action under the same claim/record discipline as the tools. */
async function onPage(cmdName, detail, fn) {
  const { page: target } = await tabs.resolvePage(context());
  const who = typeof opts.tab === 'string' ? opts.tab : '-';
  // Same rule the tools enforce: a command that changes the page must name the
  // owner, otherwise the change is unattributable in a shared browser.
  if (!who || who === '-' ) {
    if (tabRecords.MUTATING.has(cmdName)) {
      throw new Error(
        `改页面的命令（${cmdName}）必须带 --tab <名字>，否则这次改动没有责任人。\n` +
        `先认领：node bin/cdp.mjs claim --tab 我的名字 --target ${target.id}`
      );
    }
  }
  try {
    const value = await page.withSession(target, timeoutMs, fn);
    tabRecords.note(layout.tabs, target.id, who, cmdName, detail, true);
    return { targetId: target.id, value };
  } catch (e) {
    tabRecords.note(layout.tabs, target.id, who, cmdName, detail, false, e.message);
    throw e;
  }
}

try {
  if (!cmd) { console.error(USAGE); process.exit(2); }

  if (cmd === 'status') {
    out(await lifecycle.status({ paths: layout, cdpBase }));
  } else if (cmd === 'start') {
    const result = await lifecycle.ensureBrowser({
      paths: layout, cdpBase, startUrl: rest[0], spawnedBy: { plugin: 'cli', cli: true, at: new Date().toISOString() },
    });
    out(result);
  } else if (cmd === 'stop') {
    out(await lifecycle.stopBrowser({ paths: layout, cdpBase }));
  } else if (cmd === 'tabs') {
    out(await tabs.listTabs({ cdpBase, tabsDir: layout.tabs }));
  } else if (cmd === 'newtab') {
    const name = (typeof opts.tab === 'string' && opts.tab) || rest[0];
    if (!name) throw new Error('newtab 需要名字：node bin/cdp.mjs newtab --tab <名字> [url]');
    const url = rest[0] === name ? rest[1] : rest[0];
    out(await tabs.newTab({ cdpBase, tabsDir: layout.tabs, name, url, timeoutMs }));
  } else if (cmd === 'claim') {
    if (!opts.tab || !opts.target) throw new Error('claim 需要 --tab <名字> 和 --target <id>');
    out(await tabs.claimTab({ cdpBase, tabsDir: layout.tabs, name: String(opts.tab), targetId: String(opts.target) }));
  } else if (cmd === 'release') {
    if (!opts.tab) throw new Error('release 需要 --tab <名字>');
    out(await tabs.releaseTab({ cdpBase, tabsDir: layout.tabs, name: String(opts.tab) }));
  } else if (cmd === 'log') {
    out(tabs.readLog({
      tabsDir: layout.tabs,
      tab: typeof opts.tab === 'string' ? opts.tab : undefined,
      targetId: typeof opts.target === 'string' ? opts.target : undefined,
      limit: num(opts.limit, 20),
      all: opts.all === true,
    }));
  } else if (cmd === 'prune') {
    out(await tabs.prune({ tabsDir: layout.tabs, browserUp: Boolean(lifecycle.status) }));
  } else if (cmd === 'whoami') {
    const result = await onPage('whoami', '', (session) => page.whoami(session, '', layout.tabs));
    out(result.value);
  } else if (cmd === 'nav') {
    if (!rest[0]) throw new Error('nav 需要 url');
    const result = await onPage('nav', String(rest[0]), (session) => page.navigate(session, rest[0], timeoutMs));
    out(result.value);
  } else if (cmd === 'text') {
    const result = await onPage('text', opts.frame ? `frame:${opts.frame}` : '', (session) =>
      page.text(session, typeof opts.frame === 'string' ? opts.frame : undefined));
    out(result.value);
  } else if (cmd === 'html') {
    const result = await onPage('html', opts.frame ? `frame:${opts.frame}` : '', (session) =>
      page.html(session, typeof opts.frame === 'string' ? opts.frame : undefined));
    out(result.value);
  } else if (cmd === 'eval') {
    let expression = rest.join(' ');
    if (opts.file) expression = fs.readFileSync(path.resolve(process.cwd(), String(opts.file)), 'utf8');
    if (!expression) throw new Error('eval 需要表达式，或用 --file <路径>');
    const result = await onPage('eval', String(expression).slice(0, 70), (session) =>
      page.evaluateIn(session, expression, typeof opts.frame === 'string' ? opts.frame : undefined));
    out(result.value);
  } else if (cmd === 'frames') {
    const result = await onPage('frames', '', (session) => page.listFrames(session));
    out(result.value);
  } else if (cmd === 'click') {
    const selector = rest[0];
    const text = typeof opts.text === 'string' ? opts.text : undefined;
    if (!selector && !text) throw new Error('click 需要 css 选择器，或 --text <按钮文字>');
    const label = selector || `text:${text}`;
    const result = await onPage('click', label, (session) => page.click(session, { selector, text }));
    out(result.value);
  } else if (cmd === 'fill') {
    const selector = rest[0];
    const value = rest.slice(1).join(' ');
    if (!selector) throw new Error('fill 需要 css 选择器');
    const result = await onPage('fill', `${selector} <- ${value.slice(0, 40)}`, (session) =>
      page.fill(session, selector, value));
    out(result.value);
  } else if (cmd === 'wait') {
    const selector = rest[0];
    const text = typeof opts.text === 'string' ? opts.text : undefined;
    if (!selector && !text) throw new Error('wait 需要 css 选择器，或 --text <片段>');
    const of = text ? `text:${text}` : selector;
    const result = await onPage('wait', of, (session) =>
      page.wait(session, { selector, text, timeoutMs: num(opts.timeout, 15000) }));
    out({ found: result.value.found, ms: result.value.ms, of });
    if (!result.value.found) process.exitCode = 3;
  } else if (cmd === 'shot') {
    const file = rest[0]
      ? path.resolve(process.cwd(), rest[0])
      : path.resolve(process.cwd(), 'work', 'shots', `edge-${Date.now()}.png`);
    const result = await onPage('shot', file, (session) => page.screenshot(session, file));
    out(result.value);
  } else {
    console.error(`未知命令：${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error('ERROR: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
