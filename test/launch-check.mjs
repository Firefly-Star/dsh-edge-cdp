#!/usr/bin/env node
/**
 * Start the migrated profile once, with a real visible window, then stop it.
 *
 * Why this must be run by the user (or by an escalated shell) rather than by an
 * agent: Chromium cannot build its mojo IPC under the DSH sandbox's restricted
 * token, so it dies at platform_channel.cc:187. That is the exact failure this
 * whole plugin exists to avoid, and it means "can this profile launch" can only
 * be answered outside the sandbox.
 *
 * What it proves:
 *   - the copied profile is openable (not half-copied)
 *   - the login state survived (optional: compare a cookie-store size)
 *   - the launch argv the plugin will use actually works
 *   - closing the window really frees the port
 *
 * Run: node test/launch-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, findEdge } from '../lib/core/launcher.js';
import { spawn } from 'node:child_process';
import { paths as resolvePaths } from '../lib/core/paths.js';

// Use the same layout the plugin uses: <DSH_HOME>/edge-cdp, never in-package.
const layout = resolvePaths(process.env.EDGE_CDP_ROOT);
const profileDir = layout.profile;
const logDir = layout.logs;
const port = Number(process.env.EDGE_CDP_PORT ?? 9233);
const base = `http://127.0.0.1:${port}`;

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {() => any} fn
 */
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${label}\n       ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** DevTools version payload, or null. */
async function version() {
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

console.log(`profile: ${profileDir}`);
console.log(`port:    ${port}（故意不用 9222，避免和插件正式实例抢）\n`);

await test('迁移后的 profile 存在且非空', () => {
  assert.ok(fs.existsSync(profileDir), `找不到 ${profileDir}`);
  const localState = path.join(profileDir, 'Local State');
  assert.ok(fs.existsSync(localState), '缺少 Local State：profile 可能没复制完整');
  const prefs = path.join(profileDir, 'Default', 'Preferences');
  assert.ok(fs.existsSync(prefs), '缺少 Default/Preferences');
});

await test('端口当前是空闲的', async () => {
  assert.equal(await version(), null, `端口 ${port} 已被占用，换个 EDGE_CDP_PORT 再测`);
});

const edge = findEdge();
console.log(`\n启动器: ${edge ?? '未找到'}\n`);

if (!edge) {
  console.error('找不到 msedge.exe，无法继续');
  process.exitCode = 1;
} else {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `launch-check-${Date.now()}.log`);
  const args = buildArgs({ port, profileDir, logFile, startUrl: 'about:blank' });
  console.log(`argv: ${args.join(' ')}\n`);

  const child = spawn(edge, args, { detached: true, windowsHide: false, stdio: 'ignore' });
  child.unref();

  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(500);
    info = await version();
  }

  await test('有窗口的 Edge 能用这个 profile 启动', () => {
    assert.ok(info, `30 秒内 CDP 没响应。日志：${logFile}\n${tail(logFile)}`);
    assert.match(info.Browser, /Edg\//, `意外的浏览器标识：${info.Browser}`);
  });

  await test('调试端口只监听回环地址', () => {
    const ws = String(info?.webSocketDebuggerUrl ?? '');
    assert.match(ws, /^ws:\/\/127\.0\.0\.1:/, `端点不是回环：${ws}`);
  });

  await test('登录态跟着 profile 一起搬过来了', async () => {
    // A cookie/Login-Data store with real bytes is the honest signal that this
    // is the signed-in profile and not a fresh one.
    const loginData = path.join(profileDir, 'Default', 'Login Data');
    const cookies = path.join(profileDir, 'Default', 'Network', 'Cookies');
    const sizes = [loginData, cookies]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.statSync(file).size);
    assert.ok(sizes.length > 0, '没有 Cookie / Login Data 文件');
    assert.ok(sizes.some((size) => size > 1024), `凭据库太小（${sizes.join(', ')} 字节），像是空 profile`);
  });

  await test('打开的页签能被列举', async () => {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await res.json();
    const pages = list.filter((t) => t.type === 'page');
    assert.ok(pages.length > 0, '一个页签都没有');
  });

  // Close only the pid we started: this check must not touch anything else.
  console.log('\n关闭这次验证启动的浏览器...');
  try { process.kill(child.pid); } catch { /* already gone */ }

  let freed = false;
  for (let i = 0; i < 40 && !freed; i++) {
    await sleep(250);
    freed = (await version()) === null;
  }

  await test('关掉窗口后端口真的释放了（"我关了没"有确定答案）', () => {
    assert.ok(freed, '端口 10 秒后仍在响应：关窗口和释放端口不一致');
  });
}

/**
 * Last lines of a log file.
 * @param {string} file
 */
function tail(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-15).join('\n'); }
  catch { return '(无日志)'; }
}

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
