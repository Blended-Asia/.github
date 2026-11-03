// Org conventions for AI agents in every child repo (Claude Code, Codex, Cursor, GitHub Copilot).
// Managed blocks are merged into existing files, so repo-specific content outside the markers is kept.
//
//   AGENTS.md                         read by Codex, Cursor, Copilot (coding agent) and others
//   CLAUDE.md                         read by Claude Code; imports AGENTS.md
//   .github/copilot-instructions.md   read by GitHub Copilot in the IDE
//   .claude/settings.json             Claude Code hook: blocks `gh pr create|edit` that breaks the convention
//   .github/scripts/pr-lint.mjs       the checker (same rules as the org / pr-convention check)
//   .prettierignore                   (JS repos) keeps Prettier off the managed files: each repo has its own style,
//                                     and reformatting them would fail the harness or make the next audit rewrite them
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'profiles/starter/agents');

export const BEGIN = '<!-- org-agents:begin (managed by Blended-Asia/.github — edit outside these markers) -->';
export const END = '<!-- org-agents:end -->';
export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.github/scripts/pr-lint.mjs" --claude-hook';

export const AGENT_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.claude/settings.json',
  '.github/scripts/pr-lint.mjs',
  '.prettierignore',
];

/** Managed files Prettier must leave alone (listed in the repo's .prettierignore block). */
export const PRETTIER_IGNORED = AGENT_PATHS.filter((p) => p !== '.prettierignore');
const IGNORE_BEGIN = '# org-agents:begin (managed by Blended-Asia/.github)';
const IGNORE_END = '# org-agents:end';

/** Same as mergeBlock for `#`-comment files such as .prettierignore. */
export function mergeIgnoreBlock(existing, lines) {
  const managed = `${IGNORE_BEGIN}\n${lines.join('\n')}\n${IGNORE_END}\n`;
  if (existing == null || !existing.trim()) return managed;
  const s = existing.indexOf('# org-agents:begin');
  const e = existing.indexOf(IGNORE_END);
  if (s >= 0 && e > s) return existing.slice(0, s) + managed + existing.slice(e + IGNORE_END.length).replace(/^\n/, '');
  return `${existing.replace(/\s*$/, '')}\n\n${managed}`;
}

/** Put `block` between the markers: replace the old block, or append it (new file: block only). */
export function mergeBlock(existing, block) {
  const managed = `${BEGIN}\n${block.trim()}\n${END}\n`;
  if (existing == null || !existing.trim()) return managed;
  const s = existing.indexOf('<!-- org-agents:begin');
  const e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + managed + existing.slice(e + END.length).replace(/^\n/, '');
  return `${existing.replace(/\s*$/, '')}\n\n${managed}`;
}

/**
 * Add the PreToolUse hook to Claude Code project settings, keeping everything else.
 * Returns null when the existing file is not valid JSON (reported, never overwritten).
 */
export function mergeClaudeSettings(existing) {
  let cfg = {};
  if (existing != null && existing.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch {
      return null;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  }
  const hooks = (cfg.hooks ??= {});
  const pre = (hooks.PreToolUse ??= []);
  const has = pre.some((m) => (m.hooks ?? []).some((h) => h.command === HOOK_COMMAND));
  if (!has) pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

const read = (f) => readFile(path.join(DIR, f), 'utf8');

/**
 * Files to write so a repo has the current agent conventions. `current` maps path → text (null = missing).
 * `js`: the repo has a package.json, so Prettier may run on it → also maintain the .prettierignore block.
 * Only files whose content would change are returned. `problems` lists files left alone.
 */
export async function planAgentFiles(current, { js = false } = {}) {
  const want = {
    'AGENTS.md': mergeBlock(current['AGENTS.md'], await read('AGENTS.block.md')),
    'CLAUDE.md': mergeBlock(current['CLAUDE.md'], await read('CLAUDE.block.md')),
    '.github/copilot-instructions.md': mergeBlock(current['.github/copilot-instructions.md'], await read('copilot-instructions.block.md')),
    '.claude/settings.json': mergeClaudeSettings(current['.claude/settings.json']),
    '.github/scripts/pr-lint.mjs': await read('pr-lint.mjs'),
    ...(js ? { '.prettierignore': mergeIgnoreBlock(current['.prettierignore'], PRETTIER_IGNORED) } : {}),
  };
  const files = [];
  const problems = [];
  for (const p of AGENT_PATHS) {
    if (!(p in want)) continue;
    if (want[p] === null) {
      problems.push(`${p} is not valid JSON: add the pr-lint hook by hand`);
      continue;
    }
    if (want[p] !== current[p]) files.push({ path: p, content: want[p], message: 'chore: add org conventions for AI agents' });
  }
  return { files, problems };
}
