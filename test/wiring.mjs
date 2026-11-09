#!/usr/bin/env node
/**
 * Wiring checks: is the plugin reachable from the profile the way DSH expects?
 *
 * The bug this exists for: `New-Item -ItemType Junction` created a plain
 * directory when the target name was already present, so the plugin sat in
 * `node_modules` as an ordinary folder. Node resolved it fine, which made the
 * mistake invisible -- but DSH discovers profile plugins with
 * `dirent.isSymbolicLink()`, so the bundle was never loaded at all.
 *
 * Run: node test/wiring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web');

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {() => void} fn
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

console.log(`profile: ${PROFILE_DIR}\n`);

const manifestPath = path.join(PROFILE_DIR, 'package.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null;

test('profile 的 package.json 存在且已声明本插件', () => {
  assert.ok(manifest, `找不到 ${manifestPath}`);
  assert.ok(manifest.dependencies?.['dsh-edge-cdp'], '依赖里缺 dsh-edge-cdp');
});

test('插件已加入 dsh.profile.bundles', () => {
  assert.ok(Array.isArray(manifest?.dsh?.profile?.bundles), '缺 dsh.profile.bundles');
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-edge-cdp'), 'bundles 里缺 dsh-edge-cdp');
});

/*
 * Two supported install shapes, and they need different assertions:
 *
 *  - linked (local development): a reparse point pointing at this checkout.
 *    DSH finds it through `linkedProfileRoots`, which requires
 *    `lstat().isSymbolicLink()` -- a plain directory silently never loads.
 *  - registry/git (normal install): pnpm materialises a real directory. DSH
 *    resolves it as an ordinary profile dependency, so a plain directory is
 *    correct here and must NOT be rejected.
 *
 * The test refuses only the one state that is always wrong: something that
 * looks like a directory but is not reachable as the plugin.
 */
test('node_modules 里的插件可被 DSH 发现', () => {
  const linkPath = path.join(PROFILE_DIR, 'node_modules', 'dsh-edge-cdp');
  assert.ok(fs.existsSync(linkPath), `找不到 ${linkPath}`);
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    const target = path.resolve(fs.readlinkSync(linkPath));
    assert.ok(fs.existsSync(path.join(target, 'lib', 'index.js')), `链接指向 ${target}，但那里没有插件入口`);
    console.log(`       (linked install -> ${target})`);
  } else {
    assert.ok(stat.isDirectory(), '既不是链接也不是目录');
    assert.ok(
      fs.existsSync(path.join(linkPath, 'lib', 'index.js')),
      '普通目录里没有插件入口：可能是安装不完整'
    );
    console.log('       (installed copy)');
  }
});

test('通过 node_modules 能读到插件入口', () => {
  const entry = path.join(PROFILE_DIR, 'node_modules', 'dsh-edge-cdp', 'lib', 'index.js');
  assert.ok(fs.existsSync(entry), `找不到 ${entry}`);
});

test('已安装的副本运行时文件齐全', () => {
  const root = path.join(PROFILE_DIR, 'node_modules', 'dsh-edge-cdp');
  for (const file of [
    'lib/index.js',
    'lib/tools.js',
    'lib/core/paths.js',
    'lib/core/tool-schema.js',
    'assets/edge-cdp/SKILL.md',
    'assets/edge-cdp/references/recipes.md',
    'assets/edge-cdp/references/pitfalls.md',
    'cordis.patch.yml',
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `已安装副本缺少 ${file}`);
  }
});

test('插件的 cordis.patch.yml 声明了 edge-cdp 入口', () => {
  const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*edge-cdp/);
  assert.match(patch, /name:\s*'dsh-edge-cdp'/);
});

test('package.json 指向的 bundle patch 文件确实存在', () => {
  const own = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const declared = own.dsh?.bundle?.patch;
  assert.ok(declared, 'package.json 缺少 dsh.bundle.patch');
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, declared)), `bundle patch 缺失：${declared}`);
});

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
