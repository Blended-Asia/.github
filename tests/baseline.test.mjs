// Existing repos: on PRs, checks that scan the whole repo must only block problems that are NEW relative to base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wf, between, runBlock, inputDefaults, gitRepo, bash, ROOT } from './helpers.mjs';
import { measure, renderDebt } from '../scripts/harness/debt.mjs';
import { resolveConfig } from '../scripts/harness/config.mjs';

const security = wf('security.yml');
const infra = wf('infra.yml');
const S = inputDefaults(security);
const I = inputDefaults(infra);

function py(code, env) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'py-')), 'x.py');
  writeFileSync(f, code);
  const r = spawnSync('python3', [f], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null', ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
function trivyDir(files) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rt-'));
  mkdirSync(path.join(tmp, 'trivy'));
  for (const [n, data] of Object.entries(files)) writeFileSync(path.join(tmp, 'trivy', n), JSON.stringify(data));
  return tmp;
}
const vuln = (pkg, id, ver = '1.0.0') => ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: ver, FixedVersion: '9.9.9', Severity: 'HIGH' });
const lock = (...vs) => ({ Results: [{ Target: 'package-lock.json', Vulnerabilities: vs }] });

test('Trivy CVE: PRs are only blocked by new CVEs; CVEs already on base only warn', () => {
  const code = between(security, 'trivy-vuln');
  const tmp = trivyDir({ 'head.json': lock(vuln('lodash', 'CVE-1'), vuln('axios', 'CVE-2')), 'base.json': lock(vuln('lodash', 'CVE-1')) });
  const r = py(code, { RUNNER_TEMP: tmp });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=package-lock\.json::CVE-2 HIGH axios/);
  assert.doesNotMatch(r.out, /::error.*CVE-1/);
  assert.match(r.out, /::warning::1 pre-existing vulnerability /);

  const onlyOld = trivyDir({ 'head.json': lock(vuln('lodash', 'CVE-1', '1.0.1')), 'base.json': lock(vuln('lodash', 'CVE-1')) });
  assert.equal(py(code, { RUNNER_TEMP: onlyOld }).code, 0, 'patch bump still hitting the old CVE → not a new finding');

  const noBase = trivyDir({ 'head.json': lock(vuln('lodash', 'CVE-1')) });
  assert.equal(py(code, { RUNNER_TEMP: noBase }).code, 1, 'push/schedule or fail_on=all: block every CVE');
});

test('Trivy misconfig: only blocks misconfigs new relative to base', () => {
  const code = between(infra, 'trivy-config');
  const mis = (id, t = 'Dockerfile') => ({ Target: t, Misconfigurations: [{ ID: id, Status: 'FAIL', Severity: 'HIGH', Title: id, CauseMetadata: { StartLine: 1 } }] });
  const tmp = trivyDir({ 'config-head.json': { Results: [mis('DS-0002'), mis('DS-0002', 'api/Dockerfile')] }, 'config-base.json': { Results: [mis('DS-0002')] } });
  const r = py(code, { RUNNER_TEMP: tmp });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=api\/Dockerfile,line=1,title=DS-0002/);
  assert.doesNotMatch(r.out, /::error file=Dockerfile,/);
});

test('Supabase Advisor: accepted debt (advisors_ignore) does not block; reports fixed keys', () => {
  const code = between(infra, 'advisors');
  const adv = (key, level = 'ERROR') => ({ name: 'rls_disabled_in_public', level, detail: `Table ${key}`, cacheKey: key, remediation: 'https://x' });
  const tmp = mkdtempSync(path.join(tmpdir(), 'adv-'));
  writeFileSync(path.join(tmp, 'advisors.json'), JSON.stringify({ results: [adv('rls_old'), adv('rls_new'), adv('w1', 'WARN')] }));
  const sum = path.join(tmp, 'sum.md');
  writeFileSync(sum, '');
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: tmp, IGNORE: 'rls_old, rls_fixed_already', FAIL_ON: I.advisors_fail_on, GITHUB_STEP_SUMMARY: sum } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=supabase rls_disabled_in_public::Table rls_new/);
  assert.doesNotMatch(r.stdout, /Table rls_old/);
  assert.match(r.stdout, /::warning title=supabase rls_disabled_in_public::Table w1/);
  const md = spawnSync('cat', [sum], { encoding: 'utf8' }).stdout;
  assert.match(md, /1 blocking, 1 warning\(s\), 1 accepted debt/);
  assert.match(md, /rls_new/);
  assert.match(md, /Fixed; remove from `advisors_ignore`: `rls_fixed_already`/);
  const none = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: tmp, IGNORE: '', FAIL_ON: 'none', GITHUB_STEP_SUMMARY: '/dev/null' } });
  assert.equal(none.status, 0, 'fail_on none → report only');
});

