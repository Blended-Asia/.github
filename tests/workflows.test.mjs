// Luật cho chính các workflow trong repo: không ${{ }} trong thân script, action ghim theo SHA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
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

test('không có ${{ }} trong thân run/script (chống script injection, truyền qua env)', () => {
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

test('mọi action bên ngoài ghim theo commit SHA 40 ký tự', () => {
  const bad = [];
  for (const f of files) {
    const wf = loadYaml(path.join(ROOT, f));
    const uses = [...steps(wf)].map(({ st }) => st.uses).filter(Boolean);
    for (const u of uses) {
      if (u.startsWith('./') || u.startsWith('docker://')) continue;
      if (!/@[0-9a-f]{40}$/.test(u)) bad.push(`${f}: ${u}`);
    }
    // job gọi reusable workflow của chính org (Blended-Asia/.github/...@v1) được phép dùng tag
    for (const job of Object.values(wf.jobs ?? {})) {
      if (job.uses && !/^[\w.-]+\/\.github\/\.github\/workflows\/[\w-]+\.yml@[\w.-]+$/.test(job.uses)) bad.push(`${f}: ${job.uses}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('stack.yml: chọn phiên bản Ruby (app → root .ruby-version/.tool-versions → Gemfile → 3.4), lọc ký tự lạ', async () => {
  const { runBlock, gitRepo, bash, wf } = await import('./helpers.mjs');
  const s = runBlock(wf('stack.yml'), 'Phiên bản Ruby');
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
