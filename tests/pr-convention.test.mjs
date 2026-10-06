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
    title: 'feat(auth): thêm đăng nhập Google',
    body: '## Summary\nThêm OAuth Google\n\n## How to test\n1. Mở /login\n',
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

test('defaults đọc được từ workflow', () => {
  assert.equal(DEFAULTS.title_max_length, 72);
  assert.equal(DEFAULTS.size_mode, 'warn');
  assert.ok(new RegExp(DEFAULTS.branch_pattern).test('fix/abc-1'));
});

test('PR đúng chuẩn: pass, không comment, gắn size/XS', async () => {
  const log = await run({ pr: makePr() });
  assert.equal(log.failed, null);
  assert.equal(log.created.length, 0);
  assert.deepEqual(log.labelsAdded, ['size/XS']);
});

test('title/branch/section sai → fail và comment liệt kê lỗi', async () => {
  const log = await run({ pr: makePr({ title: 'Update stuff', head: { ref: 'thao-dev' }, body: '## Summary\n<!-- điền vào -->\n' }) });
  assert.match(log.failed, /4 lỗi/); // title, branch, Summary trống, thiếu How to test
  assert.equal(log.created.length, 1);
  assert.match(log.created[0], /^<!-- org-pr-convention -->/);
  assert.match(log.created[0], /Title/);
  assert.match(log.created[0], /Branch/);
  assert.match(log.created[0], /How to test/);
});

test('type không hợp lệ và section trống (chỉ có comment template)', async () => {
  const log = await run({ pr: makePr({ title: 'feature: x', body: '## Summary\nabc\n## How to test\n<!-- steps -->\n' }) });
  assert.ok(log.errors.some((e) => /type `feature`/.test(e)));
  assert.ok(log.errors.some((e) => /How to test` đang trống/.test(e)));
});

test('draft: báo lỗi nhưng không chặn', async () => {
  const log = await run({ pr: makePr({ draft: true, title: 'wip' }) });
  assert.equal(log.failed, null);
  assert.match(log.created[0], /draft/);
});

test('PR của bot được bỏ qua', async () => {
  const log = await run({ pr: makePr({ title: 'Bump x from 1 to 2', user: { login: 'dependabot[bot]', type: 'Bot' } }) });
  assert.equal(log.failed, null);
  assert.equal(log.labelsAdded.length, 0);
});

test('merge_group không có PR payload → pass', async () => {
  const log = await run({ pr: null, eventName: 'merge_group' });
  assert.equal(log.failed, null);
});

test('lockfile không tính vào size', async () => {
  const files = [
    { filename: 'pnpm-lock.yaml', additions: 9000, deletions: 100 },
    { filename: 'apps/web/src/lib/generated/api.ts', additions: 3000, deletions: 0 },
    { filename: 'src/x.ts', additions: 20, deletions: 3 },
  ];
  const log = await run({ pr: makePr({ additions: 12120, deletions: 103 }), files });
  assert.deepEqual(log.labelsAdded, ['size/XS']);
  assert.equal(log.warnings.length, 0);
});

test('PR quá lớn: warn mặc định, fail khi size_mode=fail; đổi label size cũ', async () => {
  const files = [{ filename: 'src/big.ts', additions: 900, deletions: 50 }];
  const pr = makePr({ labels: [{ name: 'size/S' }] });
  const warn = await run({ pr, files });
  assert.equal(warn.failed, null);
  assert.ok(warn.warnings.some((w) => /950 dòng/.test(w)));
  assert.deepEqual(warn.labelsRemoved, ['size/S']);
  assert.deepEqual(warn.labelsAdded, ['size/L']);
  const fail = await run({ pr, files, inputs: { size_mode: 'fail' } });
  assert.match(fail.failed, /1 lỗi/);
});

test('ticket bắt buộc: tìm thấy trong branch thì pass', async () => {
  const inputs = { ticket_pattern: '[A-Z][A-Z0-9_]+-[0-9]+', branch_pattern: '' };
  assert.match((await run({ pr: makePr(), inputs })).failed, /1 lỗi/);
  assert.equal((await run({ pr: makePr({ head: { ref: 'feat/WEB-123-login' } }), inputs })).failed, null);
});

test('scope bắt buộc + allowed_scopes', async () => {
  const inputs = { require_scope: true, allowed_scopes: 'api,web' };
  const log = await run({ pr: makePr({ title: 'feat(auth): x' }), inputs });
  assert.ok(log.errors.some((e) => /scope `auth`/.test(e)));
  assert.match((await run({ pr: makePr({ title: 'fix: x' }), inputs })).failed, /1 lỗi/);
});

test('check_commits bắt commit sai format, bỏ qua Merge', async () => {
  const commits = [{ commit: { message: 'feat: ok' } }, { commit: { message: 'Merge branch main' } }, { commit: { message: 'sửa lỗi' } }];
  const log = await run({ pr: makePr(), commits, inputs: { check_commits: true } });
  assert.ok(log.errors.some((e) => /1 commit sai format.*sửa lỗi/.test(e)));
});

test('đã có comment lỗi, sửa xong → cập nhật thành ✅', async () => {
  const comments = [{ id: 1, body: '<!-- org-pr-convention -->\n### ❌ cũ' }];
  const log = await run({ pr: makePr(), comments });
  assert.equal(log.created.length, 0);
  assert.match(log.updated[0], /✅ PR convention: đạt/);
});

test('không có quyền ghi (PR từ fork) vẫn chạy được', async () => {
  const pr = makePr({ title: 'bad' });
  const log = await run({ pr, comments: [] });
  assert.ok(log.failed);
});

test('re-run một run cũ (payload cũ hợp lệ) vẫn đọc PR hiện tại → fail', async () => {
  const stale = makePr({ draft: true });
  const live = makePr({ draft: false, title: 'oops' });
  const log = await run({ pr: stale, live });
  assert.match(log.failed, /1 lỗi/);
});

test('gate.branches: base ngoài danh sách → bỏ qua, không comment; mặc định = default branch', async () => {
  const bad = { title: 'Update stuff', base: { ref: 'main' } };
  process.env.GATE_BRANCHES = '["develop"]';
  try {
    const skipped = await run({ pr: makePr(bad) });
    assert.equal(skipped.failed, null);
    assert.equal(skipped.created.length, 0);
    assert.deepEqual(skipped.labelsAdded, []);
    assert.match(skipped.summary, /bỏ qua/);
    const gated = await run({ pr: makePr({ ...bad, base: { ref: 'develop' } }) });
    assert.match(gated.failed, /lỗi/);
    process.env.GATE_BRANCHES = '["release/*"]';
    assert.match((await run({ pr: makePr({ ...bad, base: { ref: 'release/2.0' } }) })).failed, /lỗi/);
    assert.equal((await run({ pr: makePr({ ...bad, base: { ref: 'release/2.0/x' } }) })).failed, null, '* không vượt qua /');
  } finally {
    delete process.env.GATE_BRANCHES;
  }
  const noCfg = await run({ pr: makePr({ ...bad, base: { ref: 'main' } }) });
  assert.match(noCfg.failed, /lỗi/, 'không có config và không biết default branch → vẫn gate');
});

test('step "Nhánh được gate": đọc gate.branches từ harness.yml ở base qua gh api; thiếu file/YAML lỗi → []', async () => {
  const { runBlock, bash } = await import('./helpers.mjs');
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const s = runBlock(text, 'Nhánh được gate');
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
  assert.equal(bash(s, { env: withGh("printf 'gate:\\n  branches: develop\\n'") }).outputs.branches, '[]', 'không phải mảng → bỏ');
});
