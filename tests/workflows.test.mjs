// Rules for this repo's own workflows: no ${{ }} in script bodies, actions pinned by SHA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadYaml } from '../scripts/harness/lib.mjs';
import { ROOT } from './helpers.mjs';

const files = [
  ...readdirSync(path.join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`),
  ...readdirSync(path.join(ROOT, 'workflow-templates')).filter((f) => f.endsWith('.yml')).map((f) => `workflow-templates/${f}`),
];

function* steps(wf) {
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const st of job.steps ?? []) yield { jobId, st };
  }
}

test('no ${{ }} in run/script bodies (prevents script injection; pass values via env)', () => {
  const bad = [];
  for (const f of files) {
    for (const { jobId, st } of steps(loadYaml(path.join(ROOT, f)))) {
      for (const body of [st.run, st.with?.script]) {
        if (typeof body === 'string' && body.includes('${{')) bad.push(`${f} › ${jobId} › ${st.name ?? st.id ?? st.uses}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('every external action is pinned to a 40-character commit SHA', () => {
  const bad = [];
  for (const f of files) {
    const wf = loadYaml(path.join(ROOT, f));
    const uses = [...steps(wf)].map(({ st }) => st.uses).filter(Boolean);
    for (const u of uses) {
      if (u.startsWith('./') || u.startsWith('docker://')) continue;
      if (!/@[0-9a-f]{40}$/.test(u)) bad.push(`${f}: ${u}`);
    }
    // jobs calling the org's own reusable workflows (Blended-Asia/.github/...@v1) may use a tag
    for (const job of Object.values(wf.jobs ?? {})) {
      if (job.uses && !/^[\w.-]+\/\.github\/\.github\/workflows\/[\w-]+\.yml@[\w.-]+$/.test(job.uses)) bad.push(`${f}: ${job.uses}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('stack.yml: picks the Ruby version (app → root .ruby-version/.tool-versions → Gemfile → 3.4) and rejects odd characters', async () => {
  const { runBlock, gitRepo, bash, wf } = await import('./helpers.mjs');
  const s = runBlock(wf('stack.yml'), 'Ruby version');
  const v = (files, dir = 'api') => bash(s, { cwd: gitRepo(files).dir, env: { DIR: dir } }).outputs.version;
  assert.equal(v({ 'api/.ruby-version': '3.3.1\n', '.ruby-version': '3.1.0\n' }), 'default');
  assert.equal(v({ 'api/Gemfile': 'source "x"\n', '.ruby-version': 'ruby-3.2.2\n' }), '3.2.2');
  assert.equal(v({ 'api/Gemfile': 'x', '.tool-versions': 'nodejs 24\nruby 3.3.4\n' }), '3.3.4');
  assert.equal(v({ 'api/Gemfile': 'source "https://rubygems.org"\n\nruby "3.2.2"\ngem "rails"\n' }), '3.2.2');
  assert.equal(v({ 'api/Gemfile': "ruby '3.1.4'\n" }), '3.1.4');
  assert.equal(v({ 'api/Gemfile': 'ruby file: ".ruby-version"\n' }), '3.4');
  assert.equal(v({ 'api/Gemfile': 'x', '.ruby-version': '3.2$(id)\n' }), '3.4');
  assert.equal(v({ 'Gemfile': 'gem "rails"\n' }, '.'), '3.4');
});

test('runner: reusable jobs honour vars.HARNESS_RUNS_ON; this public repo\'s own jobs stay on GitHub-hosted runners', () => {
  const EXPR = "${{ vars.HARNESS_RUNS_ON || 'ubuntu-latest' }}";
  const OWN = ['.github/workflows/self-test.yml', '.github/workflows/org-audit.yml'];
  for (const f of files.filter((x) => x.startsWith('.github/workflows/'))) {
    const wf = loadYaml(path.join(ROOT, f));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!job['runs-on']) continue; // job that calls another workflow
      // Self-hosted runners must never run code from the public repo (anyone could fork/PR it)
      if (OWN.includes(f)) assert.equal(job['runs-on'], 'ubuntu-latest', `${f} › ${id}`);
      else assert.equal(job['runs-on'], EXPR, `${f} › ${id}`);
    }
  }
});

test('stack.yml Node step: npm cache only when the nearest lockfile is package-lock.json', async () => {
  const { runBlock, gitRepo, bash, wf } = await import('./helpers.mjs');
  const s = runBlock(wf('stack.yml'), 'Node version');
  const out = (files, dir) => bash(s, { cwd: gitRepo(files).dir, env: { DIR: dir } }).outputs;
  assert.deepEqual(out({ 'web/package-lock.json': '{}', 'web/.nvmrc': '24' }, 'web'), { file: 'web/.nvmrc', cache: 'npm', lock: 'web/package-lock.json' });
  assert.deepEqual(out({ 'package-lock.json': '{}', 'apps/web/package.json': '{}' }, 'apps/web'), { file: '', cache: 'npm', lock: 'package-lock.json' }, 'workspace root lockfile');
  assert.deepEqual(out({ 'package-lock.json': '{}' }, '.'), { file: '', cache: 'npm', lock: 'package-lock.json' });
  assert.equal(out({ 'pnpm-lock.yaml': 'x', 'apps/web/package.json': '{}' }, 'apps/web').cache, '', 'pnpm: no setup-node cache');
  assert.equal(out({ 'web/package.json': '{}' }, 'web').cache, '', 'no lockfile: no cache');
});

test('draft PRs skip the heavy sensor jobs (Trivy, Semgrep, Docker, Supabase, Rails, JS)', () => {
  const heavy = { 'security.yml': ['dependencies', 'sast'], 'infra.yml': ['docker', 'supabase'], 'stack.yml': ['rails', 'js'] };
  for (const [f, ids] of Object.entries(heavy)) {
    const wf = loadYaml(path.join(ROOT, '.github/workflows', f));
    for (const id of ids) assert.match(String(wf.jobs[id].if), /github\.event\.pull_request\.draft != true/, `${f} › ${id}`);
    for (const [id, job] of Object.entries(wf.jobs)) if (!ids.includes(id)) assert.doesNotMatch(String(job.if ?? ''), /draft/, `${f} › ${id} stays on for drafts`);
  }
});

test('self-hosted safe: harness code is moved into a clean $RUNNER_TEMP/harness (runners may reuse the temp dir)', () => {
  const moves = [];
  for (const f of files) {
    for (const { jobId, st } of steps(loadYaml(path.join(ROOT, f)))) {
      if (typeof st.run === 'string' && /\bmv \.harness\b/.test(st.run)) moves.push([`${f} › ${jobId}`, st.run.trim()]);
    }
  }
  assert.ok(moves.length >= 5);
  for (const [where, run] of moves) assert.equal(run, 'rm -rf "$RUNNER_TEMP/harness" && mv .harness "$RUNNER_TEMP/harness"', where);
});

test('caller templates never use `secrets: inherit` and pass only secrets the reusable workflow declares', () => {
  for (const f of files.filter((x) => x.startsWith('workflow-templates/'))) {
    const wf = loadYaml(path.join(ROOT, f));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      assert.notEqual(job.secrets, 'inherit', `${f} › ${id}`);
      if (!job.secrets || !job.uses) continue;
      const callee = loadYaml(path.join(ROOT, '.github/workflows', path.basename(job.uses.split('@')[0])));
      const declared = Object.keys((callee.on ?? callee.true).workflow_call.secrets ?? {}); // Ruby YAML reads `on:` as true
      for (const k of Object.keys(job.secrets)) assert.ok(declared.includes(k), `${f} › ${id} passes undeclared secret ${k}`);
    }
  }
});

test('self-hosted safe: fixed-name dirs under $RUNNER_TEMP are cleared before use', () => {
  const text = ['security.yml', 'infra.yml'].map((f) => [f, readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')]);
  for (const [f, t] of text) {
    for (const m of t.matchAll(/git worktree add --detach "\$RUNNER_TEMP\/base"/g)) {
      const before = t.slice(Math.max(0, m.index - 200), m.index);
      assert.match(before, /rm -rf "\$RUNNER_TEMP\/base"; git worktree prune/, `${f}: stale base worktree`);
    }
    for (const m of t.matchAll(/out="\$RUNNER_TEMP\/(trivy|hadolint)";([^\n]*)/g)) assert.match(m[2], /^ rm -rf "\$out"; mkdir -p/, `${f}: ${m[1]} output dir`);
  }
});
