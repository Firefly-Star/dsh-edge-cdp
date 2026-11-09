#!/usr/bin/env node
/**
 * Compile every tool spec through the compiler the plugin actually ships.
 *
 * Why this test exists: the schema DSL is validated at definition time, so a
 * spec that looks fine can throw before a single call happens. Catching that
 * here means a broken tool surfaces in a test run instead of taking the whole
 * plugin down at DSH startup.
 *
 * This uses the plugin's own `lib/core/tool-schema.js`, not the SDK: the
 * shipped behaviour is what matters, and `schema-parity.mjs` separately proves
 * that implementation is identical to the SDK's. Keeping this suite free of
 * SDK imports means it runs anywhere the plugin runs.
 *
 * Run: node test/compile-tools.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '../lib/core/tool-schema.js';
import { paths as resolvePaths } from '../lib/core/paths.js';
import { buildToolSpecs } from '../lib/tools.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const specs = buildToolSpecs({
  paths: resolvePaths(path.join(os.tmpdir(), 'edge-cdp-test')),
  cdpBase: 'http://127.0.0.1:9222',
  edgePath: undefined,
  spawnedBy: () => ({ plugin: 'test' }),
  agentCwd: async () => PACKAGE_ROOT,
});

console.log(`编译 ${specs.length} 个工具定义\n`);

let failed = 0;
const seen = new Set();
for (const spec of specs) {
  try {
    if (seen.has(spec.name)) throw new Error('工具名重复');
    seen.add(spec.name);
    const tool = defineTool(spec);
    const params = Object.keys(tool.parameters?.properties ?? {});
    const required = tool.parameters?.required ?? [];
    console.log(`  ok   ${spec.name.padEnd(16)} 参数[${params.join(', ') || '无'}] 必填[${required.join(', ') || '无'}]`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${spec.name}: ${e.message}`);
  }
}

// A tool named twice would silently shadow, which is exactly the kind of
// failure that is invisible until someone cannot find their command.
if (seen.size !== specs.length) {
  failed++;
  console.error(`  FAIL 工具名有重复：${specs.length} 个定义，${seen.size} 个名字`);
}

console.log(`\n${specs.length - failed}/${specs.length} 个工具编译通过`);
if (failed > 0) process.exitCode = 1;
