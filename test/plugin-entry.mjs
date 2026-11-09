#!/usr/bin/env node
/**
 * Load the plugin entry exactly as DSH does, and call `apply` for real.
 *
 * The important constraint: NO module resolution hooks. A plugin that lives
 * outside the profile's node_modules is resolved by plain Node rules, so a
 * top-level `import '@deepseek-ai/...'` kills the plugin before apply() runs.
 * That is precisely how this plugin failed in production:
 *
 *   edge-cdp (dsh-edge-cdp): failed to import:
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
 *
 * An earlier version of this test installed its own resolve hook to make the
 * import pass, which proved nothing: it tested the hook, not the plugin. Now
 * the absence of hooks is the assertion.
 *
 * Run: node test/plugin-entry.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

console.log('插件入口（无解析钩子，等同 DSH 的 linked root 环境）\n');

/** @type {any} */
let plugin;
await test('模块能在无钩子条件下加载', async () => {
  plugin = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'index.js')).href);
  assert.equal(plugin.name, 'edge-cdp');
  assert.equal(typeof plugin.apply, 'function');
});

await test('加载后的模块没有残留的 SDK 依赖', () => {
  const files = [
    path.join(PACKAGE_ROOT, 'lib', 'index.js'),
    path.join(PACKAGE_ROOT, 'lib', 'tools.js'),
    ...fs.readdirSync(path.join(PACKAGE_ROOT, 'lib', 'core'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(PACKAGE_ROOT, 'lib', 'core', name)),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(
      !/from\s+['"]@deepseek-ai\//.test(source),
      `${path.basename(file)} 还 import 了 @deepseek-ai 包：插件会 import 失败`
    );
  }
});

await test('导出了 name / inject / apply', () => {
  assert.deepEqual(plugin.inject, ['tools']);
});

// --- a context shaped like the one DSH hands a plugin ----------------------
const registeredTools = [];
/** @type {Array<() => any>} */
const providerFactories = [];
let warned = null;
let informed = null;

const ctx = {
  logger: {
    info: (m) => { informed = m; },
    warn: (m) => { warned = m; },
  },
  get: (name) => (name === 'skills'
    ? { registerProvider: (factory) => { providerFactories.push(factory); } }
    : name === 'workingDirectory'
      ? { ensure: async () => process.cwd() }
      : undefined),
  skills: {
    registerProvider: (factory) => { providerFactories.push(factory); },
  },
  tools: {
    register: (definition) => { registeredTools.push(definition); return () => {}; },
  },
};

const edgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-entry-'));

await test('apply() 不抛错，并注册全部工具与技能 provider', () => {
  plugin.apply(ctx, { edgeRoot, cdpBase: 'http://127.0.0.1:9222' });
  assert.equal(registeredTools.length, 18, `应注册 18 个工具，实际 ${registeredTools.length}`);
  assert.equal(providerFactories.length, 1, '应注册一个技能 provider');
  assert.ok(String(informed ?? '').includes('edge-cdp'), 'apply 应当把路径写进日志');
});

await test('工具名唯一且都以 edge_ 开头', () => {
  const names = registeredTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, '工具名有重复');
  for (const name of names) assert.match(name, /^edge_/);
});

await test('每个工具都带可执行的 execute 与输出 schema', () => {
  for (const tool of registeredTools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 没有 execute`);
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} 没有 render`);
    assert.equal(tool.output.schema.type, 'object', `${tool.name} 的输出必须是对象`);
  }
});

await test('参数 schema 用的是 SDK 认可的原始 JSON Schema 形状', () => {
  for (const tool of registeredTools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的参数根必须是 object`);
    assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} 缺少 properties`);
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      const ok = spec.type !== undefined || spec.oneOf !== undefined || Object.keys(spec).length > 0;
      assert.ok(ok, `${tool.name}.${key} 编译结果为空`);
    }
  }
});

await test('技能 provider 返回的候选形状合法', async () => {
  const provider = providerFactories[0]();
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  const skill = candidates[0];
  assert.equal(skill.name, 'edge-cdp');
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, '技能名必须是 kebab-case');
  assert.ok(skill.description.length > 20, 'description 太短，模型看不出该不该用');
  assert.ok(skill.whenToUse, 'whenToUse 缺失');
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.rank, 600, 'rank 必须是 bundled 档（600）');
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(fs.existsSync(skill.resourceBase.path), 'resourceBase 目录必须存在');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
});

await test('技能正文能加载出来，且 references 随包可达', async () => {
  const provider = providerFactories[0]();
  const [candidate] = await provider.list();
  const skill = await provider.get(candidate, {});
  assert.ok(skill.content.startsWith('#'), '正文应从标题开始');
  assert.ok(skill.content.includes('edge_status'), '正文必须教模型先看状态');
  assert.ok(skill.content.includes('登录'), '正文必须包含登录交接的说明');

  const base = candidate.resourceBase.path;
  for (const file of ['references/recipes.md', 'references/pitfalls.md']) {
    assert.ok(fs.existsSync(path.join(base, file)), `缺少 ${file}`);
  }
});

await test('没有 skills 服务时只告警，不抛错', () => {
  const bare = {
    logger: { info() {}, warn: (m) => { warned = m; } },
    get: () => undefined,
    tools: { register: () => () => {} },
  };
  plugin.apply(bare, { edgeRoot });
  assert.ok(String(warned ?? '').includes('skills'), '缺少 skills 服务必须给出可读的告警');
});

fs.rmSync(edgeRoot, { recursive: true, force: true });

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
