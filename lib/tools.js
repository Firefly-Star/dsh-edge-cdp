/**
 * Agent-facing tool specifications.
 *
 * This module returns plain option objects for {@link defineTool}; the plugin
 * entry point is the only place that imports the SDK. Keeping the split means
 * every tool body is testable without a Cordis context.
 *
 * Two rules the bodies obey:
 *  - A tool never prints. It returns the value its `output.schema` promises.
 *  - A tool that changes the page requires `tab` (a named owner), because a
 *    shared browser makes anonymous mutation unattributable.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as cdp from './core/cdp.js';
import * as lifecycle from './core/lifecycle.js';
import * as page from './core/page.js';
import * as records from './core/records.js';
import * as tabs from './core/tabs.js';

/** Tool-level commands that mutate a page and therefore need an owner. */
const MUTATING_TOOLS = new Set(['edge_navigate', 'edge_click', 'edge_fill', 'edge_eval']);

const TAB_PARAM = {
  type: 'string',
  description: '你认领的名字（见 edge_new_tab / edge_claim）。改页面的操作必须给。',
};

const TARGET_PARAM = {
  type: 'string',
  description: '页签的 targetId。只读操作可以只用它，不给 tab。',
};

const FRAME_PARAM = {
  type: 'string',
  description: 'iframe 的 url 或 name 片段，必须唯一。只对读命令（text/html/eval）有效。',
};

const TIMEOUT_PARAM = {
  type: 'integer',
  description: '超时毫秒，默认 30000。',
};

/**
 * Render a tool value for the model: strings stay raw, everything else is JSON.
 * @param {unknown} value
 * @returns {string}
 */
const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** The single content block a tool returns. */
const renderText = (value) => [{ type: 'text', text: asText(value) }];

/**
 * Output object schema; openness is explicit because the DSL demands it.
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
const out = (properties, required = []) => ({
  type: 'object',
  additionalProperties: true,
  properties: Object.fromEntries(
    Object.entries(properties).map(([key, spec]) => [key, required.includes(key) ? { ...spec, required: true } : spec])
  ),
});

/**
 * Build every tool specification for one resolved plugin configuration.
 *
 * @param {{
 *   paths: ReturnType<typeof import('./core/paths.js').paths>,
 *   cdpBase: string,
 *   edgePath?: string,
 *   spawnedBy: () => Record<string, unknown>,
 *   agentCwd: (exec: any) => Promise<string>,
 * }} context
 * @returns {Array<Record<string, unknown>>} defineTool option objects
 */
