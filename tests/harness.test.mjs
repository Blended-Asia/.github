import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { globToRegExp, deepMerge, annotation } from '../scripts/harness/lib.mjs';
import { detectProfiles, resolveConfig } from '../scripts/harness/config.mjs';
import { scan } from '../scripts/harness/rules.mjs';
import { parseEslint, parseTsc, parseRubocop, parseBrakeman, parseDepcruise, parsePackwerk, detectPM, resolveBin, splitByBaseline, findingKey, onlyAddedLines } from '../scripts/harness/stack.mjs';
import { ROOT, gitRepo } from './helpers.mjs';

test('globToRegExp: **, *, {a,b}', () => {
  const g = (p, f) => globToRegExp(p).test(f);
  assert.ok(g('**/*.{ts,tsx}', 'a/b/c.tsx'));
  assert.ok(g('**/*.{ts,tsx}', 'c.ts'));
  assert.ok(!g('**/*.{ts,tsx}', 'c.js'));
  assert.ok(g('app/models/**/*.rb', 'app/models/user.rb'));
  assert.ok(g('app/models/**/*.rb', 'app/models/a/b.rb'));
  assert.ok(!g('app/models/**/*.rb', 'lib/app/models/user.rb'));
  assert.ok(g('src/components/**', 'src/components/x/y.tsx'));
  assert.ok(g('.github/**', '.github/workflows/a.yml'));
  assert.ok(!g('*.md', 'docs/a.md'));
  assert.ok(g('**/Dockerfile*', 'Dockerfile'));
});

test('deepMerge: object gộp, mảng thay thế', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] }, d: 1 }), { a: { b: 1, c: [3] }, d: 1 });
});

test('annotation escape ký tự đặc biệt', () => {
  assert.equal(annotation({ severity: 'error', file: 'a,b.ts', line: 3, title: 'x:y', message: 'l1\nl2 100%' }),
    '::error file=a%2Cb.ts,line=3,title=x%3Ay::l1%0Al2 100%25');
});

const fs = (obj) => ({ files: Object.keys(obj), read: (p) => obj[p] ?? null });

test('detectProfiles: rails, next monorepo, rails + package.json, workspace root, node', () => {
  const rails = fs({ Gemfile: 'source "x"\ngem "rails", "~> 8.0"\n', 'package.json': '{"dependencies":{"esbuild":"1"}}' });
  assert.deepEqual(detectProfiles(rails.files, rails.read), [{ name: 'rails', path: '.' }]);

  const mono = fs({
    'package.json': '{"private":true,"workspaces":["apps/*"],"devDependencies":{"turbo":"2"}}',
    'apps/web/package.json': '{"dependencies":{"next":"16","react":"19"}}',
    'apps/api/package.json': '{"dependencies":{"fastify":"5"}}',
    'api/Gemfile': 'gem "rails"\n',
    'apps/web/test/fixtures/package.json': '{"dependencies":{"react":"19"}}',
  });
  assert.deepEqual(detectProfiles(mono.files, mono.read), [
    { name: 'rails', path: 'api' }, { name: 'node', path: 'apps/api' }, { name: 'react', path: 'apps/web' },
  ]);

  const engine = fs({ Gemfile: 'gemspec\n', 'Gemfile.lock': 'GEM\n  specs:\n    rails (8.0.1)\n' });
  assert.deepEqual(detectProfiles(engine.files, engine.read), [], 'gem/engine có rails trong lock không phải app');
  const app = fs({ Gemfile: 'source "x"\n', 'config/application.rb': 'module X; end' });
  assert.deepEqual(detectProfiles(app.files, app.read), [{ name: 'rails', path: '.' }]);
  const sinatra = fs({ Gemfile: 'gem "sinatra"\n' });
  assert.deepEqual(detectProfiles(sinatra.files, sinatra.read), []);
});

function repoWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
  return dir;
}

