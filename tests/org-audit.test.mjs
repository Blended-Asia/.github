import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, normalizeCaller, callerOverrides, codeownersFor } from '../scripts/org-audit.mjs';
import { ROOT } from './helpers.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const now = new Date().toISOString();
const tpl = (name) => readFileSync(path.join(ROOT, 'workflow-templates', name), 'utf8')
  .replace(/[\w.-]+(?=\/\.github\/\.github\/workflows\/)/g, 'acme')
  .replaceAll('$default-branch', 'main');
const repo = (name, extra = {}) => ({
  name, html_url: `https://github.com/acme/${name}`, default_branch: 'main', visibility: 'private',
  archived: false, fork: false, pushed_at: now, ...extra,
});
const tree = (paths) => ({ truncated: false, tree: paths.map((p) => ({ path: p, type: 'blob' })) });
const REQUIRED = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'org / pr-convention' }, { context: 'harness / gate' }] } };

let calls;
let routes;

// org-audit's log (multi-byte characters) occasionally makes the node:test runner fail with
// "Unable to deserialize cloned data" when running many files in parallel → swallow logs in this test file.
const realLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = realLog; });

beforeEach(() => {
  calls = [];
  const guardWithConfig = tpl('org-harness.yml').replace(
    '    uses: acme/.github/.github/workflows/infra.yml@v1\n',
    '    uses: acme/.github/.github/workflows/infra.yml@v1\n    with:\n      stacks: docker\n',
  );
  const contents = {
    'compliant/.github/workflows/org-harness.yml': tpl('org-harness.yml'),
    'compliant/.github/workflows/org-pr-convention.yml': tpl('org-pr-convention.yml'),
    'compliant/.github/workflows/org-vercel-preview.yml': tpl('org-vercel-preview.yml'),
    'compliant/.github/CODEOWNERS': '* @acme/dev\n/.github/workflows/ @acme/platform\n',
    'compliant/.github/harness.yml': 'review:\n  ai: true\n',
    'tampered/.github/harness.yml': 'enforcement: observe\n',
    'old-ref/.github/harness.yml': 'architecture:\n  disable: [react/no-ts-ignore]\nchecks:\n  react:\n    prettier: false\nmerge:\n  bot_approve:\n    max_lines: 2000\n',
    'old-ref/.github/workflows/ci.yml': `jobs:
  security:
    uses: acme/.github/.github/workflows/security.yml@v0
    with:
      semgrep: false
  infra:
    uses: acme/.github/.github/workflows/infra.yml@v0
  stack:
    uses: acme/.github/.github/workflows/stack.yml@v0
  harness:
    uses: acme/.github/.github/workflows/harness.yml@v0
  org:
    uses: acme/.github/.github/workflows/pr-convention.yml@v0
`,
    'old-ref/CODEOWNERS': '*.js @acme/fe\n',
    'tampered/.github/workflows/org-harness.yml': guardWithConfig.replace('  security:\n', '  security:\n    if: false\n'),
    'tampered/.github/workflows/org-pr-convention.yml': tpl('org-pr-convention.yml'),
    'classic/.github/workflows/org-harness.yml': guardWithConfig,
    'classic/.github/workflows/org-pr-convention.yml': tpl('org-pr-convention.yml'),
  };
  routes = [
    ['GET', /^\/orgs\/acme\/repos/, () => [
      repo('leaky', { visibility: 'public' }), // listing has no security_and_analysis
      repo('compliant'), repo('old-ref'), repo('tampered'), repo('classic'),
      repo('archived', { archived: true }), repo('empty'), repo('.github'),
    ]],
    ['GET', /^\/repos\/acme\/leaky$/, () => ({ security_and_analysis: { secret_scanning_push_protection: { status: 'disabled' } } })],
    ['GET', /\/repos\/acme\/empty\/git\/trees/, () => [409, null]],
    ['GET', /\/repos\/acme\/leaky\/git\/trees/, () => tree(['Dockerfile', 'apps/web/.env.production', '.env.example', 'supabase/config.toml', 'next.config.ts'])],
    ['GET', /\/repos\/acme\/compliant\/git\/trees/, () => tree(['.github/workflows/org-harness.yml', '.github/workflows/org-pr-convention.yml', '.github/workflows/org-vercel-preview.yml', '.github/CODEOWNERS', '.github/dependabot.yml', '.github/pull_request_template.md', '.github/harness.yml', 'vercel.json'])],
    ['GET', /\/repos\/acme\/old-ref\/git\/trees/, () => tree(['.github/workflows/ci.yml', '.github/harness.yml', 'CODEOWNERS', 'renovate.json', '.github/PULL_REQUEST_TEMPLATE/default.md'])],
    ['GET', /\/repos\/acme\/tampered\/git\/trees/, () => tree(['.github/workflows/org-harness.yml', '.github/workflows/org-pr-convention.yml', '.github/harness.yml'])],
    ['GET', /\/repos\/acme\/classic\/git\/trees/, () => tree(['.github/workflows/org-harness.yml', '.github/workflows/org-pr-convention.yml'])],
    ['GET', /\/repos\/acme\/([\w-]+)\/contents\/([^?]+)\?ref=main$/, (m) => {
      const c = contents[`${m[1]}/${decodeURIComponent(m[2])}`];
      return c ? { content: b64(c), sha: 'blob1' } : [404, null];
    }],
    ['GET', /\/repos\/acme\/leaky\/deployments/, () => [{ creator: { login: 'vercel[bot]' } }]],
    ['GET', /\/deployments/, () => []],
    ['GET', /\/repos\/acme\/compliant\/rules\/branches\/main/, () => [{ type: 'pull_request', parameters: { require_code_owner_review: true } }, REQUIRED]],
    ['GET', /\/repos\/acme\/(old-ref|tampered)\/rules\/branches\/main/, () => [{ type: 'pull_request' }]],
    ['GET', /\/rules\/branches\/main/, () => []],
    ['GET', /\/repos\/acme\/classic\/branches\/main$/, () => ({ protected: true })],
    ['GET', /\/repos\/acme\/classic\/branches\/main\/protection$/, () => ({
      required_pull_request_reviews: { require_code_owner_reviews: false },
      required_status_checks: { checks: [{ context: 'harness / gate' }], contexts: ['org / pr-convention'] },
    })],
    ['GET', /\/branches\/main$/, () => ({ protected: false })],
    ['GET', /\/branches\/develop$/, () => [404, null]],
    ['GET', /\/repos\/acme\/compliant\/vulnerability-alerts/, () => [204, null]],
    ['GET', /\/vulnerability-alerts/, () => [404, null]],
    // FIX mode
    ['GET', /\/git\/ref\/heads\/main$/, () => ({ object: { sha: 'abc123' } })],
    ['POST', /\/repos\/acme\/leaky\/git\/refs$/, () => [422, { message: 'Reference already exists' }]],
    ['POST', /\/git\/refs$/, () => [201, { ref: 'x' }]],
    ['PATCH', /\/git\/refs\/heads\//, () => ({ ref: 'x' })],
    ['GET', /\/contents\/.+\?ref=ci%2Forg-harness-v1$/, () => [404, null]],
    ['PUT', /\/contents\//, () => [201, { content: {} }]],
    ['GET', /\/pulls\?state=open/, () => []],
    ['POST', /\/repos\/acme\/([\w-]+)\/pulls$/, (m) => [201, { html_url: `https://github.com/acme/${m[1]}/pull/1` }]],
  ];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    calls.push({ method: opts.method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [method, re, fn] of routes) {
      const m = p.match(re);
      if (method === opts.method && m) {
        const out = fn(m);
        const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
        return new Response(status === 204 || data === null ? null : JSON.stringify(data), { status });
      }
    }
    return new Response(`not mocked: ${opts.method} ${p}`, { status: 500 });
  };
});

const env = (extra = {}) => ({ ORG: 'acme', GH_TOKEN: 't', OUT_DIR: mkdtempSync(path.join(tmpdir(), 'audit-')), ...extra });
const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));
const has = (r, level, re) => r.findings.some((f) => f.level === level && re.test(f.msg));

