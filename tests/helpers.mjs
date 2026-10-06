// Test helpers: extract scripts/steps from workflow YAML to run offline, without a YAML parser.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const wf = (name) => readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

const dedent = (lines) => {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};

/** Get the section between two marker comments (`// ---- x:begin ----` / `# ---- x:begin ----`). */
export function between(text, marker) {
  const lines = text.split('\n');
  const s = lines.findIndex((l) => l.includes(`---- ${marker}:begin ----`));
  const e = lines.findIndex((l) => l.includes(`---- ${marker}:end ----`));
  if (s < 0 || e < 0) throw new Error(`Marker not found: ${marker}`);
  return dedent(lines.slice(s + 1, e));
}

/** Get a step's `run: |` block by name (or `id: x` for steps without a name). */
export function runBlock(text, stepName) {
  const lines = text.split('\n');
  const s = lines.findIndex((l) => [`- name: ${stepName}`, `- ${stepName}`].includes(l.trim()));
  if (s < 0) throw new Error(`Step not found: ${stepName}`);
  const r = lines.findIndex((l, i) => i > s && /^\s+run: \|\s*$/.test(l));
  const runIndent = lines[r].match(/^ */)[0].length;
  const body = [];
  for (let i = r + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.match(/^ */)[0].length <= runIndent) break;
    body.push(l);
  }
  return dedent(body);
}

/** Read the defaults of workflow_call inputs (good enough for this repo's files). */
export function inputDefaults(text) {
  const out = {};
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^    inputs:\s*$/.test(l));
  let key = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {0,4}\S/.test(l)) break;
    const k = l.match(/^ {6}([\w-]+):\s*$/);
    if (k) { key = k[1]; continue; }
    const d = l.match(/^ {8}default:\s*(.*)$/);
    if (d && key) {
      const v = d[1].trim();
      if (v.startsWith("'")) out[key] = v.slice(1, -1).replace(/''/g, "'");
      else if (v.startsWith('"')) out[key] = JSON.parse(v);
      else if (v === 'true' || v === 'false') out[key] = v === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(v)) out[key] = Number(v);
      else out[key] = v;
    }
  }
  return out;
}

/** Create a temporary git repo with the given files. */
export function gitRepo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orgtest-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const write = (fs) => {
    for (const [p, c] of Object.entries(fs)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), c);
    }
  };
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base', '--allow-empty');
  return { dir, git, write, commit: (m) => { git('add', '-A'); git('commit', '-q', '-m', m); return git('rev-parse', 'HEAD'); } };
}

/** Run a bash script like GitHub Actions' default shell (bash -e {0}). */
export function bash(script, { cwd, env = {} } = {}) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'gho-')), 'out');
  const sum = out + '.summary';
  writeFileSync(out, '');
  writeFileSync(sum, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...env },
  });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outputs, summary: readFileSync(sum, 'utf8') };
}
