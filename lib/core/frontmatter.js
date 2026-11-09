/**
 * Minimal YAML frontmatter reader for SKILL.md files.
 *
 * A full YAML parser would be a dependency this plugin does not otherwise
 * need, and skill frontmatter is a flat map of strings. Unknown shapes are
 * reported rather than guessed at.
 */

/**
 * Parse the leading `---` delimited block into a flat string map.
 * @param {string} raw - whole file
 * @returns {{meta:Record<string,string>, body:string}}
 */
export function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) throw new Error('缺少 YAML frontmatter（文件必须以 --- 开头）');
  /** @type {Record<string,string>} */
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}