test('helpers: normalizeCaller ignores with:/comments/ref/org', () => {
  const a = 'jobs:\n  x:\n    uses: acme/.github/.github/workflows/security.yml@v1 # pin\n    with:\n      semgrep: false\n';
  const b = '# managed\njobs:\n  x:\n    uses: other/.github/.github/workflows/security.yml@v9\n';
  assert.equal(normalizeCaller(a), normalizeCaller(b));
  assert.notEqual(normalizeCaller(a), normalizeCaller(b.replace('  x:\n', '  x:\n    if: false\n')));
  assert.deepEqual(callerOverrides(a), { semgrep: 'false' });
});

test('helpers: CODEOWNERS uses the last matching line', () => {
  const f = '.github/workflows/org-harness.yml';
  assert.deepEqual(codeownersFor('* @a\n/.github/workflows/ @p\n', f), ['@p']);
  assert.deepEqual(codeownersFor('/.github/ @p\n*.yml\n', f), []); // later line removes the owner
  assert.deepEqual(codeownersFor('*.js @fe\ndocs/ @d\n', f), []);
  assert.deepEqual(codeownersFor('.github/** @p\n', f), ['@p']);
});

test('audit: classifies each repo correctly', async () => {
  const e = env();
  const { results, md, critical } = await main(e);
  const by = byName(results);
  assert.deepEqual(Object.keys(by).sort(), ['classic', 'compliant', 'empty', 'leaky', 'old-ref', 'tampered']);

  assert.deepEqual(by.compliant.checks, { harness: 'pass', convention: 'pass', protection: 'pass', codeowners: 'pass', depsBot: 'pass', vulnAlerts: 'pass' });
  assert.equal(by.compliant.fixes.length, 0);
  assert.equal(by.compliant.findings.filter((f) => f.level !== 'info').length, 0, JSON.stringify(by.compliant.findings));

  assert.equal(by.leaky.checks.harness, 'fail');
  assert.equal(by.leaky.checks.protection, 'fail');
  assert.deepEqual(by.leaky.stacks, ['docker', 'supabase', 'vercel', 'next']);
  assert.ok(has(by.leaky, 'critical', /apps\/web\/\.env\.production/));
  assert.ok(!by.leaky.findings.some((f) => /\.env\.example/.test(f.msg)));
  assert.ok(has(by.leaky, 'high', /push protection/), 'must GET the repo when the listing lacks security_and_analysis');
  assert.ok(critical);

  const old = by['old-ref'];
  assert.deepEqual([old.checks.harness, old.checks.convention, old.checks.protection, old.checks.codeowners], ['warn', 'warn', 'warn', 'warn']);
  assert.ok(has(old, 'warn', /Override .*semgrep=false/));
  assert.ok(has(old, 'info', /custom file name/));
  assert.ok(has(old, 'warn', /harness\.yml` loosens checks: disables rule react\/no-ts-ignore; disables react\.prettier; bot auto-approves PRs up to 2000 lines/));
  assert.ok(!by.compliant.findings.some((f) => /loosens checks/.test(f.msg)));

  const t = by.tampered;
  assert.equal(t.checks.harness, 'warn');
  assert.equal(t.checks.convention, 'pass');
  assert.ok(has(t, 'high', /org-harness\.yml` differs from the template/));
  assert.ok(has(t, 'warn', /stacks=docker/));
  assert.ok(has(t, 'info', /observe mode/));

  const c = by.classic;
  assert.equal(c.checks.protection, 'pass', 'classic branch protection with PR + both checks');
  assert.ok(!has(c, 'high', /differs from the template/), 'a valid `with:` is not counted as drift');

  assert.match(md, /\*\*2\/5\*\* repos fully compliant/); // compliant + classic
  assert.match(md, /\*\*1\*\* repos in observe mode/);
  assert.match(md, /Needs immediate action/);
  const json = JSON.parse(readFileSync(path.join(e.OUT_DIR, 'report.json'), 'utf8'));
  assert.ok(!('workflowFiles' in json[0]));
  assert.ok(!calls.some((x) => x.method !== 'GET'), 'dry-run must not write');
});