test('public var leaking a secret: PRs only check added lines; existing debt does not block', () => {
  const s = runBlock(security, 'Public variables must not have secret-like names');
  const repo = gitRepo({ 'src/old.ts': 'const a = process.env.NEXT_PUBLIC_OLD_SECRET;\n' });
  const base = repo.git('rev-parse', 'HEAD');
  repo.write({ 'src/feature.ts': 'export const f = 1;\n' });
  repo.commit('clean pr');
  const env = { PREFIXES: S.public_env_prefixes, BASE_SHA: base };
  assert.equal(bash(s, { cwd: repo.dir, env }).code, 0);
  repo.write({ 'src/feature.ts': 'export const f = 1;\nconst k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;\n' });
  repo.commit('pr leaking a secret');
  const r = bash(s, { cwd: repo.dir, env });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error file=src\/feature\.ts,line=2::/);
  assert.doesNotMatch(r.stdout, /old\.ts/);
  assert.equal(bash(s, { cwd: repo.dir, env: { PREFIXES: S.public_env_prefixes, BASE_SHA: '' } }).code, 1, 'no base → scan the whole repo');
});

test('migration names: old non-conforming migrations do not block new PRs', () => {
  const s = runBlock(infra, 'Migration conventions');
  const repo = gitRepo({ 'supabase/migrations/20250101000000_Init-Schema.sql': 'x' });
  const base = repo.git('rev-parse', 'HEAD');
  repo.write({ 'supabase/migrations/20261001000000_add_posts.sql': 'y' });
  repo.commit('pr');
  const env = { PATTERN: I.migration_name_pattern, IMMUTABLE: 'true', ORDER: 'true', DIR: '.', BASE_SHA: base };
  assert.equal(bash(s, { cwd: repo.dir, env }).code, 0);
  assert.equal(bash(s, { cwd: repo.dir, env: { ...env, BASE_SHA: '' } }).code, 1, 'a full scan on push still reports it');
});

// ---------- debt.mjs + severity override ----------

test('debt: counts violations per rule, suggests downgrading/disabling, finds env files and missing config', () => {
  const views = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`api/app/views/p/v${i}.html.erb`, '<% User.all.each do |u| %>\n']));
  const repo = gitRepo({
    'api/config/application.rb': 'module A; end\n',
    'api/Gemfile': 'gem "rails"\n',
    'api/app/models/user.rb': 'class User\n  def x = params[:a]\nend\n',
    ...views,
    'web/package.json': '{"dependencies":{"next":"16"}}',
    'web/eslint.config.mjs': 'export default []',
    'web/.env.local': 'SECRET=1',
    'supabase/migrations/2025_Init.sql': 'x',
  });
  const d = measure({ root: repo.dir, harnessDir: ROOT });
  const byId = Object.fromEntries(d.rules.map((r) => [r.id, r]));
  assert.equal(byId['rails/view-no-query'].count, 31);
  assert.match(byId['rails/view-no-query'].suggest, /^review/);
  assert.equal(byId['rails/model-no-params'].count, 1);
  assert.match(byId['rails/model-no-params'].suggest, /^keep: existing debt does not block PRs/);
  assert.deepEqual(d.suggestion.review, [{ id: 'rails/view-no-query', count: 31 }]);
  assert.deepEqual(d.envFiles, ['web/.env.local']);
  assert.equal(d.badMigrations.length, 1);
  assert.ok(d.missing.some((m) => /api: no \.rubocop\.yml yet/.test(m)));
  assert.ok(!d.missing.some((m) => /web: no ESLint config yet/.test(m)));
  const md = renderDebt(d);
  assert.match(md, /🔴 Fix before enabling/);
  assert.match(md, /enforcement: observe/);
  assert.match(md, /#   rails\/view-no-query \(31 existing violations\)/);
  assert.doesNotMatch(md, /^\s*disable:/m, 'never suggests disabling a rule on its own');
});

test('architecture.severity downgrades a default rule; invalid values are reported', () => {
  const ok = gitRepo({ '.github/harness.yml': 'profiles: [rails]\narchitecture:\n  severity:\n    rails/model-no-http: warn\n' });
  const cfg = resolveConfig({ root: ok.dir, harnessDir: ROOT, files: [] });
  assert.equal(cfg.rules.find((r) => r.id === 'rails/model-no-http').severity, 'warn');
  const bad = gitRepo({ '.github/harness.yml': 'profiles: [rails]\narchitecture:\n  severity:\n    rails/model-no-http: block\n' });
  assert.throws(() => resolveConfig({ root: bad.dir, harnessDir: ROOT, files: [] }), /severity must be error\|warn/);
});

test('Trivy: counts occurrences — a second copy of the same CVE/misconfig is still new', () => {
  const vcode = between(security, 'trivy-vuln');
  const two = trivyDir({ 'head.json': lock(vuln('lodash', 'CVE-1'), vuln('lodash', 'CVE-1', '2.0.0')), 'base.json': lock(vuln('lodash', 'CVE-1')) });
  const r = py(vcode, { RUNNER_TEMP: two });
  assert.equal(r.code, 1);
  assert.equal((r.out.match(/::error/g) ?? []).length, 1);

  const ccode = between(infra, 'trivy-config');
  const bucket = (res) => ({ ID: 'AVD-AWS-0086', Status: 'FAIL', Severity: 'HIGH', Title: 'public bucket', CauseMetadata: { StartLine: 1, Resource: res } });
  const tf = trivyDir({
    'config-head.json': { Results: [{ Target: 'main.tf', Misconfigurations: [bucket('aws_s3_bucket.a'), bucket('aws_s3_bucket.b')] }] },
    'config-base.json': { Results: [{ Target: 'main.tf', Misconfigurations: [bucket('aws_s3_bucket.a')] }] },
  });
  const rc = py(ccode, { RUNNER_TEMP: tf });
  assert.equal(rc.code, 1, 'a second public bucket in the same file must be blocked');
});

