#!/usr/bin/env node
/**
 * Self-test for the parts that do not need a browser.
 *
 * The rule this enforces: "看着对不算" -- a module that reads correctly and
 * crashes on first use is worthless. Every assertion here fails loudly with the
 * value it saw.
 *
 * Run: node test/selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, findEdge } from '../lib/core/launcher.js';
import { parseFrontmatter } from '../lib/core/frontmatter.js';
import { browserUuid } from '../lib/core/lifecycle.js';
import * as records from '../lib/core/records.js';
import { readOwner, writeOwner, clearOwner } from '../lib/core/owner.js';

let passed = 0;
/**
 * Run one named check.
 * @param {string} label
 * @param {() => void|Promise<void>} fn
 */
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    console.error(`  FAIL ${label}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-test-'));
const tabsDir = path.join(tmp, 'tabs');
fs.mkdirSync(tabsDir, { recursive: true });

console.log('launcher');

await test('argv binds the debug port to loopback only', () => {
  const args = buildArgs({ port: 9222, profileDir: 'C:\\p', logFile: null });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(!args.some((a) => a.includes('0.0.0.0')), '绝不允许绑定到 0.0.0.0');
});

await test('argv disables background mode so closing the window ends the browser', () => {
  const args = buildArgs({ port: 9222, profileDir: 'C:\\p', logFile: null });
  assert.ok(args.includes('--disable-background-mode'));
});

await test('argv carries no headless flag', () => {
  const args = buildArgs({ port: 9222, profileDir: 'C:\\p', logFile: null });
  assert.ok(!args.some((a) => a.startsWith('--headless')), '必须是有窗口的浏览器');
});

await test('argv ends with the start url, defaulting to about:blank', () => {
  assert.equal(buildArgs({ port: 1, profileDir: 'p' }).at(-1), 'about:blank');
  assert.equal(buildArgs({ port: 1, profileDir: 'p', startUrl: 'https://x' }).at(-1), 'https://x');
});

await test('findEdge returns null for a bogus override instead of guessing', () => {
  assert.equal(findEdge('C:\\nope\\msedge.exe'), null);
});

console.log('frontmatter');

await test('parses the shipped skill frontmatter', () => {
  const raw = fs.readFileSync(new URL('../assets/edge-cdp/SKILL.md', import.meta.url), 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.name, 'edge-cdp');
  assert.ok(meta.description.length > 20);
  assert.ok(meta.whenToUse, 'whenToUse 应当存在');
  assert.ok(body.startsWith('#'), '正文应当从标题开始');
});

await test('rejects a file without frontmatter', () => {
  assert.throws(() => parseFrontmatter('# just a heading'), /frontmatter/);
});

await test('strips matching quotes and ignores comments', () => {
  const { meta } = parseFrontmatter('---\n# note\nname: "edge-cdp"\ndescription: \'d\'\n---\nbody');
  assert.equal(meta.name, 'edge-cdp');
  assert.equal(meta.description, 'd');
});

console.log('owner record');

await test('round-trips and clears', () => {
  const file = path.join(tmp, 'edge.json');
  const record = {
    pid: 1234, port: 9222, uuid: 'abc', wsUrl: 'ws://x/abc',
    startedAt: new Date().toISOString(), headed: true, profileDir: 'p',
    spawnedBy: { plugin: 'test' }, logFile: null,
  };
  writeOwner(file, record);
  assert.deepEqual(readOwner(file).uuid, 'abc');
  clearOwner(file);
  assert.equal(readOwner(file), null);
});

await test('a record without a uuid is treated as absent, not trusted', () => {
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 9222 }));
  assert.equal(readOwner(file), null, '没有 uuid 的记录无法证明归属，必须当作不存在');
});

await test('tolerates a UTF-8 BOM written by PowerShell', () => {
  const file = path.join(tmp, 'bom.json');
  fs.writeFileSync(file, '\ufeff' + JSON.stringify({ uuid: 'z', pid: 1 }), 'utf8');
  assert.equal(readOwner(file).uuid, 'z');
});

console.log('browserUuid');

await test('takes the last path segment of a devtools ws url', () => {
  assert.equal(browserUuid('ws://127.0.0.1:9222/devtools/browser/8f3a-11'), '8f3a-11');
  assert.equal(browserUuid(''), '');
});

console.log('records');

await test('claim count is a reference count', () => {
  const id = 'TAB1';
  records.updateRecord(tabsDir, id, () => ({
    id, url: '', title: '', createdAt: 't', updatedAt: 't',
    claims: { alice: { since: 't', lastUsed: null } }, log: [], origin: 'created',
  }));
  records.updateRecord(tabsDir, id, (record) => {
    record.claims.bob = { since: 't', lastUsed: null };
    return record;
  });
  assert.deepEqual(records.ownersOf(records.readRecord(tabsDir, id)).sort(), ['alice', 'bob']);
});

await test('withSession-style notes append and stamp lastUsed', () => {
  records.note(tabsDir, 'TAB1', 'alice', 'click', '提交', true);
  const record = records.readRecord(tabsDir, 'TAB1');
  assert.equal(record.log.at(-1).cmd, 'click');
  assert.equal(record.log.at(-1).ok, true);
  assert.ok(record.claims.alice.lastUsed, 'lastUsed 必须被刷新，归档判据靠它');
});

await test('read-only commands create no record for an unclaimed tab', () => {
  records.note(tabsDir, 'NOBODY', 'alice', 'text', '', true);
  assert.equal(records.readRecord(tabsDir, 'NOBODY'), null);
});

await test('mutating commands DO create a record so the change has an owner', () => {
  records.note(tabsDir, 'MUT', 'alice', 'nav', 'https://x', true);
  const record = records.readRecord(tabsDir, 'MUT');
  assert.ok(record, '改页面的操作必须留下记录');
  assert.equal(record.log[0].cmd, 'nav');
});

await test('a corrupt record is reported, never silently skipped', () => {
  fs.writeFileSync(path.join(tabsDir, 'BROKEN.json'), '{ not json', 'utf8');
  const { corrupt } = records.loadAll(tabsDir);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].file, 'BROKEN.json');
});

await test('legacy <name>.json shape upgrades to the claim format', () => {
  const legacy = records.normalizeRecord({ name: 'alice', id: 'OLD', url: 'https://x', createdAt: 't', lastUsedAt: 'u' });
  assert.deepEqual(Object.keys(legacy.claims), ['alice']);
  assert.equal(legacy.origin, 'created');
});

await test('an unknown origin defaults to adopted: never close what we did not open', () => {
  const record = records.normalizeRecord({ id: 'X', claims: {}, log: [], origin: 'weird' });
  assert.equal(record.origin, 'adopted');
});

await test('claimByName refuses to guess between two live tabs', () => {
  const other = 'TAB2';
  records.updateRecord(tabsDir, other, () => ({
    id: other, url: '', title: '', createdAt: 't', updatedAt: 't',
    claims: { alice: { since: 't', lastUsed: null } }, log: [], origin: 'created',
  }));
  const pages = [{ id: 'TAB1' }, { id: other }];
  assert.throws(() => records.claimByName(tabsDir, 'alice', pages), /拒绝猜测/);
});

await test('claimByName retires a claim whose tab is gone', () => {
  const pages = [{ id: 'TAB1' }];
  const found = records.claimByName(tabsDir, 'alice', pages);
  assert.equal(found.id, 'TAB1');
  assert.deepEqual(records.ownersOf(records.readRecord(tabsDir, 'TAB2')), []);
});

await test('a stale lock from a dead pid is stolen, not waited out', () => {
  const lock = path.join(tabsDir, 'LOCKY.lock');
  fs.writeFileSync(lock, '999999', 'utf8');
  const started = Date.now();
  const acquired = records.acquireLock(tabsDir, 'LOCKY');
  records.releaseLock(acquired);
  assert.ok(Date.now() - started < 1000, '死进程留下的锁必须立刻接管');
});

await test('archive keeps the record instead of deleting it', async () => {
  const { archiveRecord } = await import('../lib/core/tabs.js');
  archiveRecord(tabsDir, 'TAB1');
  assert.equal(records.readRecord(tabsDir, 'TAB1'), null, '活动目录里不该再有');
  assert.ok(fs.existsSync(path.join(tabsDir, 'archive', 'TAB1.json')), '归档目录里必须还在');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} 项通过${process.exitCode ? '，但有失败' : '，全部通过'}`);
