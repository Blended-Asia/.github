import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wf, between, inputDefaults } from './helpers.mjs';

const text = wf('pr-convention.yml');
const script = between(text, 'org-pr-convention');
const DEFAULTS = inputDefaults(text);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function makePr(over = {}) {
  return {
    number: 7,
    title: 'feat(auth): add Google sign-in',
    body: '## Summary\nAdd Google OAuth\n\n## How to test\n1. Open /login\n',
    draft: false,
    user: { login: 'thao', type: 'User' },
    head: { ref: 'feat/google-login' },
    labels: [],
    additions: 30,
    deletions: 5,
    ...over,
  };
}

async function run({ pr, live, inputs = {}, files, commits = [], comments = [], eventName = 'pull_request' }) {
  const log = { failed: null, errors: [], warnings: [], created: [], updated: [], labelsAdded: [], labelsRemoved: [], summary: '' };
  const core = {
    info() {},
    warning: (m) => log.warnings.push(m),
    error: (m) => log.errors.push(m),
    setFailed: (m) => { log.failed = m; },
    summary: { addRaw(s) { log.summary += s; return this; }, async write() {} },
  };
  const rest = {
    pulls: {
      get: async () => ({ data: live ?? pr }),
      listFiles: async () => files ?? [{ filename: 'src/a.ts', additions: pr?.additions ?? 0, deletions: pr?.deletions ?? 0 }],
      listCommits: async () => commits,
    },
    issues: {
      listComments: async () => comments,
      createComment: async ({ body }) => log.created.push(body),
      updateComment: async ({ body }) => log.updated.push(body),
      addLabels: async ({ labels }) => log.labelsAdded.push(...labels),
      removeLabel: async ({ name }) => log.labelsRemoved.push(name),
    },
  };
  const github = { rest, paginate: async (fn, params) => fn(params) };
  const context = { eventName, payload: pr ? { pull_request: pr } : {}, repo: { owner: 'acme', repo: 'web' } };
  process.env.INPUTS = JSON.stringify({ ...DEFAULTS, ...inputs });
  await new AsyncFunction('context', 'core', 'github', script)(context, core, github);
  return log;
}

test('defaults are readable from the workflow', () => {
  assert.equal(DEFAULTS.title_max_length, 72);
  assert.equal(DEFAULTS.size_mode, 'warn');
  assert.ok(new RegExp(DEFAULTS.branch_pattern).test('fix/abc-1'));
});

test('compliant PR: passes, no comment, labeled size/XS', async () => {
  const log = await run({ pr: makePr() });
  assert.equal(log.failed, null);
  assert.equal(log.created.length, 0);
  assert.deepEqual(log.labelsAdded, ['size/XS']);
});

test('bad title/branch/section → fails and comments listing the errors', async () => {
  const log = await run({ pr: makePr({ title: 'Update stuff', head: { ref: 'thao-dev' }, body: '## Summary\n<!-- fill in -->\n' }) });
  assert.match(log.failed, /4 errors/); // title, branch, empty Summary, missing How to test
  assert.equal(log.created.length, 1);
  assert.match(log.created[0], /^<!-- org-pr-convention -->/);
  assert.match(log.created[0], /Title/);
  assert.match(log.created[0], /Branch/);
  assert.match(log.created[0], /How to test/);
});

