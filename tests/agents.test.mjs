import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, wf, between, inputDefaults } from './helpers.mjs';
import { BEGIN, END, HOOK_COMMAND, mergeBlock, mergeClaudeSettings, planAgentFiles } from '../scripts/agents.mjs';
import {
  DEFAULTS, checkPr, repoInputs, ghPrCalls, hookDecision, shellWords,
} from '../profiles/starter/agents/pr-lint.mjs';

const LINT = path.join(ROOT, 'profiles/starter/agents/pr-lint.mjs');
const convention = wf('pr-convention.yml');
// Template literals in the workflow escape backticks; compare the plain text.
const workflowScript = between(convention, 'org-pr-convention').replaceAll('\\`', '`');
const GOOD_BODY = '## Summary\nAdd x\n\n## How to test\n1. Open /x\n';

// ---------- same rules as the org / pr-convention check ----------
test('pr-lint defaults equal the reusable workflow input defaults', () => {
  const wfDefaults = inputDefaults(convention);
  for (const [k, v] of Object.entries(DEFAULTS)) assert.equal(String(wfDefaults[k]), String(v), k);
});

test('pr-lint reports with the same wording as the workflow (title, branch, sections)', () => {
  const { errors } = checkPr(
    { title: 'Feat: add things.', branch: 'my-branch', body: '## Summary\n\n## How to test\n' },
    {},
  );
  assert.deepEqual(errors.map(([k]) => k), ['Title', 'Branch', 'Body', 'Body']);
  for (const tpl of ['does not match `type(scope): description`', 'does not match `', 'is empty (write "N/A" if not applicable)', 'characters long (max ']) {
    assert.ok(workflowScript.includes(tpl), `workflow has: ${tpl}`);
  }
});

test('pr-lint: the 79-character title that slipped through is caught; 72 passes', () => {
  const long = 'feat(p4): connect cost providers from Settings, DigitalOcean + GCP improvements';
  assert.equal(long.length, 79);
  assert.deepEqual(checkPr({ title: long }).errors, [['Title', 'is 79 characters long (max 72)']]);
  assert.deepEqual(checkPr({ title: 'feat(p4): connect cost providers in Settings; DO + GCP improvements' }).errors, []);
  assert.deepEqual(checkPr({ title: 'feat(ui): x', branch: 'feat/ui-x', body: GOOD_BODY }).errors, []);
});

test('pr-lint: an empty template body fails exactly like the workflow', () => {
  const template = readFileSync(path.join(ROOT, 'pull_request_template.md'), 'utf8');
  const { errors } = checkPr({ body: template });
  assert.deepEqual(errors, [
    ['Body', 'section `## Summary` is empty (write "N/A" if not applicable)'],
    ['Body', 'section `## How to test` is empty (write "N/A" if not applicable)'],
  ]);
});

