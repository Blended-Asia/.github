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
    // job gọi reusable workflow của chính org (YOUR_ORG/.github/...@v1) được phép dùng tag
    for (const job of Object.values(wf.jobs ?? {})) {
      if (job.uses && !/^[\w.-]+\/\.github\/\.github\/workflows\/[\w-]+\.yml@[\w.-]+$/.test(job.uses)) bad.push(`${f}: ${job.uses}`);
    }
  }
  assert.deepEqual(bad, []);
});
