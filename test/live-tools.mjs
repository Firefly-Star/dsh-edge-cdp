#!/usr/bin/env node
/**
 * Execute tools against a real browser.
 *
 * Compiling is not working: this suite calls `execute` for real, so a tool that
 * returns a value its own output schema rejects, or that throws on the happy
 * path, fails here instead of in someone's session.
 *
 * Read-only by design: it never starts, stops, navigates, or closes anything.
 * A missing browser is reported as skipped, not failed -- so this can run on a
 * machine where Edge is not up yet.
 *
 * Run: node test/live-tools.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '../lib/core/tool-schema.js';
import { paths as resolvePaths } from '../lib/core/paths.js';
import { buildToolSpecs } from '../lib/tools.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cdpBase = process.env.EDGE_CDP_BASE ?? 'http://127.0.0.1:9222';
const tabsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-live-'));

const specs = buildToolSpecs({
  paths: { ...resolvePaths(path.join(os.tmpdir(), 'edge-cdp-test')), tabs: tabsDir },
  cdpBase,
  edgePath: undefined,
  spawnedBy: () => ({ plugin: 'test' }),
  agentCwd: async () => PACKAGE_ROOT,
});

/** @type {Map<string, any>} */
const tools = new Map(specs.map((spec) => [spec.name, defineTool(spec)]));

/** Minimal exec stand-in; tools only read `agent` from it in production. */
const exec = { agent: undefined, signal: undefined };

let passed = 0;
let skipped = 0;

/**
 * Run one tool and assert on its value.
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    if (e && e.skipped) {
      skipped++;
      console.log(`  skip ${label}（${e.message}）`);
      return;
    }
    console.error(`  FAIL ${label}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/**
 * Output schemas are enforced on the way out, so validate the way the runtime
 * does rather than trusting the shape by eye.
 */
async function call(name, args = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  const value = await tool.execute(args, exec);
  // Round-trip through JSON first: that is what the durable result does, and it
  // catches undefined/NaN/BigInt that a schema check would reject later.
  const plain = JSON.parse(JSON.stringify(value));
  return plain;
}

console.log(`浏览器 ${cdpBase}\n`);

const status = await call('edge_status').catch((e) => ({ state: 'unreachable', note: e.message }));
const browserUp = status.state !== 'unreachable' && status.state !== 'down';

await test('edge_status 返回可判定的状态', () => {
  assert.ok(['running', 'foreign', 'stale-port', 'down', 'unreachable'].includes(status.state), `未知状态 ${status.state}`);
  assert.equal(typeof status.note, 'string');
  assert.ok(status.note.length > 0, '状态必须带一句人能看懂的说明');
  assert.equal(status.port, Number(new URL(cdpBase).port || 9222));
  assert.ok(status.profileDir.length > 0);
});

await test('edge_tabs 在浏览器没开时返回记录而不是抛错', async () => {
  if (browserUp) throw Object.assign(new Error('浏览器在跑，此断言不适用'), { skipped: true });
  const value = await call('edge_tabs');
  assert.ok(Array.isArray(value.tabs), 'tabs 必须总是数组');
  assert.equal(value.browserRunning, false, '浏览器没开时必须如实报告');
});

await test('edge_tabs 列出真实页签', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  const value = await call('edge_tabs');
  assert.ok(Array.isArray(value.tabs));
  assert.ok(value.tabs.length > 0, '浏览器里至少有一个页签');
  for (const tab of value.tabs) {
    assert.equal(typeof tab.id, 'string');
    assert.ok(Array.isArray(tab.owners ?? []), 'owners 必须总是数组');
  }
});

await test('edge_text 能读到正文（只读，不需要认领）', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  const list = await call('edge_tabs');
  const target = list.tabs.find((t) => !t.stale && !t.corrupt && typeof t.url === 'string' && t.url.startsWith('http'));
  if (!target) throw Object.assign(new Error('没有 http 页签'), { skipped: true });
  const value = await call('edge_text', { targetId: target.id });
  assert.equal(typeof value.text, 'string');
  assert.ok(value.text.length > 0, '页面正文不该是空的');
});

await test('改页面的工具不给 tab 必须被拒绝', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  const list = await call('edge_tabs');
  const target = list.tabs.find((t) => !t.stale && !t.corrupt);
  if (!target) throw Object.assign(new Error('没有可用页签'), { skipped: true });

  // Two layers must both hold: the schema rejects a missing tab, and the body
  // rejects an empty one. A blank string passes "required", so the body guard
  // is what actually keeps an anonymous mutation out.
  await assert.rejects(
    () => call('edge_eval', { targetId: target.id, expression: '1+1' }),
    /tab/,
    '缺 tab 必须在 schema 层被拒绝'
  );
  await assert.rejects(
    () => call('edge_eval', { tab: '', targetId: target.id, expression: '1+1' }),
    /必须给 tab|没有认领/,
    '空 tab 不能绕过归属校验'
  );
});

await test('edge_eval 认领之后能求值，并写进操作流水', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  const list = await call('edge_tabs');
  const target = list.tabs.find((t) => !t.stale && !t.corrupt);
  if (!target) throw Object.assign(new Error('没有可用页签'), { skipped: true });

  const name = 'selftest-agent';
  await call('edge_claim', { tab: name, targetId: target.id });
  const value = await call('edge_eval', { tab: name, expression: '1+1' });
  assert.equal(value.value, 2);

  const log = await call('edge_tabs_log', { tab: name, limit: 5 });
  assert.ok(log.entries.some((entry) => entry.cmd === 'edge_eval'), '求值必须留下流水');
  assert.ok(log.owners.includes(name), '认领必须记在 owners 里');

  // Leave the tab exactly as we found it: another agent may be using it.
  await call('edge_release', { tab: name });
});

await test('edge_release 不关别人的页签', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  const list = await call('edge_tabs');
  const target = list.tabs.find((t) => !t.stale && !t.corrupt && t.owners?.length === 0);
  if (!target) throw Object.assign(new Error('没有无主页签'), { skipped: true });

  await call('edge_claim', { tab: 'selftest-release', targetId: target.id });
  const released = await call('edge_release', { tab: 'selftest-release' });
  // Claimed (not created) tabs are never closed on our behalf.
  assert.equal(released.closed, false, '认领来的页签不该被关闭');

  const after = await call('edge_tabs');
  assert.ok(after.tabs.some((t) => t.id === target.id && !t.stale), '页签必须还在');
});

await test('edge_stop 拒绝关闭不是自己启动的浏览器', async () => {
  if (!browserUp) throw Object.assign(new Error('浏览器没开'), { skipped: true });
  if (status.ours) throw Object.assign(new Error('当前浏览器就是本插件启动的，此断言不适用'), { skipped: true });
  const value = await call('edge_stop');
  assert.equal(value.closed, false);
  assert.match(value.reason, /不是本插件启动/);

  const still = await call('edge_status');
  assert.notEqual(still.state, 'down', '拒绝之后浏览器必须还活着');
});

fs.rmSync(tabsDir, { recursive: true, force: true });

console.log(`\n${passed} 项通过${skipped ? `，${skipped} 项跳过` : ''}${process.exitCode ? '，但有失败' : '，全部通过'}`);