test('Hadolint: existing Dockerfiles are only blocked by new errors (counting occurrences)', () => {
  const code = between(infra, 'hadolint');
  const tmp = mkdtempSync(path.join(tmpdir(), 'hl-'));
  mkdirSync(path.join(tmp, 'hadolint'));
  const i = (file, code, line, level = 'error') => ({ file, code, line, level, message: code });
  writeFileSync(path.join(tmp, 'hadolint/head.json'), JSON.stringify([i('Dockerfile', 'DL3007', 1), i('Dockerfile', 'DL3007', 5), i('Dockerfile', 'DL3015', 2, 'info')]));
  writeFileSync(path.join(tmp, 'hadolint/base.json'), JSON.stringify([i('Dockerfile', 'DL3007', 1)]));
  const r = py(code, { RUNNER_TEMP: tmp, THRESHOLD: I.hadolint_threshold });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=Dockerfile,line=5,title=DL3007/);
  assert.doesNotMatch(r.out, /line=1,title=DL3007/);
  assert.match(r.out, /::warning file=Dockerfile,line=2,title=DL3015/);
  writeFileSync(path.join(tmp, 'hadolint/head.json'), JSON.stringify([i('Dockerfile', 'DL3007', 3)]));
  assert.equal(py(code, { RUNNER_TEMP: tmp, THRESHOLD: 'error' }).code, 0, 'an old error moved to another line is still old');
});

const hasCompose = spawnSync('docker', ['compose', 'version']).status === 0;
test('Compose: existing files are only blocked by issues new relative to base', { skip: !hasCompose && 'docker compose not available' }, () => {
  const code = between(infra, 'compose-policy');
  const legacy = 'services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n';
  const base = gitRepo({ 'docker-compose.yml': legacy });
  const head = gitRepo({ 'docker-compose.yml': `${legacy}  tool:\n    image: busybox:1\n    privileged: true\n` });
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'cp-')), 'p.py');
  writeFileSync(f, code);
  const run = (env) => spawnSync('python3', [f], { cwd: head.dir, encoding: 'utf8', env: { ...process.env, COMPOSE_FILES: 'docker-compose.yml', DEV_FILES: I.compose_dev_files, DB_PORTS: I.compose_db_ports, GITHUB_STEP_SUMMARY: '/dev/null', ...env } });
  const r = run({ BASE_DIR: base.dir });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /`tool`: privileged/);
  assert.doesNotMatch(r.stdout, /::error.*5432->5432/);
  assert.match(r.stdout, /1 pre-existing issue\(s\) from base/);
  const all = run({ BASE_DIR: '' });
  assert.match(all.stdout, /::error.*5432->5432/, 'no base → report everything');
});

test('debt: never suggests disabling/downgrading security rules, even with many existing violations', () => {
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`app/c${i}.tsx`, "'use client';\nconst k = process.env.SERVICE_ROLE_KEY;\n"]));
  const repo = gitRepo({ 'package.json': '{"dependencies":{"next":"16"}}', ...files });
  const d = measure({ root: repo.dir, harnessDir: ROOT });
  const r = d.rules.find((x) => x.id === 'react/client-no-server-code');
  assert.equal(r.count, 40);
  assert.equal(r.security, true);
  assert.match(r.suggest, /security rule/);
  assert.deepEqual(d.suggestion.review, []);
});

test('security rules cannot be disabled/downgraded from harness.yml', () => {
  const repo = gitRepo({ '.github/harness.yml': 'profiles: [react]\narchitecture:\n  disable: [react/client-no-server-code, react/no-ts-ignore]\n  severity:\n    react/no-dangerous-html: warn\n' });
  const cfg = resolveConfig({ root: repo.dir, harnessDir: ROOT, files: [] });
  const ids = cfg.rules.map((r) => r.id);
  assert.ok(ids.includes('react/client-no-server-code'), 'cannot be disabled');
  assert.ok(!ids.includes('react/no-ts-ignore'), 'regular rules can be disabled');
  assert.equal(cfg.rules.find((r) => r.id === 'react/client-no-server-code').severity, 'error');
  assert.equal(cfg.notices.length, 2, 'both disabling and downgrading a security rule are ignored and reported');
  assert.ok(cfg.notices.some((n) => /react\/client-no-server-code/.test(n)));
  assert.ok(cfg.notices.some((n) => /react\/no-dangerous-html/.test(n)));
});