test('fix: adds all files, resets stale branch, bumps ref keeping config, does not overwrite modified callers', async () => {
  const { results } = await main(env({ FIX: 'true', PLATFORM_OWNERS: '@acme/platform' }));
  const by = byName(results);
  const puts = (name) => calls.filter((c) => c.method === 'PUT' && c.path.includes(`/${name}/`));
  const putPaths = (name) => puts(name).map((c) => decodeURIComponent(c.path.split('/contents/')[1])).sort();

  assert.deepEqual(putPaths('leaky'), [
    '.github/CODEOWNERS', '.github/harness.yml', '.github/pull_request_template.md', '.github/workflows/org-harness.yml',
    '.github/workflows/org-pr-convention.yml', '.github/workflows/org-vercel-preview.yml',
  ]);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path.includes('/leaky/git/refs/heads/ci/org-harness-v1') && c.body.force && c.body.sha === 'abc123'));
  const guard = puts('leaky').find((c) => c.path.endsWith('org-harness.yml'));
  const text = Buffer.from(guard.body.content, 'base64').toString();
  assert.match(text, /uses: acme\/\.github\/\.github\/workflows\/security\.yml@v1/);
  assert.match(text, /branches: \[main\]/);
  assert.doesNotMatch(text, /Blended-Asia|\$default-branch/);

  assert.deepEqual(putPaths('old-ref'), ['.github/workflows/ci.yml']);
  const bumped = Buffer.from(puts('old-ref')[0].body.content, 'base64').toString();
  assert.match(bumped, /security\.yml@v1[\s\S]+semgrep: false[\s\S]+pr-convention\.yml@v1/);
  assert.doesNotMatch(bumped, /@v0/);

  assert.deepEqual(putPaths('tampered'), ['.github/CODEOWNERS', '.github/pull_request_template.md'], 'modified callers are only reported, never overwritten');
  assert.equal(puts('compliant').length, 0);
  assert.ok(!calls.some((c) => c.method === 'PATCH' && !c.path.includes('/leaky/')), 'a newly created branch is not reset');

  const prs = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
  assert.deepEqual(prs.map((p) => p.path.split('/')[3]).sort(), ['classic', 'leaky', 'old-ref', 'tampered']);
  for (const pr of prs) {
    assert.match(pr.body.title, /^ci: /);
    assert.match(pr.body.body, /## Summary[\s\S]+## How to test/);
    assert.equal(pr.body.head, 'ci/org-harness-v1');
  }
  assert.equal(by.leaky.prUrl, 'https://github.com/acme/leaky/pull/1');
});