test('resolveConfig: profile khai báo, prefix path cho rule, disable, rule riêng, override check', () => {
  const dir = repoWith({
    '.github/harness.yml': `profiles:
  - name: react
    path: web
  - name: rails
    path: api
checks:
  react:
    prettier: false
architecture:
  disable: [react/no-ts-ignore]
  rules:
    - id: web/no-moment
      paths: ["web/**/*.ts"]
      forbid: "from ['\\"]moment['\\"]"
      message: Dùng date-fns
merge:
  bot_approve:
    max_lines: 50
`,
  });
  const cfg = resolveConfig({ root: dir, harnessDir: ROOT, files: [] });
  assert.equal(cfg.detected, false);
  assert.deepEqual(cfg.profiles.map((p) => [p.name, p.path]), [['react', 'web'], ['rails', 'api']]);
  assert.equal(cfg.profiles[0].checks.prettier, false);
  assert.equal(cfg.profiles[0].checks.eslint, true);
  assert.equal(cfg.profiles[1].checks.brakeman_fail_confidence, 'Medium');
  const ids = cfg.rules.map((r) => r.id);
  assert.ok(!ids.includes('react/no-ts-ignore'));
  assert.ok(ids.includes('web/no-moment'));
  assert.deepEqual(cfg.rules.find((r) => r.id === 'rails/view-no-query').paths, ['api/app/views/**/*.{erb,haml,slim}']);
  assert.equal(cfg.merge.bot_approve.max_lines, 50);
  assert.equal(cfg.merge.bot_approve.enabled, true, 'giữ mặc định của base');
  assert.equal(cfg.review.model, 'claude-sonnet-5-5');
});

test('resolveConfig: báo lỗi rõ khi regex sai hoặc profile lạ', () => {
  const bad = repoWith({ '.github/harness.yml': 'architecture:\n  rules:\n    - id: x\n      paths: ["**"]\n      forbid: "(unclosed"\n' });
  assert.throws(() => resolveConfig({ root: bad, harnessDir: ROOT, files: [] }), /Rule x .*forbid không phải regex hợp lệ/);
  const unknown = repoWith({ '.github/harness.yml': 'profiles: [django]\n' });
  assert.throws(() => resolveConfig({ root: unknown, harnessDir: ROOT, files: [] }), /Profile "django" không tồn tại/);
});

test('mọi rule mặc định trong profiles/*.yml đều hợp lệ', () => {
  const dir = repoWith({ '.github/harness.yml': 'profiles: [rails, react, node]\n' });
  const cfg = resolveConfig({ root: dir, harnessDir: ROOT, files: [] });
  assert.ok(cfg.rules.length >= 10);
});

// ---------- architecture rules ----------
function rulesRepo() {
  const repo = gitRepo({
    'web/components/Old.tsx': "import x from '@/app/page';\n", // nợ cũ
    'web/app/c.tsx': "'use client';\nexport const A = 1;\n",
    'api/app/models/user.rb': 'class User\nend\n',
  });
  return { ...repo, base: repo.git('rev-parse', 'HEAD') };
}
const cfgFor = () => resolveConfig({ root: repoWith({ '.github/harness.yml': 'profiles:\n  - {name: react, path: web}\n  - {name: rails, path: api}\n' }), harnessDir: ROOT, files: [] });

test('rules: scope changed chỉ bắt dòng mới; disable-line; if_file_matches; allow', () => {
  const repo = rulesRepo();
  repo.write({
    'web/components/New.tsx': "import P from '@/app/page';\nimport Q from '@/app/x'; // harness-disable-line react/shared-components-no-route-import\n",
    'web/app/c.tsx': "'use client';\nexport const A = 1;\nconst k = process.env.STRIPE_KEY;\nconst ok = process.env.NEXT_PUBLIC_URL;\n",
    'web/app/server.tsx': 'const k = process.env.STRIPE_KEY;\n',
    'api/app/models/user.rb': 'class User\n  def x = params[:a]\nend\n',
    'api/db/migrate/1_x.rb': 'class X\n  def up\n    User.where(a: 1).update_all(b: 2)\n    Time.now.where\n  end\nend\n',
  });
  repo.commit('pr');
  const f = scan({ rules: cfgFor().rules, base: repo.base, scope: 'changed', root: repo.dir });
  const got = f.map((x) => `${x.title}@${x.file}:${x.line}:${x.severity}`).sort();
  assert.deepEqual(got, [
    'rails/migration-no-app-model@api/db/migrate/1_x.rb:3:warn',
    'rails/model-no-params@api/app/models/user.rb:2:warn',
    'react/client-no-server-code@web/app/c.tsx:3:error',
    'react/shared-components-no-route-import@web/components/New.tsx:1:error',
  ]);
});

