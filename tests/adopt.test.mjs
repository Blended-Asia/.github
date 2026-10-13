import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateEntry, entryYaml, rulesetName, request, reconcile, loadRegistry } from '../scripts/adopt.mjs';
import { loadYaml } from '../scripts/harness/lib.mjs';
import { ROOT } from './helpers.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString();
const tpl = (name) => readFileSync(path.join(ROOT, 'workflow-templates', name), 'utf8')
  .replace(/[\w.-]+(?=\/\.github\/\.github\/workflows\/)/g, 'acme');
const realLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = realLog; });

let calls;
let routes;
let state;
const repoObj = (name, extra = {}) => ({
  id: name.length * 1000, name, html_url: `https://github.com/acme/${name}`, default_branch: 'main', private: true, visibility: 'private',
  archived: false, pushed_at: new Date().toISOString(), allow_auto_merge: false, delete_branch_on_merge: false, ...extra,
});

beforeEach(() => {
  calls = [];
  state = { rulesets: [], variables: {} };
  routes = [
    ['GET', /^\/repos\/acme\/(app|flow|done|gh-harness)$/, (m) => repoObj(m[1])],
    ['GET', /^\/repos\/acme\/ghost$/, () => [404, null]],
    ['GET', /\/repos\/acme\/flow\/branches\/develop$/, () => ({ name: 'develop' })],
    ['GET', /\/branches\/develop$/, () => [404, null]],
    ['GET', /\/repos\/acme\/(app|flow)\/contents\/\.github\/harness\.yml/, () => [404, null]],
    ['GET', /\/repos\/acme\/done\/contents\/\.github\/workflows\/org-harness\.yml/, () => ({ content: b64(tpl('org-harness.yml').replaceAll('$default-branch', 'main')) })],
    ['GET', /\/repos\/acme\/done\/contents\/\.github\/workflows\/org-pr-convention\.yml/, () => ({ content: b64(tpl('org-pr-convention.yml')) })],
    ['GET', /\/repos\/acme\/done\/git\/trees\//, () => ({ tree: ['.github/workflows/org-harness.yml', '.github/workflows/org-pr-convention.yml'].map((p) => ({ path: p, type: 'blob' })) })],
    ['GET', /\/repos\/acme\/(app|flow)\/git\/trees\//, () => ({ tree: [{ path: 'README.md', type: 'blob' }] })],
    // registry (gh-harness)
    ['GET', /\/repos\/acme\/gh-harness\/pulls\?state=open/, () => state.openRegistryPr ? [{ html_url: 'https://github.com/acme/gh-harness/pull/9' }] : []],
    ['GET', /\/git\/ref\/heads\/(main|develop)$/, () => ({ object: { sha: 'abc123' } })],
    ['POST', /\/git\/refs$/, () => [201, {}]],
    ['PATCH', /\/git\/refs\/heads\//, () => ({})],
    ['GET', /\/contents\/[^?]+\?ref=(adopt|ci)/, () => [404, null]],
    ['PUT', /\/contents\//, () => [201, {}]],
    ['POST', /\/repos\/acme\/([\w-]+)\/pulls$/, (m) => [201, { html_url: `https://github.com/acme/${m[1]}/pull/1` }]],
    ['GET', /\/pulls\?state=open/, () => []],
    // admin
    ['GET', /\/orgs\/acme\/actions\/runner-groups\?/, () => ({ runner_groups: [{ id: 3, name: 'blended-ci' }] })],
    ['PUT', /\/orgs\/acme\/actions\/runner-groups\/3\/repositories\/\d+$/, () => [204, null]],
    ['PATCH', /\/repos\/acme\/([\w-]+)\/actions\/variables\/HARNESS_RUNS_ON$/, (m) => (state.variables[m[1]] ? [204, null] : [404, null])],
    ['POST', /\/repos\/acme\/([\w-]+)\/actions\/variables$/, () => [201, null]],
    ['PATCH', /^\/repos\/acme\/[\w-]+$/, () => ({})],
    ['GET', /\/orgs\/acme\/rulesets\?/, () => state.rulesets.map(({ id, name }) => ({ id, name }))],
    ['GET', /\/orgs\/acme\/rulesets\/(\d+)$/, (m) => structuredClone(state.rulesets.find((r) => r.id === Number(m[1])))],
    ['PUT', /\/orgs\/acme\/rulesets\/\d+$/, () => ({})],
    ['POST', /\/orgs\/acme\/rulesets$/, () => [201, { id: 77 }]],
    // anything else auditRepo asks (protection, deployments, alerts, runs…) → not found / empty
    ['GET', /./, () => [404, null]],
  ];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    calls.push({ method: opts.method, path: p, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.authorization });
    for (const [method, re, fn] of routes) {
      const m = p.match(re);
      if (method === opts.method && m) {
        const out = fn(m);
        const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
        return new Response(status === 204 || data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(`not mocked: ${opts.method} ${p}`, { status: 500 });
  };
});

const registry = (entries) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
  for (const [file, text] of Object.entries(entries)) writeFileSync(path.join(dir, file), text);
  return dir;
};
const put = (p) => calls.find((c) => c.method === 'PUT' && c.path.includes(p));

test('validateEntry: names, kinds, teams, file name must match repo', () => {
  assert.deepEqual(validateEntry({ repo: 'app', kind: 'new', team: 'solo' }), { repo: 'app', kind: 'new', team: 'solo', flow: null });
  assert.throws(() => validateEntry({ repo: '../x', kind: 'new', team: 'solo' }), /invalid repo name/);
  assert.throws(() => validateEntry({ repo: 'app', kind: 'big', team: 'solo' }), /kind must be/);
  assert.throws(() => validateEntry({ repo: 'app', kind: 'new', team: 'all' }), /team must be/);
  assert.throws(() => validateEntry({ repo: 'app', kind: 'new', team: 'solo' }, 'other.yml'), /file name must match/);
  assert.equal(rulesetName({ flow: 'gitflow', team: 'team' }), 'org-gitflow-team');
  assert.equal(rulesetName({ flow: 'trunk', team: 'solo' }), 'org-trunk-solo');
  for (const name of ['org-trunk-solo', 'org-trunk-team', 'org-gitflow-solo', 'org-gitflow-team']) {
    assert.ok(readFileSync(path.join(ROOT, 'rulesets', `${name}.json`)), `ruleset file ${name}`);
  }
});

test('entryYaml round-trips through the registry loader', async () => {
  const dir = registry({ 'app.yml': entryYaml({ repo: 'app', kind: 'existing', team: 'team', flow: 'gitflow', requestedBy: 'dev1' }) });
  assert.deepEqual(await loadRegistry(dir), [{ repo: 'app', kind: 'existing', team: 'team', flow: 'gitflow' }]);
  assert.equal(loadYaml(path.join(dir, 'app.yml')).requested_by, 'dev1');
});

test('request: opens a registry PR with the detected flow; reuses an open one; rejects unknown repos', async () => {
  const env = { ORG: 'acme', GH_TOKEN: 't', REGISTRY: 'gh-harness', REPO: 'flow', KIND: 'existing', TEAM: 'team', REQUESTER: 'dev1' };
  const r = await request(env);
  assert.equal(r.entry.flow, 'gitflow', 'develop branch → git-flow');
  assert.equal(r.url, 'https://github.com/acme/gh-harness/pull/1');
  const file = put('/repos/acme/gh-harness/contents/repos/flow.yml');
  assert.equal(file.body.branch, 'adopt/flow');
  assert.match(unb64(file.body.content), /^repo: flow$[\s\S]*^flow: gitflow/m);
  const pr = calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/gh-harness/pulls');
  assert.match(pr.body.body, /## Summary[\s\S]*org-gitflow-team[\s\S]*## How to test/);
  assert.equal((await request({ ...env, REPO: 'app' })).entry.flow, 'trunk');
  state.openRegistryPr = true;
  calls = [];
  assert.equal((await request(env)).url, 'https://github.com/acme/gh-harness/pull/9');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')), 'no duplicate PR');
  await assert.rejects(request({ ...env, REPO: 'ghost' }), /not found/);
  await assert.rejects(request({ ...env, REPO: 'a b' }), /invalid repo name/);
});

test('reconcile: runner access + auto-merge with the admin token; adoption PR (new → enforce) with the harness token', async () => {
  const dir = registry({ 'app.yml': entryYaml({ repo: 'app', kind: 'new', team: 'solo', flow: 'trunk' }) });
  const { rows, failed } = await reconcile({ ORG: 'acme', GH_TOKEN: 'harness', ADMIN_TOKEN: 'admin', MANIFEST_DIR: dir });
  assert.equal(failed, 0, JSON.stringify(rows));
  const admin = (re, method) => calls.find((c) => c.method === method && re.test(c.path));
  assert.equal(admin(/runner-groups\/3\/repositories\/3000$/, 'PUT').auth, 'Bearer admin');
  assert.deepEqual(admin(/actions\/variables$/, 'POST').body, { name: 'HARNESS_RUNS_ON', value: 'blended-ci' });
  assert.deepEqual(admin(/^\/repos\/acme\/app$/, 'PATCH').body, { allow_auto_merge: true, delete_branch_on_merge: true });
  const harness = put('/repos/acme/app/contents/.github/harness.yml');
  assert.equal(harness.auth, 'Bearer harness', 'adoption PR uses the narrow harness App, not the admin App');
  const text = unb64(harness.body.content);
  assert.match(text, /^enforcement: enforce$/m);
  assert.match(text, /granularity: file/);
  assert.match(rows[0].steps.join(' '), /adoption PR: https:\/\/github\.com\/acme\/app\/pull\/1/);
  assert.ok(!calls.some((c) => /rulesets/.test(c.path)), 'no ruleset before the adoption PR is merged');
});

test('reconcile: existing repo → observe; adopted repo → added to its group ruleset (created if missing, appended otherwise)', async () => {
  const dir = registry({
    'flow.yml': entryYaml({ repo: 'flow', kind: 'existing', team: 'team', flow: 'gitflow' }),
    'done.yml': entryYaml({ repo: 'done', kind: 'new', team: 'solo', flow: 'trunk' }),
  });
  state.variables.done = true;
  const env = { ORG: 'acme', GH_TOKEN: 'harness', ADMIN_TOKEN: 'admin', MANIFEST_DIR: dir };
  await reconcile(env);
  assert.match(unb64(put('/repos/acme/flow/contents/.github/harness.yml').body.content), /^enforcement: observe$/m);
  const pr = calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/flow/pulls');
  assert.equal(pr.body.base, 'develop', 'git-flow adoption PR targets develop');
  const created = calls.find((c) => c.method === 'POST' && c.path === '/orgs/acme/rulesets');
  assert.equal(created.body.name, 'org-trunk-solo');
  assert.deepEqual(created.body.conditions.repository_name.include, ['done']);
  assert.ok(!calls.some((c) => c.method === 'POST' && /actions\/variables$/.test(c.path) && c.path.includes('/done/')), 'existing variable is updated, not recreated');

  calls = [];
  state.rulesets = [{ id: 5, name: 'org-trunk-solo', target: 'branch', enforcement: 'active', bypass_actors: [], rules: [{ type: 'deletion' }],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }, repository_name: { include: ['other'], exclude: ['.github'] } } }];
  await reconcile(env);
  const updated = calls.find((c) => c.method === 'PUT' && c.path === '/orgs/acme/rulesets/5');
  assert.deepEqual(updated.body.conditions.repository_name.include, ['other', 'done'], 'appends, never replaces other repos');
  calls = [];
  state.rulesets[0].conditions.repository_name.include = ['other', 'done'];
  const again = await reconcile(env);
  assert.ok(!calls.some((c) => c.method === 'PUT' && /rulesets/.test(c.path)), 'idempotent');
  assert.match(again.rows.find((r) => r.repo === 'done').steps.join(' '), /ruleset org-trunk-solo: present/);
});

test('reconcile: one bad repo does not stop the others; invalid registry files fail loudly', async () => {
  const dir = registry({
    'ghost.yml': entryYaml({ repo: 'ghost', kind: 'new', team: 'solo', flow: 'trunk' }),
    'app.yml': entryYaml({ repo: 'app', kind: 'new', team: 'solo', flow: 'trunk' }),
  });
  const res = await reconcile({ ORG: 'acme', GH_TOKEN: 'h', ADMIN_TOKEN: 'a', MANIFEST_DIR: dir });
  assert.equal(res.failed, 1);
  assert.match(res.rows.find((r) => r.repo === 'ghost').steps[0], /❌/);
  assert.match(res.rows.find((r) => r.repo === 'app').steps.join(' '), /adoption PR/);
  const bad = registry({ 'x.yml': 'repo: y\nkind: new\nteam: solo\n' });
  await assert.rejects(loadRegistry(bad), /file name must match/);
  await assert.rejects(reconcile({ ORG: 'acme', GH_TOKEN: 'h', MANIFEST_DIR: dir }), /Missing ADMIN_TOKEN/);
});