test('invalid type and empty section (template comment only)', async () => {
  const log = await run({ pr: makePr({ title: 'feature: x', body: '## Summary\nabc\n## How to test\n<!-- steps -->\n' }) });
  assert.ok(log.errors.some((e) => /type `feature`/.test(e)));
  assert.ok(log.errors.some((e) => /How to test` is empty/.test(e)));
});

test('draft: reports errors but does not block', async () => {
  const log = await run({ pr: makePr({ draft: true, title: 'wip' }) });
  assert.equal(log.failed, null);
  assert.match(log.created[0], /draft/);
});

test('bot PRs are skipped', async () => {
  const log = await run({ pr: makePr({ title: 'Bump x from 1 to 2', user: { login: 'dependabot[bot]', type: 'Bot' } }) });
  assert.equal(log.failed, null);
  assert.equal(log.labelsAdded.length, 0);
});

test('merge_group without a PR payload → pass', async () => {
  const log = await run({ pr: null, eventName: 'merge_group' });
  assert.equal(log.failed, null);
});

test('lockfiles do not count toward size', async () => {
  const files = [
    { filename: 'pnpm-lock.yaml', additions: 9000, deletions: 100 },
    { filename: 'apps/web/src/lib/generated/api.ts', additions: 3000, deletions: 0 },
    { filename: 'src/x.ts', additions: 20, deletions: 3 },
  ];
  const log = await run({ pr: makePr({ additions: 12120, deletions: 103 }), files });
  assert.deepEqual(log.labelsAdded, ['size/XS']);
  assert.equal(log.warnings.length, 0);
});

test('oversized PR: warns by default, fails with size_mode=fail; replaces the old size label', async () => {
  const files = [{ filename: 'src/big.ts', additions: 900, deletions: 50 }];
  const pr = makePr({ labels: [{ name: 'size/S' }] });
  const warn = await run({ pr, files });
  assert.equal(warn.failed, null);
  assert.ok(warn.warnings.some((w) => /950 lines/.test(w)));
  assert.deepEqual(warn.labelsRemoved, ['size/S']);
  assert.deepEqual(warn.labelsAdded, ['size/L']);
  const fail = await run({ pr, files, inputs: { size_mode: 'fail' } });
  assert.match(fail.failed, /1 error\b/);
});

test('required ticket: passes when found in the branch', async () => {
  const inputs = { ticket_pattern: '[A-Z][A-Z0-9_]+-[0-9]+', branch_pattern: '' };
  assert.match((await run({ pr: makePr(), inputs })).failed, /1 error\b/);
  assert.equal((await run({ pr: makePr({ head: { ref: 'feat/WEB-123-login' } }), inputs })).failed, null);
});

test('required scope + allowed_scopes', async () => {
  const inputs = { require_scope: true, allowed_scopes: 'api,web' };
  const log = await run({ pr: makePr({ title: 'feat(auth): x' }), inputs });
  assert.ok(log.errors.some((e) => /scope `auth`/.test(e)));
  assert.match((await run({ pr: makePr({ title: 'fix: x' }), inputs })).failed, /1 error\b/);
});

test('check_commits catches badly formatted commits, ignores Merge', async () => {
  const commits = [{ commit: { message: 'feat: ok' } }, { commit: { message: 'Merge branch main' } }, { commit: { message: 'fixed stuff' } }];
  const log = await run({ pr: makePr(), commits, inputs: { check_commits: true } });
  assert.ok(log.errors.some((e) => /1 commit with a bad format.*fixed stuff/.test(e)));
});

test('existing error comment, once fixed → updated to ✅', async () => {
  const comments = [{ id: 1, body: '<!-- org-pr-convention -->\n### ❌ old' }];
  const log = await run({ pr: makePr(), comments });
  assert.equal(log.created.length, 0);
  assert.match(log.updated[0], /✅ PR convention: passed/);
});

test('still runs without write access (fork PR)', async () => {
  const pr = makePr({ title: 'bad' });
  const log = await run({ pr, comments: [] });
  assert.ok(log.failed);
});

test('re-running an old run (valid stale payload) still reads the current PR → fail', async () => {
  const stale = makePr({ draft: true });
  const live = makePr({ draft: false, title: 'oops' });
  const log = await run({ pr: stale, live });
  assert.match(log.failed, /1 error\b/);
});

test('gate.branches: base not in the list → skipped, no comment; default = default branch', async () => {
  const bad = { title: 'Update stuff', base: { ref: 'main' } };
  process.env.GATE_BRANCHES = '["develop"]';
  try {
    const skipped = await run({ pr: makePr(bad) });
    assert.equal(skipped.failed, null);
    assert.equal(skipped.created.length, 0);
    assert.deepEqual(skipped.labelsAdded, []);
    assert.match(skipped.summary, /skipped/);
    const gated = await run({ pr: makePr({ ...bad, base: { ref: 'develop' } }) });
    assert.match(gated.failed, /error/);
    process.env.GATE_BRANCHES = '["release/*"]';
    assert.match((await run({ pr: makePr({ ...bad, base: { ref: 'release/2.0' } }) })).failed, /error/);
    assert.equal((await run({ pr: makePr({ ...bad, base: { ref: 'release/2.0/x' } }) })).failed, null, '* does not cross /');
  } finally {
    delete process.env.GATE_BRANCHES;
  }
  const noCfg = await run({ pr: makePr({ ...bad, base: { ref: 'main' } }) });
  assert.match(noCfg.failed, /error/, 'no config and unknown default branch → still gated');
});

test('step "Gated branches": reads gate.branches from harness.yml at base via gh api; missing file/bad YAML → []', async () => {
  const { runBlock, bash } = await import('./helpers.mjs');
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const s = runBlock(text, 'Gated branches');
  const withGh = (body) => {
    const bin = mkdtempSync(path.join(tmpdir(), 'ghshim-'));
    writeFileSync(path.join(bin, 'gh'), `#!/bin/bash\necho "$@" > "${bin}/args"\n${body}\n`);
    chmodSync(path.join(bin, 'gh'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}`, REPO: 'acme/web', BASE_SHA: 'abc123', CONFIG_PATH: '.github/harness.yml' };
  };
  const ok = bash(s, { env: withGh("printf 'enforcement: observe\\ngate:\\n  branches: [develop, \"release/*\"]\\n'") });
  assert.equal(ok.code, 0);
  assert.equal(ok.outputs.branches, '["develop","release/*"]');
  assert.equal(bash(s, { env: withGh('echo "Not Found" >&2; exit 1') }).outputs.branches, '[]');
  assert.equal(bash(s, { env: withGh("printf 'gate: [oops'") }).outputs.branches, '[]');
  assert.equal(bash(s, { env: withGh("printf 'gate:\\n  branches: develop\\n'") }).outputs.branches, '[]', 'not an array → ignored');
});
