#!/usr/bin/env node
/**
 * Run `apply` against a real Cordis context.
 *
 * Why this exists: the plugin shipped with `ctx.skills` accessed behind
 * `ctx.get('skills') !== undefined`, and the hand-written fake context in
 * plugin-entry.mjs happily returned an object, so the test passed. Cordis
 * does not work that way -- the real proxy throws:
 *
 *   edge-cdp (dsh-edge-cdp): Error: cannot get property "skills" without inject
 *
 * A fake context proves nothing about service access rules. This test builds a
 * real Context, registers a fake `skills` service through the sanctioned path,
 * and asserts `apply` mounts and registers the skill provider. It also asserts
 * the plugin survives with no skills service at all.
 *
 * Run: node test/cordis-context.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ROOT = process.env.DSH_SDK_ROOT
  ?? 'C:\\D\\VScodeLanguage\\JavaScript\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai';

// Cordis is a third-party-looking bare specifier the plugin never imports; the
// test may, because a test is allowed to depend on the host it runs under.
const { Context, Service } = await import(pathToFileURL(path.join(SDK_ROOT, 'cordis', 'lib', 'index.js')).href);
const plugin = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'index.js')).href);

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

const edgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-cordis-'));

/**
 * Build a real Cordis context with fake services.
 * @param {{withSkills:boolean}} options
 */
function makeContext({ withSkills }) {
  const root = new Context();
  const registered = [];
  const providers = [];

  // A service must exist on the context before a plugin may read it; that is
  // exactly the rule the fake context was bypassing.
  root.provide('tools', { register: (definition) => { registered.push(definition); return () => {}; } });
  if (withSkills) {
    root.provide('skills', { registerProvider: (factory) => { providers.push(factory); return () => {}; } });
  }
  return { root, registered, providers };
}

console.log('真实 Cordis 上下文\n');

await test('有 skills 服务时：apply 挂载成功并注册技能 provider', async () => {
  const { root, registered, providers } = makeContext({ withSkills: true });
  root.plugin(plugin, { edgeRoot, cdpBase: 'http://127.0.0.1:9222' });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(registered.length, 18, `应注册 18 个工具，实际 ${registered.length}`);
  assert.equal(providers.length, 1, '应注册一个技能 provider');

  const [candidate] = await providers[0]().list();
  assert.equal(candidate.name, 'edge-cdp');
});

await test('没有 skills 服务时：apply 依然挂载成功，只缺技能', async () => {
  const { root, registered, providers } = makeContext({ withSkills: false });
  // This is the exact call that used to throw "cannot get property skills
  // without inject": a context where the service is absent.
  root.plugin(plugin, { edgeRoot, cdpBase: 'http://127.0.0.1:9222' });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(registered.length, 18, `工具注册不该依赖 skills 服务，实际 ${registered.length}`);
  assert.equal(providers.length, 0, '没有 skills 服务就不该注册 provider');
});

await test('inject 只声明真正必需的 tools', () => {
  assert.deepEqual(plugin.inject, ['tools'],
    'inject 是硬依赖：多声明一个会让插件在缺少该服务的 profile 里完全不加载');
});

await test('插件不读取任何未声明的服务', () => {
  // Cordis turns such a read into a thrown error; grep keeps it from coming
  // back in a form the runtime tests might not reach (a rarely-taken branch).
  const raw = fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'index.js'), 'utf8');
  // Strip comments first: prose about `ctx.skills` is not a read of it, and a
  // check that fires on comments would train people to delete the explanation.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const declared = new Set([...plugin.inject, 'logger', 'get', 'on', 'effect', 'inject', 'plugin']);
  const reads = [...source.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  for (const name of new Set(reads)) {
    assert.ok(declared.has(name), `ctx.${name} 未在 inject 中声明，运行时会抛错`);
  }
});

fs.rmSync(edgeRoot, { recursive: true, force: true });

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