export function buildToolSpecs(context) {
  const { paths, cdpBase, edgePath } = context;

  /**
   * Resolve a caller-supplied path against the calling agent's workspace.
   * The plugin's own var/ is never a destination for agent output.
   */
  const resolveFile = async (file, exec) => {
    if (path.isAbsolute(file)) return file;
    return path.join(await context.agentCwd(exec), file);
  };

  /**
   * Resolve the target page, enforce ownership for mutations, run one page
   * action, and record it either way.
   */
  const onPage = async (args, cmd, detail, fn) => {
    const { page: target } = await tabs.resolvePage({
      cdpBase, tabsDir: paths.tabs, tab: args.tab, targetId: args.targetId,
    });
    const who = typeof args.tab === 'string' && args.tab.trim() ? args.tab.trim() : '-';
    if (who === '-' && MUTATING_TOOLS.has(cmd)) {
      throw new Error(
        `改页面的命令（${cmd}）必须给 tab，否则这次改动没有责任人。\n` +
        `先认领：edge_claim {tab: "我的名字", targetId: "${target.id}"}`
      );
    }
    try {
      const value = await page.withSession(target, args.timeoutMs ?? 30000, fn);
      records.note(paths.tabs, target.id, who, cmd, detail, true);
      if (cmd === 'edge_navigate' && value?.url) {
        try {
          records.updateRecord(paths.tabs, target.id, (current) => {
            if (!current) return current;
            current.url = value.url;
            if (value.title) current.title = value.title;
            return current;
          });
        } catch { /* keeping the record fresh is best-effort */ }
      }
      return { targetId: target.id, value };
    } catch (e) {
      records.note(paths.tabs, target.id, who, cmd, detail, false, e.message);
      throw e;
    }
  };

  return [
    {
      name: 'edge_status',
      description: '查看那台常驻 Edge 的状态：在不在跑、是不是本插件启动的、谁启动的、端口和 profile 在哪、有没有陈旧端口。启动或关闭之前先调它。',
      parameters: {},
      output: {
        schema: out({
          state: { type: 'string', description: 'running / foreign / stale-port / down' },
          browser: { type: 'string' },
          ours: { type: 'boolean' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          port: { type: 'integer' },
          uuid: { type: 'string' },
          startedAt: { type: 'string' },
          spawnedBy: { type: 'json' },
          profileDir: { type: 'string' },
          edgePath: { type: 'string' },
          note: { type: 'string' },
        }, ['state', 'note']),
        render: (_args, value) => renderText(value),
      },
      async execute() {
        const status = await lifecycle.status({ paths, cdpBase });
        return {
          state: status.state,
          browser: status.version?.Browser ?? '',
          ours: status.ours,
          pid: status.owner?.pid ?? null,
          port: Number(new URL(cdpBase).port || 9222),
          uuid: status.owner?.uuid ?? lifecycle.browserUuid(status.version?.webSocketDebuggerUrl ?? ''),
          startedAt: status.owner?.startedAt ?? '',
          spawnedBy: status.owner?.spawnedBy ?? {},
          profileDir: paths.profile,
          edgePath: edgePath ?? '',
          note: status.note,
        };
      },
    },

    {
      name: 'edge_start',
      description: '启动那台**有窗口**的 Edge；已经在运行就直接复用（不会新开窗口）。它在 DSH 重启和会话结束之后仍然活着，用户可以在窗口里亲手登录、输验证码。',
      parameters: { url: { type: 'string', description: '启动后打开的地址，默认 about:blank。' } },
      output: {
        schema: out({
          reused: { type: 'boolean' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          uuid: { type: 'string' },
          port: { type: 'integer' },
          profileDir: { type: 'string' },
          note: { type: 'string' },
        }, ['reused', 'note']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const result = await lifecycle.ensureBrowser({
          paths, cdpBase, edgePath, startUrl: args.url, spawnedBy: context.spawnedBy(),
        });
        return {
          reused: result.reused,
          pid: result.pid,
          uuid: result.owner.uuid,
          port: result.owner.port,
          profileDir: paths.profile,
          note: result.note,
        };
      },
    },

    {
      name: 'edge_stop',
      description: '关闭**本插件启动的**那台 Edge。不是它启动的（UUID 不匹配）就拒绝，绝不关闭用户自己的日常浏览器。',
      parameters: {},
      output: {
        schema: out({
          closed: { type: 'boolean' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          reason: { type: 'string' },
        }, ['closed', 'reason']),
        render: (_args, value) => renderText(value),
      },
      async execute() {
        return lifecycle.stopBrowser({ paths, cdpBase });
      },
    },

    {
      name: 'edge_tabs',
      description: '列出浏览器里的页签、各自被谁认领、哪些认领记录已失效、哪些记录文件损坏。浏览器没开也能用（browserRunning=false，仍列出记录里的页签）。多页签协作时先看这个。',
      parameters: {},
      output: {
        schema: out({
          tabs: { type: 'array', items: { type: 'json' } },
          browserRunning: { type: 'boolean' },
        }, ['tabs']),
        render: (_args, value) => renderText(value.tabs),
      },
      async execute() {
        return tabs.listTabs({ cdpBase, tabsDir: paths.tabs });
      },
    },

    {
      name: 'edge_new_tab',
      description: '新建一个页签并认领它（tab 就是你的名字）。同一个名字同时只能认领一个活页签。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        url: { type: 'string', description: '要打开的地址，默认 about:blank。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          claimed: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          readyMs: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        }, ['targetId']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        return tabs.newTab({
          cdpBase, tabsDir: paths.tabs, name: args.tab, url: args.url, timeoutMs: args.timeoutMs ?? 30000,
        });
      },
    },

    {
      name: 'edge_claim',
      description: '认领一个**已经存在**的页签（多个 agent 可以同时认领同一个）。动手之前先看 edge_tabs_log 了解别人做过什么。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        targetId: { ...TARGET_PARAM, required: true },
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          refCount: { type: 'integer' },
          owners: { type: 'array', items: { type: 'string' } },
          origin: { type: 'string' },
          note: { type: 'string' },
        }, ['targetId', 'refCount', 'note']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        return tabs.claimTab({ cdpBase, tabsDir: paths.tabs, name: args.tab, targetId: args.targetId });
      },
    },

    {
      name: 'edge_release',
      description: '释放你自己那份认领。还有别人认领就不关页签；计数归零才关，而且只关插件新建的页签（认领来的页面永远不替你关）。操作流水会归档而不是删除。',
      parameters: { tab: { ...TAB_PARAM, required: true } },
      output: {
        schema: out({
          targetId: { type: 'string' },
          released: { type: 'string' },
          refCount: { type: 'integer' },
          closed: { type: 'boolean' },
          stillClaimedBy: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        }, ['released', 'closed', 'note']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        return tabs.releaseTab({ cdpBase, tabsDir: paths.tabs, name: args.tab });
      },
    },

    {
      name: 'edge_tabs_log',
      description: '看某个页签的操作流水：谁、什么时候、做了什么、成没成。接管别人动过的页签前必须先看。',
      parameters: {
        tab: TAB_PARAM,
        targetId: TARGET_PARAM,
        limit: { type: 'integer', description: '返回末尾多少条，默认 20。' },
        all: { type: 'boolean', description: '返回全部。' },
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          owners: { type: 'array', items: { type: 'string' } },
          totalEntries: { type: 'integer' },
          entries: { type: 'array', items: { type: 'json' } },
          truncated: { type: 'boolean' },
        }, ['entries']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        return tabs.readLog({
          tabsDir: paths.tabs,
          tab: args.tab,
          targetId: args.targetId,
          limit: args.limit ?? 20,
          all: args.all ?? false,
        });
      },
    },

    {
      name: 'edge_navigate',
      description: '导航并等到页面就绪（轮询 readyState，不会卡死）。改页面，必须给 tab。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        url: { type: 'string', required: true, description: '目标地址。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          readyMs: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        }, ['targetId']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const result = await onPage(args, 'edge_navigate', String(args.url), (session) =>
          page.navigate(session, args.url, args.timeoutMs ?? 30000));
        return { targetId: result.targetId, ...result.value };
      },
    },

    {
      name: 'edge_text',
      description: '取页面正文（innerText）。内容缺一块多半在 iframe 里，先用 edge_frames 看。',
      parameters: {
        tab: TAB_PARAM, targetId: TARGET_PARAM, frame: FRAME_PARAM, timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({ targetId: { type: 'string' }, text: { type: 'string' } }, ['text']),
        render: (_args, value) => renderText(value.text),
      },
      async execute(args) {
        const result = await onPage(args, 'edge_text', args.frame ? `frame:${args.frame}` : '', (session) =>
          page.text(session, args.frame));
        return { targetId: result.targetId, text: result.value };
      },
    },

    {
      name: 'edge_html',
      description: '取整页 HTML。体积通常是正文的几十倍，优先用 edge_text。',
      parameters: {
        tab: TAB_PARAM, targetId: TARGET_PARAM, frame: FRAME_PARAM, timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({ targetId: { type: 'string' }, html: { type: 'string' } }, ['html']),
        render: (_args, value) => renderText(value.html),
      },
      async execute(args) {
        const result = await onPage(args, 'edge_html', args.frame ? `frame:${args.frame}` : '', (session) =>
          page.html(session, args.frame));
        return { targetId: result.targetId, html: result.value };
      },
    },

    {
      name: 'edge_eval',
      description: '在页面里求值（返回 JSON 化的结果）。参数是 JSON 字符串，不怕引号；长表达式可以用 file 指一个文件。改页面，必须给 tab。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        expression: { type: 'string', description: '单个表达式（IIFE / Promise 都行），不要写 return 语句。' },
        file: { type: 'string', description: '从文件读表达式；相对路径按你当前工作区解析。' },
        frame: FRAME_PARAM,
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({ targetId: { type: 'string' }, value: { type: 'json' } }, ['targetId']),
        render: (_args, value) => renderText(value.value),
      },
      async execute(args, exec) {
        let expression = args.expression;
        if (!expression && args.file) expression = fs.readFileSync(await resolveFile(args.file, exec), 'utf8');
        if (!expression) throw new Error('edge_eval 需要 expression，或用 file 指向一个文件。');
        const result = await onPage(args, 'edge_eval', String(expression).slice(0, 70), (session) =>
          page.evaluateIn(session, expression, args.frame));
        return { targetId: result.targetId, value: result.value ?? null };
      },
    },

    {
      name: 'edge_frames',
      description: '列出页面里所有 iframe。课件、播放器、第三方嵌入基本都在 iframe 里。',
      parameters: { tab: TAB_PARAM, targetId: TARGET_PARAM, timeoutMs: TIMEOUT_PARAM },
      output: {
        schema: out({
          targetId: { type: 'string' },
          frames: { type: 'array', items: { type: 'json' } },
        }, ['frames']),
        render: (_args, value) => renderText(value.frames),
      },
      async execute(args) {
        const result = await onPage(args, 'edge_frames', '', (session) => page.listFrames(session));
        return { targetId: result.targetId, frames: result.value };
      },
    },

    {
      name: 'edge_click',
      description: '真实鼠标点击（不是 el.click()，对单页应用和课件才有效）。用 selector 或 text 二选一；按钮里有图标也点得中。改页面，必须给 tab。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '按钮文字（更稳，中文按钮的 class 常是随机哈希）。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          clicked: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          tag: { type: 'string' },
        }, ['targetId']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        if (!args.selector && !args.text) throw new Error('edge_click 需要 selector 或 text。');
        const detail = args.selector ? String(args.selector) : `text:${args.text}`;
        const result = await onPage(args, 'edge_click', detail, (session) =>
          page.click(session, { selector: args.selector, text: args.text }));
        return {
          targetId: result.targetId,
          clicked: result.value.label,
          x: result.value.x,
          y: result.value.y,
          tag: result.value.tag,
        };
      },
    },

    {
      name: 'edge_fill',
      description: '填输入框 / 文本域 / 下拉框 / contenteditable，走原生 setter 并派发 input+change，React/Vue 才认。改页面，必须给 tab。',
      parameters: {
        tab: { ...TAB_PARAM, required: true },
        selector: { type: 'string', required: true, description: 'CSS 选择器。' },
        value: { type: 'string', required: true, description: '要填入的值（下拉框可按 value 或选项文字匹配）。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          filled: { type: 'string' },
          value: { type: 'string' },
          tag: { type: 'string' },
        }, ['targetId']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const result = await onPage(args, 'edge_fill', `${args.selector} <- ${String(args.value).slice(0, 40)}`, (session) =>
          page.fill(session, args.selector, args.value));
        return {
          targetId: result.targetId,
          filled: args.selector,
          value: result.value.value,
          tag: result.value.tag,
        };
      },
    },

    {
      name: 'edge_wait',
      description: '等元素出现或文字出现。未命中返回 found:false —— 别当成功继续。也可以用它确认用户已经登录完成。',
      parameters: {
        tab: TAB_PARAM,
        targetId: TARGET_PARAM,
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '要等的文字片段。' },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 15000。' },
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          found: { type: 'boolean' },
          ms: { type: 'integer' },
          of: { type: 'string' },
        }, ['found']),
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        if (!args.selector && !args.text) throw new Error('edge_wait 需要 selector 或 text。');
        const of = args.text ? `text:${args.text}` : String(args.selector);
        const result = await onPage(args, 'edge_wait', of, (session) =>
          page.wait(session, { selector: args.selector, text: args.text, timeoutMs: args.timeoutMs ?? 15000 }));
        return { targetId: result.targetId, ...result.value, of };
      },
    },

    {
      name: 'edge_shot',
      description: '截图取证（PNG，长页面整页截）。相对路径按你当前工作区解析，建议写 work/<任务>/shots/x.png。',
      parameters: {
        tab: TAB_PARAM,
        targetId: TARGET_PARAM,
        file: { type: 'string', description: '输出路径；不给就写到当前工作区 work/shots/ 下。' },
        timeoutMs: TIMEOUT_PARAM,
      },
      output: {
        schema: out({
          targetId: { type: 'string' },
          file: { type: 'string' },
          bytes: { type: 'integer' },
          w: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          h: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        }, ['file', 'bytes']),
        render: (_args, value) => renderText(value),
      },
      async execute(args, exec) {
        const file = args.file
          ? await resolveFile(args.file, exec)
          : path.join(await context.agentCwd(exec), 'work', 'shots', `edge-${Date.now()}.png`);
        const result = await onPage(args, 'edge_shot', file, (session) => page.screenshot(session, file));
        return { targetId: result.targetId, ...result.value };
      },
    },

    {
      name: 'edge_prune',
      description: '归档"页签已消失且无人认领"的认领记录到 tabs/archive/（只移动不删除，流水是唯一能证明谁干过什么的证据）。',
      parameters: {},
      output: {
        schema: out({
          archived: { type: 'array', items: { type: 'string' } },
          kept: { type: 'array', items: { type: 'json' } },
          corrupt: { type: 'array', items: { type: 'string' } },
        }, ['archived']),
        render: (_args, value) => renderText(value),
      },
      async execute() {
        const browserUp = Boolean(await cdp.version(cdpBase, 1500));
        return tabs.prune({ tabsDir: paths.tabs, cdpBase, browserUp });
      },
    },
  ];
}

export { MUTATING_TOOLS };
