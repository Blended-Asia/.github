// Chạy tool THẬT (npm install Next/ESLint/TS, bundle RuboCop, gem Brakeman) trên repo mẫu.
// Chậm (~2–4 phút) nên chỉ chạy khi HARNESS_INTEGRATION=1 (job integration trong self-test.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, gitRepo } from './helpers.mjs';

const ON = process.env.HARNESS_INTEGRATION === '1';
const sh = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });

function runStack(kind, repoDir, base, profilePath, checks) {
  const summary = path.join(mkdtempSync(path.join(tmpdir(), 'sum-')), 'sum.md');
  writeFileSync(summary, '');
  const r = sh('node', [path.join(ROOT, 'scripts/harness/stack.mjs'), kind], repoDir, {
    PROFILE_PATH: profilePath, PROFILE_NAME: kind, CHECKS: JSON.stringify(checks), BASE_SHA: base, SCOPE: 'changed',
    HARNESS_DIR: ROOT, GITHUB_STEP_SUMMARY: summary,
  });
  return { code: r.status, ann: r.stdout.split('\n').filter((l) => /^::(error|warning)/.test(l)), out: r.stdout + r.stderr };
}

test('react: ESLint + tsc + Prettier + dependency-cruiser trên Next.js thật', { skip: !ON && 'đặt HARNESS_INTEGRATION=1', timeout: 600000 }, () => {
  const repo = gitRepo({
    'web/package.json': JSON.stringify({
      name: 'web', private: true,
      dependencies: { next: '16.0.0', react: '19.2.0', 'react-dom': '19.2.0' },
      devDependencies: { typescript: '5.9.3', '@types/react': '19.2.2', '@types/node': '24.9.1', eslint: '9.38.0', 'eslint-config-next': '16.0.0', 'typescript-eslint': '8.46.2', prettier: '3.6.2' },
    }, null, 2),
    'web/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'es2022'], jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, baseUrl: '.', paths: { '@/*': ['./*'] } }, include: ['**/*.ts', '**/*.tsx', 'next-env.d.ts'], exclude: ['node_modules'] }),
    'web/.gitignore': 'node_modules\nnext-env.d.ts\n',
    'web/app/page.tsx': 'export default function Page() {\n  return <div>home</div>;\n}\n',
    'web/lib/legacy.ts': "export const legacy: number = 'old';\n",
    // file cũ: có lỗi lint và chưa format (thiếu dấu ;) từ trước
    'web/lib/old.ts': 'export const a = 1\nconst unusedOld = 2\n',
    'web/lib/use.ts': 'const helper = 1;\nexport const v = helper;\n',
    'web/lib/util.ts': 'export function fmt(n: number): string {\n  return String(n);\n}\n',
    'web/app/about/page.tsx': "import { fmt } from '@/lib/util';\nexport default function About() {\n  return <div>{fmt(1)}</div>;\n}\n",
  });
  copyFileSync(path.join(ROOT, 'profiles/starter/react/eslint.config.mjs'), path.join(repo.dir, 'web/eslint.config.mjs'));
  copyFileSync(path.join(ROOT, 'profiles/starter/react/.prettierrc.json'), path.join(repo.dir, 'web/.prettierrc.json'));
  const i = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], path.join(repo.dir, 'web'));
  assert.equal(i.status, 0, i.stderr);
  const base = repo.commit('base');
  repo.write({
    'web/app/client.tsx': "'use client';\nexport default function Client() {\n  const unused = 1;\n  const n: number = 'x';\n  return <p>{n}</p>;\n}\n",
    'web/components/Button.tsx': 'export function Button() { return <button>x</button> }\n',
    'web/lib/b.ts': "import { c } from './c';\nexport const b = () => c;\n",
    'web/lib/c.ts': "import { b } from './b';\nexport const c = () => b;\n",
    // đổi tên hàm export → app/about/page.tsx (không đổi) bị vỡ type
    'web/lib/util.ts': 'export function format(n: number): string {\n  return String(n);\n}\n',
    // sửa 1 dòng trong file cũ: chỉ lỗi ở dòng mới bị chặn
    'web/lib/old.ts': 'export const a = 1\nconst unusedOld = 2\nconst unusedNew = 3\n',
    // bỏ chỗ dùng → biến ở dòng 1 (dòng cũ, không sửa) thành unused: vẫn phải bắt
    'web/lib/use.ts': 'const helper = 1;\nexport const v = 2;\n',
    // chạm vào file có lỗi type từ trước: lỗi cũ không chặn
    'web/lib/legacy.ts': "export const legacy: number = 'old';\nexport const ok = 1;\n",
  });
  repo.commit('pr');
  const r = runStack('js', repo.dir, base, 'web', { eslint: true, typecheck: true, prettier: true, depcruise: true, depcruise_dirs: ['app', 'components', 'lib'] });
  const has = (re) => r.ann.some((l) => re.test(l));
  assert.equal(r.code, 1, r.out);
  assert.ok(has(/file=web\/app\/client\.tsx,line=3,title=eslint @typescript-eslint\/no-unused-vars/), r.ann.join('\n'));
  assert.ok(has(/file=web\/app\/client\.tsx,line=4,title=tsc TS2322/), r.ann.join('\n'));
  assert.ok(has(/file=web\/components\/Button\.tsx,title=prettier/), r.ann.join('\n'));
  assert.ok(has(/title=depcruise no-circular::Vòng import: lib\/b\.ts → lib\/c\.ts → lib\/b\.ts/), r.ann.join('\n'));
  assert.ok(!has(/::error file=web\/lib\/legacy\.ts/), 'lỗi type có sẵn từ base không chặn, kể cả khi file bị sửa');
  assert.ok(has(/::error file=web\/lib\/old\.ts,line=3,title=eslint @typescript-eslint\/no-unused-vars/), r.ann.join('\n'));
  assert.ok(!has(/file=web\/lib\/old\.ts,line=2,title=eslint/), 'lỗi lint có sẵn ở dòng cũ không chặn');
  assert.ok(has(/::error file=web\/lib\/use\.ts,line=1,title=eslint @typescript-eslint\/no-unused-vars/), 'lỗi mới nằm ở dòng cũ vẫn phải chặn\n' + r.ann.join('\n'));
  assert.ok(has(/::warning file=web\/lib\/old\.ts,title=prettier::File vốn chưa format/), r.ann.join('\n'));
  assert.ok(has(/::error file=web\/app\/about\/page\.tsx,line=1,title=tsc TS2305::.*lỗi mới ở file không đổi/), 'lỗi do PR gây ra ở file không đổi phải chặn\n' + r.ann.join('\n'));
});

test('rails: RuboCop + Brakeman thật', { skip: !ON && 'đặt HARNESS_INTEGRATION=1', timeout: 600000 }, () => {
  const ruby = sh('ruby', ['-e', 'print RUBY_VERSION'], '.').stdout.trim();
  const repo = gitRepo({
    'api/Gemfile': 'source "https://rubygems.org"\nruby file: ".ruby-version"\ngem "rubocop-rails-omakase", require: false\n',
    'api/.ruby-version': `${ruby}\n`,
    'api/config/application.rb': 'module Api\n  class Application\n  end\nend\n',
    'api/app/models/user.rb': 'class User < ApplicationRecord\nend\n',
    'api/app/models/legacy.rb': "class Legacy\n  def x = 'old'\nend\n",
    'api/app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\nend\n',
  });
  copyFileSync(path.join(ROOT, 'profiles/starter/rails/.rubocop.yml'), path.join(repo.dir, 'api/.rubocop.yml'));
  const api = path.join(repo.dir, 'api');
  sh('bundle', ['config', 'set', '--local', 'path', 'vendor/bundle'], api);
  const b = sh('bundle', ['install'], api);
  assert.equal(b.status, 0, b.stderr);
  writeFileSync(path.join(repo.dir, '.gitignore'), 'vendor/\n.bundle/\n');
  const base = repo.commit('base');
  repo.write({
    'api/app/controllers/users_controller.rb': 'class UsersController < ApplicationController\n  def index\n    @users = User.where("name = \'#{params[:name]}\'")\n    render json: @users\n  end\nend\n',
    'api/app/models/user.rb': "class User < ApplicationRecord\n  def label = 'single'\nend\n",
    // offense mới ở DÒNG 2, offense cũ bị đẩy xuống dòng 3: phải báo đúng dòng 2
    'api/app/models/legacy.rb': "class Legacy\n  def y = 'new'\n  def x = 'old'\nend\n",
  });
  repo.commit('pr');
  const r = runStack('rails', repo.dir, base, 'api', { rubocop: true, brakeman: true, brakeman_fail_confidence: 'Medium', packwerk: 'auto' });
  const has = (re) => r.ann.some((l) => re.test(l));
  assert.equal(r.code, 1, r.out);
  assert.ok(has(/file=api\/app\/models\/user\.rb,line=2,title=rubocop Style\/StringLiterals/), r.ann.join('\n'));
  assert.ok(has(/::error file=api\/app\/controllers\/users_controller\.rb,line=3,title=brakeman SQL Injection/), r.ann.join('\n'));
  assert.ok(has(/file=api\/app\/models\/legacy\.rb,line=2,title=rubocop Style\/StringLiterals/), r.ann.join('\n'));
  assert.ok(!has(/file=api\/app\/models\/legacy\.rb,line=3,/), 'offense có sẵn (dòng cũ bị đẩy xuống) không chặn');
});

test('monorepo workspace: PR sửa package khác làm vỡ type ở app (không đổi) → vẫn chặn', { skip: !ON && 'đặt HARNESS_INTEGRATION=1', timeout: 600000 }, () => {
  const repo = gitRepo({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*', 'apps/*'], devDependencies: { typescript: '5.9.3' } }),
    'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', version: '1.0.0', main: 'index.ts', types: 'index.ts' }),
    'packages/shared/index.ts': 'export function foo(): number {\n  return 1;\n}\n',
    'apps/web/package.json': JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { '@acme/shared': '*' } }),
    'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'ES2022', skipLibCheck: true }, include: ['src'] }),
    'apps/web/src/a.ts': "import { foo } from '@acme/shared';\nexport const n: number = foo();\n",
    '.gitignore': 'node_modules\n',
  });
  const i = sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], repo.dir);
  assert.equal(i.status, 0, i.stderr);
  const base = repo.commit('base');
  repo.write({ 'packages/shared/index.ts': "export function foo(): string {\n  return 'x';\n}\n" });
  repo.commit('pr');
  const r = runStack('js', repo.dir, base, 'apps/web', { eslint: false, typecheck: true, prettier: false, depcruise: false });
  assert.equal(r.code, 1, r.out);
  assert.ok(r.ann.some((l) => /::error file=apps\/web\/src\/a\.ts,line=2,title=tsc TS2322::.*do thay đổi trong PR gây ra/.test(l)), r.ann.join('\n') + r.out.slice(-1500));
});
