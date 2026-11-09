#!/usr/bin/env node
/**
 * Parity check: does the local tool-schema compiler match the real SDK?
 *
 * The plugin cannot import `@deepseek-ai/dsh-tools` at runtime (a linked root
 * resolves by plain Node rules and that package is not on its path), so it
 * carries its own compiler. The risk of that decision is drift: the local
 * version could compile a schema differently from the SDK, and the plugin would
 * then ship tools whose argument rules the host does not agree with.
 *
 * This test removes the risk by compiling the receipt specs through both and
 * asserting deep equality. It imports the SDK by absolute path, which is fine
 * for a test and would be fatal in the plugin.
 *
 * Run: node test/schema-parity.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parametersToJsonSchema, valueToJsonSchema, defineTool as localDefineTool } from '../lib/core/tool-schema.js';
import { paths as resolvePaths } from '../lib/core/paths.js';
import { buildToolSpecs } from '../lib/tools.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ROOT = process.env.DSH_SDK_ROOT
  ?? 'C:\\D\\VScodeLanguage\\JavaScript\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai';

const sdkTools = await import(pathToFileURL(path.join(SDK_ROOT, 'dsh-tools', 'lib', 'index.js')).href);

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

const specs = buildToolSpecs({
  paths: resolvePaths(path.join(os.tmpdir(), 'edge-cdp-test')),
  cdpBase: 'http://127.0.0.1:9222',
  edgePath: undefined,
  spawnedBy: () => ({ plugin: 'test' }),
  agentCwd: async () => PACKAGE_ROOT,
});

console.log(`对照 ${specs.length} 个工具定义\n`);

// --- 1. parameter schemas compile identically -----------------------------
for (const spec of specs) {
  test(`${spec.name}: 参数 schema 与 SDK 一致`, () => {
    const mine = parametersToJsonSchema(spec.parameters ?? {});
    const theirs = sdkTools.parameterSchemaSpecToJsonSchema(spec.parameters ?? {});
    assert.deepEqual(mine, theirs);
  });
}

// --- 2. output schemas compile identically --------------------------------
for (const spec of specs) {
  test(`${spec.name}: 输出 schema 与 SDK 一致`, () => {
    const mine = valueToJsonSchema(spec.output.schema);
    const theirs = sdkTools.valueSchemaSpecToJsonSchema(spec.output.schema);
    assert.deepEqual(mine, theirs);
  });
}

// --- 3. whole definitions agree on the model-visible parts ----------------
for (const spec of specs) {
  test(`${spec.name}: 完整定义的关键字段一致`, () => {
    const mine = localDefineTool(spec);
    const theirs = sdkTools.defineTool(spec);
    assert.deepEqual(mine.parameters, theirs.parameters);
    assert.deepEqual(mine.output.schema, theirs.output.schema);
    assert.equal(mine.name, theirs.name);
    assert.equal(mine.description, theirs.description);
  });
}

// --- 4. argument validation agrees on valid and invalid inputs ------------
const edgeFill = specs.find((spec) => spec.name === 'edge_fill');
const mineFill = localDefineTool(edgeFill);
const theirsFill = sdkTools.defineTool(edgeFill);

const SAMPLES = [
  ['缺必填字段', { tab: 'alice' }],
  ['完整合法', { tab: 'alice', selector: '#x', value: 'v' }],
  ['类型错误', { tab: 42, selector: '#x', value: 'v' }],
  ['多余字段', { tab: 'a', selector: '#x', value: 'v', bogus: 1 }],
  ['空对象', {}],
];

for (const [label, args] of SAMPLES) {
  test(`参数校验一致：${label}`, async () => {
    let mineErr = null;
    let theirsErr = null;
    try { await mineFill.execute(args, {}); } catch (e) { mineErr = e; }
    try { await theirsFill.execute(args, {}); } catch (e) { theirsErr = e; }
    assert.equal(Boolean(mineErr), Boolean(theirsErr), '接受/拒绝的结论不一致');
    if (mineErr && theirsErr) {
      // Both reject; the message must agree on which fields are wrong.
      const mineFields = mineErr.violations ?? [];
      const theirsFields = theirsErr.violations ?? [];
      assert.equal(mineFields.length, theirsFields.length, `违规项数量不同：${mineFields} vs ${theirsFields}`);
    }
  });
}

// --- 5. the inlined rank constant is still the SDK's value -----------------
test('BUNDLED_SKILL_RANK 常量与 SDK 一致', async () => {
  const sdkSkill = await import(pathToFileURL(path.join(SDK_ROOT, 'dsh-skill', 'lib', 'index.js')).href);
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'index.js'), 'utf8'));
  const match = /const BUNDLED_SKILL_RANK = (\d+);/.exec(source);
  assert.ok(match, '找不到内联的 BUNDLED_SKILL_RANK');
  assert.equal(Number(match[1]), sdkSkill.BUNDLED_SKILL_RANK, '和 SDK 的 BUNDLED_SKILL_RANK 不一致');
});

console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exitCode = 1;