test('rules: scope all quét cả nợ cũ', () => {
  const repo = rulesRepo();
  const f = scan({ rules: cfgFor().rules, base: '', scope: 'all', root: repo.dir });
  assert.deepEqual(f.map((x) => `${x.title}@${x.file}`), ['react/shared-components-no-route-import@web/components/Old.tsx']);
});

// ---------- parser kết quả tool ----------
const toRepo = (p) => (p.startsWith('/abs/web/') ? `web/${p.slice(9)}` : `web/${p}`);

test('parseEslint: bỏ cảnh báo "File ignored", map severity', () => {
  const json = JSON.stringify([
    { filePath: '/abs/web/a.ts', messages: [{ ruleId: 'no-unused-vars', severity: 2, message: 'x unused', line: 3 }, { ruleId: 'no-console', severity: 1, message: 'console', line: 4 }] },
    { filePath: '/abs/web/b.ts', messages: [{ ruleId: null, severity: 1, message: 'File ignored because of a matching ignore pattern.' }] },
    { filePath: '/abs/web/c.ts', messages: [{ ruleId: null, fatal: true, severity: 2, message: 'Parsing error', line: 1 }] },
  ]);
  assert.deepEqual(parseEslint(json, toRepo).map((f) => [f.file, f.line, f.severity]), [['web/a.ts', 3, 'error'], ['web/a.ts', 4, 'warn'], ['web/c.ts', 1, 'error']]);
});

test('parseTsc', () => {
  const out = "app/x.tsx(4,9): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.";
  assert.deepEqual(parseTsc(out, toRepo), [{ severity: 'error', file: 'web/app/x.tsx', line: 4, title: 'tsc TS2322', message: "Type 'string' is not assignable to type 'number'." }]);
});

test('parseRubocop, parseBrakeman (ngưỡng confidence), parsePackwerk', () => {
  const rc = JSON.stringify({ files: [{ path: 'app/models/user.rb', offenses: [
    { severity: 'convention', message: 'Prefer double quotes', cop_name: 'Style/StringLiterals', location: { start_line: 5 } },
    { severity: 'info', message: 'meh', cop_name: 'X', location: { start_line: 1 } },
  ] }] });
  assert.deepEqual(parseRubocop(rc, (p) => `api/${p}`).map((f) => [f.file, f.line, f.title]), [['api/app/models/user.rb', 5, 'rubocop Style/StringLiterals']]);

  const bm = JSON.stringify({ warnings: [
    { warning_type: 'SQL Injection', message: 'Possible SQL injection', file: 'app/c.rb', line: 3, confidence: 'Medium' },
    { warning_type: 'Redirect', message: 'Possible unprotected redirect', file: 'app/d.rb', line: 9, confidence: 'Weak' },
  ], errors: [] });
  assert.deepEqual(parseBrakeman(bm, (p) => p).map((f) => f.severity), ['error', 'warn']);
  assert.deepEqual(parseBrakeman(bm, (p) => p, 'High').map((f) => f.severity), ['warn', 'warn']);

  const pw = 'Running via Spring\napp/models/a.rb:3:4\nDependency violation: ::B belongs to `packs/b`, but `packs/a` does not specify a dependency on `packs/b`.\n\n1 offense detected';
  assert.deepEqual(parsePackwerk(pw, (p) => p), [{ severity: 'error', file: 'app/models/a.rb', line: 3, title: 'packwerk', message: 'Dependency violation: ::B belongs to `packs/b`, but `packs/a` does not specify a dependency on `packs/b`.' }]);
});

