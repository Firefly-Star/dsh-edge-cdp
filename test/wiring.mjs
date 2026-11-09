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

test('node_modules 里是一个真正的链接，而不是普通目录', () => {
  const linkPath = path.join(PROFILE_DIR, 'node_modules', 'dsh-edge-cdp');
  assert.ok(fs.existsSync(linkPath), `找不到 ${linkPath}`);
  const stat = fs.lstatSync(linkPath);
  // This is the exact predicate DSH's linkedProfileRoots uses.
  assert.equal(stat.isSymbolicLink(), true, '不是链接：DSH 不会把它当成 profile 插件加载');
  const target = fs.readlinkSync(linkPath);
  assert.equal(path.resolve(target), PACKAGE_ROOT, `链接指向 ${target}，不是当前插件目录`);
});

test('通过链接能读到插件入口', () => {
  const entry = path.join(PROFILE_DIR, 'node_modules', 'dsh-edge-cdp', 'lib', 'index.js');
  assert.ok(fs.existsSync(entry), `找不到 ${entry}`);
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
