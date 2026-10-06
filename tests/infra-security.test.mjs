import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wf, runBlock, between, inputDefaults, gitRepo, bash, ROOT } from './helpers.mjs';

const infra = wf('infra.yml');
const security = wf('security.yml');
const I = inputDefaults(infra);
const S = inputDefaults(security);

// ---------- detect ----------
test('detect: finds docker/vercel/supabase (including monorepos)', () => {
  const repo = gitRepo({
    'apps/api/Dockerfile': 'FROM node:22\n',
    'apps/web/vercel.json': '{}',
    'supabase/config.toml': '',
    'services/billing/supabase/config.toml': '',
  });
  const r = bash(runBlock(infra, 'id: d'), { cwd: repo.dir, env: { STACKS: 'auto' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.outputs.docker, 'true');
  assert.equal(r.outputs.vercel, 'true');
  assert.equal(r.outputs.supabase, 'true');
  assert.deepEqual(JSON.parse(r.outputs.supabase_dirs).sort(), ['.', 'services/billing']);
});

test('detect: repo with no stacks', () => {
  const repo = gitRepo({ 'README.md': '# hi' });
  const r = bash(runBlock(infra, 'id: d'), { cwd: repo.dir, env: { STACKS: 'auto' } });
  assert.deepEqual([r.outputs.docker, r.outputs.vercel, r.outputs.supabase, r.outputs.supabase_dirs], ['false', 'false', 'false', '[]']);
});

test('detect: a fixed stacks list overrides auto', () => {
  const repo = gitRepo({ 'Dockerfile': 'FROM x\n' });
  const r = bash(runBlock(infra, 'id: d'), { cwd: repo.dir, env: { STACKS: 'supabase' } });
  assert.deepEqual([r.outputs.docker, r.outputs.supabase, r.outputs.supabase_dirs], ['false', 'true', '["."]']);
});

// ---------- supabase migrations ----------
function migRepo() {
  const repo = gitRepo({
    'supabase/config.toml': '',
    'supabase/migrations/20260901000000_init.sql': 'create table a();',
    'supabase/migrations/20260910000000_add_b.sql': 'create table b();',
  });
  return { ...repo, base: repo.git('rev-parse', 'HEAD') };
}
const migEnv = (base) => ({ PATTERN: I.migration_name_pattern, IMMUTABLE: 'true', ORDER: 'true', DIR: '.', BASE_SHA: base });
const migScript = runBlock(infra, 'Migration conventions');

test('valid migration → pass', () => {
  const repo = migRepo();
  repo.write({ 'supabase/migrations/20261001000000_add_c.sql': 'create table c();' });
  repo.commit('pr');
  const r = bash(migScript, { cwd: repo.dir, env: migEnv(repo.base) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('edited old migration, out-of-order migration, bad name → fails with all 3 errors', () => {
  const repo = migRepo();
  repo.write({
    'supabase/migrations/20260901000000_init.sql': 'create table a(id int);',
    'supabase/migrations/20260905000000_late.sql': 'select 1;',
    'supabase/migrations/20261001000000_Add-Thing.sql': 'select 1;',
  });
  repo.commit('pr');
  const r = bash(migScript, { cwd: repo.dir, env: migEnv(repo.base) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /20260901000000_init\.sql::Migrations already on the base branch/);
  assert.match(r.stdout, /20260905000000_late\.sql::Timestamp 20260905000000 <= .*20260910000000/);
  assert.match(r.stdout, /Add-Thing\.sql' does not match/);
});

test('migration in a monorepo: annotation includes the directory prefix', () => {
  const repo = gitRepo({ 'services/db/supabase/migrations/20260901000000_init.sql': 'x' });
  const base = repo.git('rev-parse', 'HEAD');
  repo.write({ 'services/db/supabase/migrations/20260901000000_init.sql': 'y' });
  repo.commit('pr');
  const r = bash(migScript, { cwd: path.join(repo.dir, 'services/db'), env: { ...migEnv(base), DIR: 'services/db' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /file=services\/db\/supabase\/migrations\/20260901000000_init\.sql/);
});

test('push/schedule (no BASE_SHA) only checks names', () => {
  const repo = migRepo();
  const r = bash(migScript, { cwd: repo.dir, env: migEnv('') });
  assert.equal(r.code, 0, r.stdout);
});

test('Need a DB? only when the PR touches supabase/', () => {
  const repo = migRepo();
  repo.write({ 'src/app.ts': 'x' });
  repo.commit('code only');
  const s = runBlock(infra, 'Need a DB?');
  assert.equal(bash(s, { cwd: repo.dir, env: { MODE: 'changed', BASE_SHA: repo.base } }).outputs.run, 'false');
  repo.write({ 'supabase/seed.sql': 'insert 1' });
  repo.commit('seed');
  assert.equal(bash(s, { cwd: repo.dir, env: { MODE: 'changed', BASE_SHA: repo.base } }).outputs.run, 'true');
  assert.equal(bash(s, { cwd: repo.dir, env: { MODE: 'changed', BASE_SHA: '' } }).outputs.run, 'true');
  assert.equal(bash(s, { cwd: repo.dir, env: { MODE: 'never', BASE_SHA: '' } }).outputs.run, 'false');
});

// ---------- compose policy ----------
const composePy = between(infra, 'compose-policy');
function compose(files) {
  const repo = gitRepo(files);
  const py = path.join(mkdtempSync(path.join(tmpdir(), 'py-')), 'p.py');
  writeFileSync(py, composePy);
  const r = spawnSync('python3', [py], {
    cwd: repo.dir, encoding: 'utf8',
    env: { ...process.env, COMPOSE_FILES: Object.keys(files).join(' '), DEV_FILES: I.compose_dev_files, DB_PORTS: I.compose_db_ports, GITHUB_STEP_SUMMARY: '/dev/null' },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const hasCompose = spawnSync('docker', ['compose', 'version']).status === 0;

test('compose: catches public DB ports, privileged, hardcoded secrets; allows 127.0.0.1 and ${VAR}', { skip: !hasCompose && 'docker compose not available' }, () => {
  const r = compose({
    'docker-compose.yml': `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      API_TOKEN: \${API_TOKEN}
    ports: ["5432:5432", "127.0.0.1:6379:6379"]
    privileged: true
  app:
    build: .
    ports: ["3000:3000"]
`,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error file=docker-compose\.yml::`db`: publish 5432->5432/);
  assert.match(r.out, /::error .*`db`: privileged/);
  assert.match(r.out, /::error .*POSTGRES_PASSWORD` hardcode/);
  assert.doesNotMatch(r.out, /6379->6379|API_TOKEN|3000/);
});

test('compose: ports with ${VAR:-x} and list-style environment do not crash', { skip: !hasCompose && 'docker compose not available' }, () => {
  const r = compose({
    'compose.yml': `services:
  db:
    image: postgres:16
    ports: ["\${DB_PORT:-5432}:5432", "\${BIND:-127.0.0.1}:6379:6379", "8080"]
    environment:
      - POSTGRES_PASSWORD=supersecret
      - JWT_SECRET=\${JWT_SECRET}
      - DEBUG
`,
  });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /Traceback/);
  assert.match(r.out, /publish \$\{DB_PORT:-5432\}->5432/);
  assert.match(r.out, /POSTGRES_PASSWORD` hardcodes a value/);
  assert.doesNotMatch(r.out, /JWT_SECRET|6379/);
});

test('compose: dev files only warn; untagged image → warning', { skip: !hasCompose && 'docker compose not available' }, () => {
  const r = compose({
    'compose.dev.yml': 'services:\n  db:\n    image: postgres\n    ports: ["5432:5432"]\n    env_file: .env\n',
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning .*5432->5432/);
  assert.match(r.out, /::warning .*has no pinned version/);
});

// ---------- security: secrets job ----------
test('committed .env and .vercel/ → fail; .env.example is allowed', () => {
  const s = runBlock(security, 'No committed .env files / .vercel directory');
  const bad = gitRepo({ '.env.example': 'A=', 'apps/web/.env.local': 'KEY=1', '.vercel/project.json': '{}' });
  const r = bash(s, { cwd: bad.dir, env: { ALLOW: S.env_file_allowlist } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /file=apps\/web\/\.env\.local/);
  assert.match(r.stdout, /file=\.vercel\/project\.json/);
  assert.doesNotMatch(r.stdout, /\.env\.example::/);
  const good = gitRepo({ '.env.example': 'A=', '.envrc': 'x', '.env.staging.example': 'A=', 'jfoodhub/.env.production.sample': 'A=' });
  assert.equal(bash(s, { cwd: good.dir, env: { ALLOW: S.env_file_allowlist } }).code, 0, 'sample files with a middle segment (.env.staging.example) are allowed');
  const tricky = gitRepo({ '.env.example.local': 'K=1', '.env.staging': 'K=1' });
  const rt = bash(s, { cwd: tricky.dir, env: { ALLOW: S.env_file_allowlist } });
  assert.equal(rt.code, 1);
  assert.match(rt.stdout, /file=\.env\.example\.local/);
  assert.match(rt.stdout, /file=\.env\.staging::/);
});

test('the sample env file allowlist is identical in security.yml, debt.mjs, org-audit.mjs', () => {
  const lit = (p) => readFileSync(path.join(ROOT, p), 'utf8');
  const re = S.env_file_allowlist;
  for (const p of ['scripts/harness/debt.mjs', 'scripts/org-audit.mjs']) assert.ok(lit(p).includes(`!/${re}/.test(f)`), p);
});

test('NEXT_PUBLIC_*SERVICE_ROLE* variables → fail; NEXT_PUBLIC_SUPABASE_ANON_KEY ok', () => {
  const s = runBlock(security, 'Public variables must not have secret-like names');
  const bad = gitRepo({ 'src/lib/sb.ts': 'createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY)\n' });
  const r = bash(s, { cwd: bad.dir, env: { PREFIXES: S.public_env_prefixes } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /file=src\/lib\/sb\.ts,line=1/);
  const envEx = gitRepo({ '.env.example': 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=\n' });
  assert.equal(bash(s, { cwd: envEx.dir, env: { PREFIXES: S.public_env_prefixes } }).code, 1);
  const good = gitRepo({
    'src/lib/sb.ts': 'createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)\n',
    'tests/leak.test.ts': 'expect(process.env.NEXT_PUBLIC_SECRET_X).toBeUndefined()\n',
    'docs/ci.yml': '# e.g. NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY\n',
  });
  assert.equal(bash(s, { cwd: good.dir, env: { PREFIXES: S.public_env_prefixes } }).code, 0);
});