test('parseDepcruise: vòng import + related để lọc theo file đổi', () => {
  const dc = JSON.stringify({ summary: { violations: [
    { from: 'lib/b.ts', to: 'lib/c.ts', rule: { name: 'no-circular', severity: 'error' }, cycle: [{ name: 'lib/c.ts' }, { name: 'lib/b.ts' }] },
    { from: 'src/x.ts', to: 'vitest', rule: { name: 'no-dev-deps-in-prod-code', severity: 'error' } },
    { from: 'src/y.ts', to: 'z', rule: { name: 'info-only', severity: 'info' } },
  ] } });
  const f = parseDepcruise(dc, toRepo);
  assert.equal(f.length, 2);
  assert.equal(f[0].message, 'Vòng import: lib/b.ts → lib/c.ts → lib/b.ts');
  assert.deepEqual(f[0].related, ['web/lib/b.ts', 'web/lib/c.ts', 'web/lib/c.ts', 'web/lib/b.ts']);
});

test('detectPM: lockfile gần nhất, hỗ trợ workspace', () => {
  const dir = repoWith({ 'pnpm-lock.yaml': '', 'apps/web/package.json': '{}', 'tools/package-lock.json': '{}' });
  assert.deepEqual(detectPM(path.join(dir, 'apps/web'), dir), { pm: 'pnpm', dir });
  assert.equal(detectPM(path.join(dir, 'tools'), dir).pm, 'npm');
  const none = repoWith({ 'package.json': '{}' });
  assert.equal(detectPM(none, none).noLock, true);
});

test('rules: không báo nhầm các mẫu hay gặp (comment, hằng số, NODE_ENV, .render của object)', () => {
  const repo = rulesRepo();
  repo.write({
    'api/app/models/post.rb': "class Post\n  # once per request.\n  def html = MARKDOWN.render(body)\n  def s = STATUSES.first\nend\n",
    'api/app/views/posts/index.html.erb': '<% STATUSES.first %>\n<%= @posts.size %>\n<% User.all.each do |u| %>\n',
    'web/app/c.tsx': "'use client';\nexport const A = 1;\nif (process.env.NODE_ENV === 'development') {}\n// process.env.SECRET only in comment\n",
    'api/app/models/session_store.rb': 'class SessionStore\n  def x = session[:id]\nend\n',
  });
  repo.commit('pr');
  const f = scan({ rules: cfgFor().rules, base: repo.base, scope: 'changed', root: repo.dir });
  assert.deepEqual(f.map((x) => `${x.title}@${x.file}:${x.line}`).sort(), [
    'rails/model-no-http@api/app/models/session_store.rb:2',
    'rails/view-no-query@api/app/views/posts/index.html.erb:3',
  ]);
});

test('resolveConfig(configRef): đọc harness.yml ở commit base, bỏ qua bản sửa trong PR', () => {
  const repo = gitRepo({ '.github/harness.yml': 'profiles: [react]\narchitecture:\n  disable: []\n' });
  const baseSha = repo.git('rev-parse', 'HEAD');
  repo.write({ '.github/harness.yml': 'profiles: [react]\narchitecture:\n  disable: [react/client-no-server-code]\nchecks:\n  react:\n    eslint: false\n' });
  repo.commit('pr');
  const atBase = resolveConfig({ root: repo.dir, harnessDir: ROOT, files: [], configRef: baseSha });
  assert.ok(atBase.rules.some((r) => r.id === 'react/client-no-server-code'));
  assert.equal(atBase.profiles[0].checks.eslint, true);
  const atHead = resolveConfig({ root: repo.dir, harnessDir: ROOT, files: [] });
  assert.equal(atHead.profiles[0].checks.eslint, false);
  const noFileAtBase = gitRepo({ 'README.md': 'x' });
  const b = noFileAtBase.git('rev-parse', 'HEAD');
  noFileAtBase.write({ '.github/harness.yml': 'profiles: [rails]\n' });
  noFileAtBase.commit('add');
  assert.deepEqual(resolveConfig({ root: noFileAtBase.dir, harnessDir: ROOT, files: [], configRef: b }).profiles, [], 'base chưa có config → dùng mặc định + tự nhận diện');
});