test('repo overrides are read from the caller workflow `with:` (comments ignored)', () => {
  const caller = readFileSync(path.join(ROOT, 'workflow-templates/org-pr-convention.yml'), 'utf8');
  assert.deepEqual(repoInputs(caller), {}, 'template has only commented examples');
  const custom = caller.replace(/    # with:\n    #   ticket_pattern: '\[A-Z\]\[A-Z0-9_\]\+-\[0-9\]\+'.*\n/, "    with:\n      ticket_pattern: '[A-Z]+-[0-9]+'\n      title_max_length: 60\n      require_scope: true\n");
  assert.deepEqual(repoInputs(custom), { ticket_pattern: '[A-Z]+-[0-9]+', title_max_length: 60, require_scope: true });
  assert.deepEqual(checkPr({ title: 'feat: x' }, repoInputs(custom)).errors, [['Title', 'missing scope, e.g. `feat(auth): ...`']]);
});

// ---------- reading gh commands ----------
test('shellWords keeps quoted text and command substitutions together', () => {
  assert.deepEqual(shellWords(`gh pr create --title "feat(x): a \\"b\\"" -F 'my body.md'`), ['gh', 'pr', 'create', '--title', 'feat(x): a "b"', '-F', 'my body.md']);
  assert.deepEqual(shellWords('cd repo && gh pr edit 7 --body "$(cat <<EOF\nhi\nEOF\n)"'), ['cd', 'repo', '&', '&', 'gh', 'pr', 'edit', '7', '--body', '$(cat <<EOF\nhi\nEOF\n)']);
});

test('ghPrCalls finds create/edit anywhere in a command line', () => {
  const calls = ghPrCalls('cd x; gh pr create --base main --head feat/a --title="feat: a" --body-file b.md && gh pr edit 3 -t "fix: b"');
  assert.deepEqual(calls.map((c) => [c.action, c.title, c.bodyFile, c.head]), [
    ['create', 'feat: a', 'b.md', 'feat/a'],
    ['edit', 'fix: b', null, null],
  ]);
  assert.deepEqual(ghPrCalls('gh pr view 3 && gh pr list'), []);
  assert.deepEqual(ghPrCalls('gh pr create --fill')[0].fill, true);
  assert.deepEqual(ghPrCalls('gh pr create -t x -b "$(cat f)"')[0].opaque, ['body']);
});

// ---------- the Claude Code hook ----------
function repoDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-lint-'));
  execFileSync('git', ['init', '-q', '-b', 'feat/demo'], { cwd: dir });
  return dir;
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('hook blocks a too-long title with the reason, allows a valid PR, ignores other commands', () => {
  const dir = repoDir();
  writeFileSync(path.join(dir, 'pr.md'), GOOD_BODY);
  const bad = hookDecision(bash(`gh pr create --title "${'feat: '.padEnd(80, 'x')}" --body-file pr.md`), dir);
  assert.equal(bad.code, 2);
  assert.match(bad.message, /Title: is 80 characters long \(max 72\)/);
  assert.equal(hookDecision(bash('gh pr create --title "feat(demo): add x" --body-file pr.md'), dir).code, 0);
  assert.equal(hookDecision(bash('git status'), dir).code, 0);
  assert.equal(hookDecision({ tool_name: 'Edit', tool_input: { file_path: 'x' } }, dir).code, 0);
});

test('hook: create needs explicit title and body; --fill is refused; edit checks only what changes', () => {
  const dir = repoDir();
  assert.match(hookDecision(bash('gh pr create --fill'), dir).message, /--fill/);
  assert.match(hookDecision(bash('gh pr create --title "feat: x"'), dir).message, /--body-file/);
  assert.match(hookDecision(bash('gh pr create --title "feat: x" --body-file nope.md'), dir).message, /body file not found/);
  assert.equal(hookDecision(bash('gh pr edit 9 --title "fix(api): handle null"'), dir).code, 0);
  assert.equal(hookDecision(bash('gh pr edit 9 --body "## Summary\nx"'), dir).code, 2, 'missing How to test');
});

test('hook: branch name is checked from --head or the current git branch', () => {
  const dir = repoDir();
  writeFileSync(path.join(dir, 'pr.md'), GOOD_BODY);
  assert.match(hookDecision(bash('gh pr create -t "feat: x" -F pr.md --head Bad_Branch'), dir).message, /Branch: `Bad_Branch`/);
  execFileSync('git', ['checkout', '-q', '-b', 'random'], { cwd: dir });
  assert.match(hookDecision(bash('gh pr create -t "feat: x" -F pr.md'), dir).message, /Branch: `random`/);
});

test('CLI: --claude-hook exits 2 with the reason on stderr; bad stdin never blocks; plain mode exits 1', () => {
  const dir = repoDir();
  writeFileSync(path.join(dir, 'pr.md'), GOOD_BODY);
  const hook = (input) => spawnSync('node', [LINT, '--claude-hook'], { cwd: dir, input, encoding: 'utf8' });
  const blocked = hook(JSON.stringify(bash('gh pr create --title "Add stuff" --body-file pr.md')));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /does not match `type\(scope\): description`/);
  assert.equal(hook('not json').status, 0);
  const plain = spawnSync('node', [LINT, '--title', 'feat(demo): ok', '--body-file', 'pr.md'], { cwd: dir, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  const fail = spawnSync('node', [LINT, '--title', 'nope', '--body', 'x'], { cwd: dir, encoding: 'utf8' });
  assert.equal(fail.status, 1);
});

// ---------- merging into child repos ----------
test('mergeBlock appends to an existing AGENTS.md, replaces an old block, and is idempotent', () => {
  const next = '<!-- BEGIN:nextjs-agent-rules -->\nNext rules\n<!-- END:nextjs-agent-rules -->\n';
  const once = mergeBlock(next, 'v1 rules');
  assert.ok(once.startsWith(next.trim()));
  assert.ok(once.includes(`${BEGIN}\nv1 rules\n${END}`));
  assert.equal(mergeBlock(once, 'v1 rules'), once);
  const updated = mergeBlock(once, 'v2 rules');
  assert.ok(updated.includes('v2 rules') && !updated.includes('v1 rules') && updated.includes('Next rules'));
  assert.equal(mergeBlock(null, 'x'), `${BEGIN}\nx\n${END}\n`);
});

test('mergeClaudeSettings adds the hook once and keeps existing settings; invalid JSON is left alone', () => {
  const existing = JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] }] } });
  const merged = JSON.parse(mergeClaudeSettings(existing));
  assert.deepEqual(merged.permissions, { allow: ['Bash(pnpm test)'] });
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].command, HOOK_COMMAND);
  assert.equal(mergeClaudeSettings(JSON.stringify(merged, null, 2) + '\n'), JSON.stringify(merged, null, 2) + '\n');
  assert.equal(mergeClaudeSettings('{ nope'), null);
  const shipped = JSON.parse(readFileSync(path.join(ROOT, 'profiles/starter/agents/claude-settings.json'), 'utf8'));
  assert.equal(shipped.hooks.PreToolUse[0].hooks[0].command, HOOK_COMMAND, 'sample file matches the merged hook');
});

