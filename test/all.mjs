#!/usr/bin/env node
/**
 * One command that proves the whole plugin still works.
 *
 * Running five suites by hand invites skipping the slow one. This runs them in
 * order and reports a single verdict, so "it works" is one command, not five
 * remembered ones.
 *
 * Run: node test/all.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Ordered suites; `live` may skip its browser-dependent cases. */
const SUITES = [
  ['selftest', '核心语义（argv / 记录 / 锁 / 归档 / BOM）'],
  ['data-dir', '运行时数据在 DSH_HOME 下，不在包里'],
  ['compile-tools', '工具定义能被编译'],
  ['schema-parity', '本地 schema 编译器与真实 SDK 逐字节一致'],
  ['plugin-entry', '插件入口在无解析钩子下能加载并 apply()'],
  ['cordis-context', '在真实 Cordis 上下文里挂载（inject 规则）'],
  ['wiring', 'profile 接线形态'],
  ['live-tools', '对着真实浏览器执行'],
];

// launch-check starts a real windowed browser, so it is opt-in: a routine test
// run must not pop a window onto the user's desktop or race the live instance.
const OPTIONAL = [
  ['launch-check', '真启动一次有窗口的 Edge 并确认关窗后端口释放（会弹窗口）'],
];

let failed = 0;
const results = [];

for (const [name, description] of SUITES) {
  process.stdout.write(`\n=== ${name} — ${description}\n`);
  const run = spawnSync(process.execPath, [path.join(HERE, `${name}.mjs`)], {
    stdio: 'inherit',
    env: process.env,
  });
  const ok = run.status === 0;
  if (!ok) failed++;
  results.push({ name, ok });
}

if (process.argv.includes('--with-launch')) {
  for (const [name, description] of OPTIONAL) {
    process.stdout.write(`\n=== ${name} — ${description}\n`);
    const run = spawnSync(process.execPath, [path.join(HERE, `${name}.mjs`)], {
      stdio: 'inherit',
      env: process.env,
    });
    const ok = run.status === 0;
    if (!ok) failed++;
    results.push({ name, ok });
  }
} else {
  console.log('\n（跳过 launch-check；加 --with-launch 会真的弹一个 Edge 窗口来验证启动）');
}

console.log('\n' + '='.repeat(60));
for (const { name, ok } of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
}
console.log('='.repeat(60));

if (failed > 0) {
  console.error(`\n${failed} 个测试套件失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}