test('resolveBin: tìm binary hoist ở root workspace, Yarn PnP, hoặc báo thiếu', () => {
  const ws = repoWith({ 'node_modules/.bin/eslint': '', 'apps/web/package.json': '{}' });
  assert.deepEqual(resolveBin('eslint', path.join(ws, 'apps/web'), ws), [path.join(ws, 'node_modules/.bin/eslint'), []]);
  const local = repoWith({ 'node_modules/.bin/tsc': 'root', 'apps/web/node_modules/.bin/tsc': 'local' });
  assert.equal(resolveBin('tsc', path.join(local, 'apps/web'), local)[0], path.join(local, 'apps/web/node_modules/.bin/tsc'));
  const pnp = repoWith({ '.pnp.cjs': '', 'web/package.json': '{}' });
  assert.deepEqual(resolveBin('eslint', path.join(pnp, 'web'), pnp), ['yarn', ['eslint']]);
  const none = repoWith({ 'package.json': '{}' });
  assert.equal(resolveBin('prettier', none, none), null);
});

test('rules: không né được bằng comment rỗng trước code, #field của JS, <%# %> trong ERB', () => {
  const repo = rulesRepo();
  repo.write({
    'web/app/c.tsx': "'use client';\nexport const A = 1;\n/**/ const k = process.env.SERVICE_ROLE_KEY;\nclass X { #k = process.env.STRIPE_SECRET; }\n/* chỉ comment process.env.X */\n",
    'api/app/views/posts/show.html.erb': '<%# note %><%= Post.where(a: 1).size %>\n<%# Post.where(b: 2) %>\n',
    'api/app/models/user.rb': 'class User\n  # session[:x] trong comment\nend\n',
  });
  repo.commit('pr');
  const f = scan({ rules: cfgFor().rules, base: repo.base, scope: 'changed', root: repo.dir });
  assert.deepEqual(f.map((x) => `${x.title}@${x.file}:${x.line}`).sort(), [
    'rails/view-no-query@api/app/views/posts/show.html.erb:1',
    'react/client-no-server-code@web/app/c.tsx:3',
    'react/client-no-server-code@web/app/c.tsx:4',
  ]);
});

test('splitByBaseline: lỗi ở file không đổi — có sẵn ở base thì bỏ qua, mới thì giữ (đếm theo số lần)', () => {
  const e = (file, msg) => ({ file, title: 'tsc TS2304', message: msg, line: 1 });
  const base = new Map([[findingKey(e('a.ts', 'X')), 1]]);
  const { fresh, preexisting } = splitByBaseline([e('a.ts', 'X'), e('a.ts', 'X'), e('b.ts', 'Y')], base);
  assert.equal(preexisting, 1);
  assert.deepEqual(fresh.map((f) => f.file), ['a.ts', 'b.ts']);
  assert.deepEqual(splitByBaseline([e('a.ts', 'X')], null), { fresh: [], preexisting: 1 }, 'không dựng được base → giữ hành vi cũ');
  const fp = splitByBaseline([{ fingerprint: 'f1' }, { fingerprint: 'f2' }], new Map([['f1', 1]]), (f) => f.fingerprint);
  assert.deepEqual(fp.fresh, [{ fingerprint: 'f2' }]);
});

test('onlyAddedLines: chỉ giữ lỗi trên dòng PR thêm/sửa; lỗi không có dòng thì giữ', () => {
  const added = new Map([['a.ts', new Set([3, 4])]]);
  const f = [{ file: 'a.ts', line: 2 }, { file: 'a.ts', line: 3 }, { file: 'b.ts', line: 1 }, { file: 'a.ts' }];
  const { kept, dropped } = onlyAddedLines(f, added);
  assert.deepEqual(kept, [{ file: 'a.ts', line: 3 }, { file: 'a.ts' }]);
  assert.equal(dropped, 2);
  assert.equal(onlyAddedLines(f, null).kept.length, 4, 'không có base → giữ tất cả');
});
