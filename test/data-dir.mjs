#!/usr/bin/env node
/**
 * Data-directory rules.
 *
 * The plugin is installable from git, so pnpm owns the package directory and
 * replaces it on upgrade. Anything kept in `<package>/var` would be deleted by
 * `pnpm update` -- including the browser profile, which is the user's login
 * state. These assertions make that class of mistake impossible to reintroduce
 * silently.
 *
 * Run: node test/data-dir.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_ROOT,
  defaultEdgeRoot,
  isInsidePackage,
  legacyEdgeRoot,
  paths as resolvePaths,
  resolveDshHome,
} from '../lib/core/paths.js';

const PACKAGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {() => any} fn
 */
function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${label}\n       ${e.message}`);
  }
}

console.log(`DSH_HOME = ${process.env.DSH_HOME ?? '(unset)'}\n`);

test('默认数据目录在 DSH_HOME 下，不在插件包里', () => {
  const layout = resolvePaths();
  assert.ok(!isInsidePackage(layout), `数据目录落在插件包内：${layout.root}`);
  assert.equal(path.dirname(layout.root), resolveDshHome(), '应当是 <DSH_HOME>/edge-cdp');
  assert.equal(path.basename(layout.root), 'edge-cdp');
});

test('DSH_HOME 环境变量优先于 ~/.dsh', () => {
  const saved = process.env.DSH_HOME;
  const probe = path.join(os.tmpdir(), 'edge-cdp-home-probe');
  try {
    process.env.DSH_HOME = probe;
    assert.equal(resolveDshHome(), path.resolve(probe));
    assert.equal(resolvePaths().root, path.join(path.resolve(probe), 'edge-cdp'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});

test('显式 edgeRoot 覆盖默认位置', () => {
  const custom = path.join(os.tmpdir(), 'edge-cdp-custom-root');
  const layout = resolvePaths(custom);
  assert.equal(layout.root, path.resolve(custom));
  assert.equal(layout.profile, path.join(path.resolve(custom), 'profile'));
});

test('四个子路径都在同一个根下', () => {
  const layout = resolvePaths(path.join(os.tmpdir(), 'edge-cdp-layout-probe'));
  for (const key of ['profile', 'tabs', 'logs', 'ownerFile']) {
    assert.equal(path.dirname(layout[key]), layout.root, `${key} 不在根目录下`);
  }
});

test('isInsidePackage 能识破包内路径', () => {
  const inPackage = { root: path.join(PACKAGE_ROOT, 'var') };
  assert.equal(isInsidePackage(inPackage), true, '包内路径必须被识别出来');
  const outside = { root: path.join(os.tmpdir(), 'edge-cdp-outside') };
  assert.equal(isInsidePackage(outside), false);
});

test('legacyEdgeRoot 仍指向旧的包内位置（用于提示迁移）', () => {
  assert.equal(legacyEdgeRoot(), path.join(PACKAGE_PATH, 'var'));
});

test('默认路径下不会有 .gitignore 里那种包内 var 被误用', () => {
  // Guard the actual repo: `var/` must not be tracked, and the code must not
  // default to it. A regression here deletes someone's login state on upgrade.
  const gitignore = fs.readFileSync(path.join(PACKAGE_PATH, '.gitignore'), 'utf8');
  assert.match(gitignore, /^var\/$/m, '.gitignore 必须继续忽略包内 var/');
});

test('默认数据目录不会在测试中被意外创建', () => {
  const layout = resolvePaths();
  const createdJustNow = fs.existsSync(layout.root) && fs.statSync(layout.root).mtimeMs > Date.now() - 1000;
  assert.equal(createdJustNow, false, '仅解析路径不应创建目录');
});

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
