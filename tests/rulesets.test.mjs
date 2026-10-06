import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const apply = (args, env = {}) => {
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/apply-ruleset.sh'), ...args], { encoding: 'utf8', env: { ...process.env, DRY_RUN: 'true', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};
const prParams = (rs) => rs.rules.find((r) => r.type === 'pull_request').parameters;
const checks = (rs) => rs.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);

test('4 ruleset nhóm: đúng nhánh, approve theo team/solo, cho phép squash + merge, cùng required checks', () => {
  const base = JSON.parse(readFileSync(path.join(ROOT, 'rulesets/org-baseline.json'), 'utf8'));
  for (const [kind, ref, approvals] of [
    ['trunk-team', '~DEFAULT_BRANCH', 1], ['trunk-solo', '~DEFAULT_BRANCH', 0],
    ['gitflow-team', 'refs/heads/develop', 1], ['gitflow-solo', 'refs/heads/develop', 0],
  ]) {
    const { code, json } = apply(['acme', kind, 'active'], { REPOS: 'web, api' });
    assert.equal(code, 0, kind);
    assert.equal(json.name, `org-${kind}`);
    assert.deepEqual(json.conditions.ref_name.include, [ref]);
    assert.deepEqual(json.conditions.repository_name.include, ['web', 'api']);
    assert.ok(json.conditions.repository_name.exclude.includes('.github'));
    const p = prParams(json);
    assert.equal(p.required_approving_review_count, approvals, kind);
    assert.equal(p.require_code_owner_review, approvals > 0);
    assert.deepEqual(p.allowed_merge_methods, ['squash', 'merge']);
    assert.deepEqual(checks(json), checks(base));
    assert.ok(json.rules.some((r) => r.type === 'non_fast_forward') && json.rules.some((r) => r.type === 'deletion'));
  }
});

test('apply-ruleset: ruleset nhóm thiếu REPOS → dừng; BRANCHES ghi đè; enforcement; kiểu lạ → lỗi; cách gọi cũ vẫn chạy', () => {
  const none = apply(['acme', 'gitflow-team']);
  assert.equal(none.code, 2);
  assert.match(none.err, /chưa có repo nào/);
  const br = apply(['acme', 'gitflow-team', 'disabled'], { REPOS: 'web', BRANCHES: 'refs/heads/develop,refs/heads/release/*' });
  assert.deepEqual(br.json.conditions.ref_name.include, ['refs/heads/develop', 'refs/heads/release/*']);
  assert.equal(br.json.enforcement, 'disabled');
  assert.equal(apply(['acme', 'bogus']).code, 2);
  const old = apply(['acme', 'team'], { SOLO: 'true' });
  assert.equal(old.json.name, 'org-baseline');
  assert.deepEqual(old.json.conditions.repository_name.include, ['~ALL']);
  assert.equal(prParams(old.json).required_approving_review_count, 0);
});
