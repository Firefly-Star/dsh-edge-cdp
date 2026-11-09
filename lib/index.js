/**
 * dsh-edge-cdp -- one headed, resident Edge shared by every DSH agent.
 *
 * Three jobs, in order of importance:
 *  1. Own the browser's lifecycle. Agents cannot start Chromium (the DSH
 *     sandbox's restricted token kills its mojo IPC), and a browser spawned
 *     from an agent's shell dies with the session. Starting it here means the
 *     window survives a DSH restart -- which is what lets the user finish a
 *     login by hand instead of losing it halfway.
 *  2. Expose CDP as tools, so no agent has to assemble a PowerShell command
 *     line out of quoting hazards.
 *  3. Ship the edge-cdp skill, which is the part that actually makes an agent
 *     competent at driving a shared browser.
 *
 * @module dsh-edge-cdp
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './core/frontmatter.js';
import { isInsidePackage, legacyEdgeRoot, paths as resolvePaths } from './core/paths.js';
import { defineTool } from './core/tool-schema.js';
import { buildToolSpecs } from './tools.js';

/**
 * Precedence rank for a bundled skill provider.
 *
 * Matches BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill. Inlined on purpose: a
 * plugin living outside the profile's node_modules resolves through plain Node
 * rules, so importing an installation-scope package at module top level makes
 * the whole plugin fail to load. Verified by
 * `test/skill-rank-parity.mjs` against the real SDK.
 */
const BUNDLED_SKILL_RANK = 600;

/** Cordis plugin name. */
export const name = 'edge-cdp';

/** Services this plugin needs. `skills` and `workingDirectory` are optional. */
export const inject = ['tools'];

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = path.join(PACKAGE_ROOT, 'assets');
const SKILL_NAMES = ['edge-cdp'];

/**
 * Read one bundled SKILL.md.
 * @param {string} directory
 * @returns {{name:string, description:string, whenToUse?:string, content:string}}
 */
function readSkill(directory) {
  const file = path.join(directory, 'SKILL.md');
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!meta.name || !meta.description) {
    throw new Error(`edge-cdp: ${file} 的 frontmatter 需要 name 和 description`);
  }
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content: body,
  };
}

/**
 * The provider that advertises this package's bundled skills.
 * @returns {{name:string, list:Function, get:Function}}
 */
function createSkillProvider() {
  const candidates = SKILL_NAMES.map((skillName) => {
    const directory = path.join(SKILL_ROOT, skillName);
    const skill = readSkill(directory);
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-edge-cdp',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator: path.join(directory, 'SKILL.md'),
      // references/ travels with the skill: the model reads recipes.md and
      // pitfalls.md on demand instead of paying for them every turn.
      resourceBase: { kind: 'directory', path: directory.split(path.sep).join('/') },
    };
  });

  return {
    name: 'dsh-edge-cdp',
    list: () => Promise.resolve(candidates),
    async get(candidate) {
      const skill = readSkill(path.dirname(candidate.locator));
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: skill.content };
    },
  };
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{edgeRoot?:string, cdpBase?:string, edgePath?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const layout = resolvePaths(config.edgeRoot);
  const cdpBase = config.cdpBase ?? 'http://127.0.0.1:9222';

  ctx.logger?.info?.(`edge-cdp: profile=${layout.profile} cdp=${cdpBase}`);

  // Two conditions are loud on purpose, because both silently lose the user's
  // login state if left alone.
  if (isInsidePackage(layout)) {
    ctx.logger?.warn?.(
      `edge-cdp: 数据目录在插件包内（${layout.root}）。从 git 安装的包升级时会被整个替换，`
      + '浏览器 profile（登录态）会随之丢失。请把数据移到 <DSH_HOME>\\edge-cdp。'
    );
  }
  const legacy = legacyEdgeRoot();
  if (layout.root !== legacy && fs.existsSync(path.join(legacy, 'profile')) && !fs.existsSync(layout.profile)) {
    ctx.logger?.warn?.(
      `edge-cdp: 发现旧位置还有浏览器 profile（${legacy}）。`
      + `要保留登录态就把 var\\ 下内容移到 ${layout.root}，否则删掉它。`
    );
  }

  // Cordis gates service access on `inject`: reading `ctx.skills` without
  // declaring it throws, and declaring it makes the service a hard
  // requirement. Both are wrong here -- a browser plugin must still mount on a
  // profile that has no skills service. So resolve the service through
  // `ctx.get()`, which is the supported optional lookup, and keep `inject`
  // limited to `tools`.
  //
  // The shape is checked too, not just presence: `ctx.get()` returns whatever
  // is registered under that name, and a plugin must never crash the host
  // because some other provider put an unexpected object there.
  const skills = ctx.get('skills');
  if (skills && typeof skills.registerProvider === 'function') {
    skills.registerProvider(() => createSkillProvider());
  } else {
    ctx.logger?.warn?.('edge-cdp: 没有可用的 skills 服务，edge-cdp 技能不会出现在会话目录里');
  }

  /**
   * The calling agent's working directory.
   *
   * process.cwd() would be the DSH host's directory, not the agent's: several
   * sessions share one host process, so a screenshot taken by an agent in
   * workspace A must not land in workspace B. Falling back to cwd only when
   * there is no agent keeps the CLI story working.
   * @param {any} exec
   * @returns {Promise<string>}
   */
  const agentCwd = async (exec) => {
    const agent = exec?.agent;
    const directory = ctx.get('workingDirectory');
    if (agent !== undefined && directory !== undefined) {
      try {
        return await directory.ensure(agent, exec.signal);
      } catch { /* fall through to the process cwd */ }
    }
    return process.cwd();
  };

  const specs = buildToolSpecs({
    paths: layout,
    cdpBase,
    edgePath: config.edgePath,
    // Provenance recorded in edge.json: which host process started the browser.
    spawnedBy: () => ({
      plugin: 'dsh-edge-cdp',
      pid: process.pid,
      version: '0.1.0',
      at: new Date().toISOString(),
    }),
    agentCwd,
  });

  for (const spec of specs) ctx.tools.register(defineTool(spec));
}