test('fix: with an open PR, does not reset the branch or open a duplicate PR', async () => {
  routes.unshift(['GET', /\/repos\/acme\/leaky\/pulls\?state=open/, () => [{ html_url: 'https://github.com/acme/leaky/pull/9' }]]);
  const { results } = await main(env({ FIX: 'true', ONLY: 'leaky' }));
  assert.equal(results[0].prUrl, 'https://github.com/acme/leaky/pull/9');
  assert.ok(!calls.some((c) => c.method === 'PATCH'));
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')));
});

test('ONLY + new GUARD_REF → repos on v1 become old ref, fix only bumps the ref', async () => {
  const { results } = await main(env({ ONLY: 'compliant', GUARD_REF: 'v2' }));
  assert.equal(results.length, 1);
  assert.equal(results[0].checks.harness, 'warn');
  assert.deepEqual(results[0].fixes.map((f) => f.path).sort(), ['.github/workflows/org-harness.yml', '.github/workflows/org-pr-convention.yml', '.github/workflows/org-vercel-preview.yml']);
  for (const f of results[0].fixes) assert.doesNotMatch(f.content, /@v1\b/);
});

test('QUIET: does not print repo names to the log or write the step summary', async () => {
  const lines = [];
  const orig = [console.log, console.error];
  console.log = console.error = (...a) => lines.push(a.join(' '));
  try {
    routes.unshift(['GET', /\/repos\/acme\/old-ref\/git\/trees/, () => [500, { message: 'boom' }]]);
    const e = env({ QUIET: 'true', GITHUB_STEP_SUMMARY: path.join(mkdtempSync(path.join(tmpdir(), 's-')), 'sum') });
    const { md } = await main(e);
    assert.match(md, /Error while scanning/);
    assert.ok(!lines.some((l) => /leaky|old-ref|compliant/.test(l)), lines.join('\n'));
    assert.throws(() => readFileSync(e.GITHUB_STEP_SUMMARY));
  } finally {
    [console.log, console.error] = orig;
  }
});