test('planAgentFiles: all five files for a bare repo, nothing when current, invalid settings reported', async () => {
  const bare = await planAgentFiles({});
  assert.deepEqual(bare.files.map((f) => f.path).sort(), ['.claude/settings.json', '.github/copilot-instructions.md', '.github/scripts/pr-lint.mjs', 'AGENTS.md', 'CLAUDE.md']);
  const claude = bare.files.find((f) => f.path === 'CLAUDE.md').content;
  assert.match(claude, /^@AGENTS\.md$/m, 'Claude Code imports AGENTS.md');
  const current = Object.fromEntries(bare.files.map((f) => [f.path, f.content]));
  assert.deepEqual((await planAgentFiles(current)).files, []);
  const broken = await planAgentFiles({ ...current, '.claude/settings.json': '{' });
  assert.deepEqual(broken.files, []);
  assert.match(broken.problems[0], /settings\.json is not valid JSON/);
});

test('AGENTS.md block states the same limits the checks enforce', async () => {
  const text = readFileSync(path.join(ROOT, 'profiles/starter/agents/AGENTS.block.md'), 'utf8');
  assert.match(text, new RegExp(`at most ${DEFAULTS.title_max_length} characters`));
  for (const t of DEFAULTS.title_types.split(',')) assert.ok(text.includes(`\`${t}\``), `title type ${t}`);
  for (const s of DEFAULTS.required_sections.split(',')) assert.ok(text.includes(`\`${s}\``), `section ${s}`);
  assert.match(text, /node \.github\/scripts\/pr-lint\.mjs/);
});

test('JS repos also get a .prettierignore block for the managed files (merged, idempotent)', async () => {
  const { files } = await planAgentFiles({ '.prettierignore': '.next\npnpm-lock.yaml\n' }, { js: true });
  const ignore = files.find((f) => f.path === '.prettierignore').content;
  assert.ok(ignore.startsWith('.next\npnpm-lock.yaml\n'), 'repo entries kept');
  for (const p of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.claude/settings.json', '.github/scripts/pr-lint.mjs']) {
    assert.match(ignore, new RegExp(`^${p.replace(/\./g, '\\.')}$`, 'm'), p);
  }
  const current = Object.fromEntries(files.map((f) => [f.path, f.content]));
  assert.deepEqual((await planAgentFiles(current, { js: true })).files, []);
  assert.ok(!(await planAgentFiles({})).files.some((f) => f.path === '.prettierignore'), 'non-JS repos: untouched');
});