test('git-flow: audit + adoption PR on develop; starter harness.yml has gate.branches [develop]', async () => {
  const devFiles = { '.github/workflows/org-harness.yml': tpl('org-harness.yml').replace('[main]', '[develop]') };
  routes.unshift(
    ['GET', /^\/orgs\/acme\/repos/, () => [repo('flow')]],
    ['GET', /\/repos\/acme\/flow\/branches\/develop$/, () => ({ name: 'develop', protected: false })],
    ['GET', /\/repos\/acme\/flow\/git\/trees\/main\?/, () => tree(['README.md'])],
    ['GET', /\/repos\/acme\/flow\/git\/trees\/develop\?/, () => tree(['.github/workflows/org-harness.yml', 'Gemfile', 'config/application.rb'])],
    ['GET', /\/repos\/acme\/flow\/contents\/([^?]+)\?ref=develop$/, (m) => {
      const c = devFiles[decodeURIComponent(m[1])];
      return c ? { content: b64(c), sha: 'blob1' } : [404, null];
    }],
    ['GET', /\/repos\/acme\/flow\/contents\/[^?]+\?ref=main$/, () => [404, null]],
    ['GET', /\/repos\/acme\/flow\/rules\/branches\/develop$/, () => []],
    ['GET', /\/repos\/acme\/flow\/git\/ref\/heads\/develop$/, () => ({ object: { sha: 'dev123' } })],
  );
  const { results } = await main(env({ FIX: 'true' }));
  const r = byName(results).flow;
  assert.equal(r.branch, 'develop');
  assert.ok(r.stacks.includes('rails'), 'reads the develop file tree');
  assert.equal(r.checks.harness, 'pass', 'org-harness on develop matches the template');
  assert.equal(r.checks.convention, 'fail');
  assert.ok(!has(r, 'high', /differs from the template/), 'a caller on develop with push: [develop] is not treated as modified');
  assert.ok(has(r, 'info', /Audited branch `develop`/));
  assert.ok(calls.some((c) => c.method === 'GET' && /rules\/branches\/develop$/.test(c.path)), 'checks protection of the develop branch');
  const pr = calls.find((c) => c.method === 'POST' && /\/pulls$/.test(c.path));
  assert.equal(pr.body.base, 'develop');
  assert.equal(calls.find((c) => c.method === 'POST' && /git\/refs$/.test(c.path)).body.sha, 'dev123');
  const put = (p) => calls.find((c) => c.method === 'PUT' && c.path.includes(encodeURIComponent(p).replace(/%2F/g, '/')) || (c.method === 'PUT' && c.path.endsWith(p)));
  const harnessYml = Buffer.from(put('.github/harness.yml').body.content, 'base64').toString();
  assert.match(harnessYml, /^gate:\n  branches: \["develop"\]$/m);
  const conv = Buffer.from(put('.github/workflows/org-pr-convention.yml').body.content, 'base64').toString();
  assert.match(conv, /acme\/\.github/);
});

test('git-flow: gate.branches in harness.yml decides the working branch (takes precedence over guessing develop)', async () => {
  routes.unshift(
    ['GET', /^\/orgs\/acme\/repos/, () => [repo('rel')]],
    ['GET', /\/repos\/acme\/rel\/branches\/develop$/, () => [404, null]],
    ['GET', /\/repos\/acme\/rel\/git\/trees\/main\?/, () => tree(['.github/harness.yml'])],
    ['GET', /\/repos\/acme\/rel\/git\/trees\/next\?/, () => tree(['.github/harness.yml'])],
    ['GET', /\/repos\/acme\/rel\/contents\/\.github\/harness\.yml\?ref=(main|next)$/, () => ({ content: b64('gate:\n  branches: ["release/*", next]\n'), sha: 'b' })],
    ['GET', /\/repos\/acme\/rel\/contents\/[^?]+\?ref=next$/, () => [404, null]],
    ['GET', /\/repos\/acme\/rel\/rules\/branches\/next$/, () => []],
    ['GET', /\/repos\/acme\/rel\/branches\/next$/, () => ({ protected: false })],
  );
  const { results } = await main(env());
  assert.equal(byName(results).rel.branch, 'next');
});
