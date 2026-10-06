// Shared harness utilities. Node built-ins only (+ the runner's preinstalled Ruby for reading YAML).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Read YAML → object using Ruby (psych), preinstalled on GitHub runners, so no npm install is needed. */
export function loadYaml(file) {
  if (!existsSync(file)) return null;
  const out = execFileSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true) || {})', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Read a file at a commit (e.g. the PR base) → text, or null if it does not exist. */
export function showAt(ref, file, cwd = '.') {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** YAML at a commit. No ref → read the working tree. */
export function loadYamlAt(ref, file, cwd = '.') {
  if (!ref) return loadYaml(path.join(cwd, file));
  const text = showAt(ref, file, cwd);
  if (text == null) return null;
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'yaml-')), 'f.yml');
  writeFileSync(tmp, text);
  return loadYaml(tmp);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge: objects merge recursively; arrays and scalars are replaced. */
export function deepMerge(...items) {
  const out = {};
  for (const it of items.filter(isObj)) {
    for (const [k, v] of Object.entries(it)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Glob → RegExp. Supports **, *, ?, {a,b}. Paths are always relative to the repo root and use '/'. */
export function globToRegExp(glob) {
  const esc = (s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(esc).join('|')})`;
      i = end;
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}
export const matchAny = (res, file) => res.some((r) => r.test(file));

export function joinPath(dir, p) {
  if (!dir || dir === '.' || dir === './') return p.replace(/^\.\//, '');
  return `${dir.replace(/^\.\//, '').replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`;
}

export function git(args, cwd = '.') {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}
export const trackedFiles = (cwd = '.') => git(['ls-files', '-z'], cwd).split('\0').filter(Boolean);

/** Files changed relative to base (paths from the repo root); empty base → null (= no limit). */
export function changedFiles(base, cwd = '.') {
  if (!base) return null;
  return git(['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z', `${base}...HEAD`], cwd)
    .split('\0').filter(Boolean);
}

/** Lines added/modified in the diff: Map<file, [{line, text}]>. */
export function addedLines(base, cwd = '.') {
  const diff = git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', `${base}...HEAD`], cwd);
  const out = new Map();
  let file = null;
  let ln = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? null : l.slice(6).replace(/\t$/, '');
      if (file && !out.has(file)) out.set(file, []);
    } else if (l.startsWith('@@')) {
      ln = Number(/\+(\d+)/.exec(l)[1]);
    } else if (file && l.startsWith('+')) {
      out.get(file).push({ line: ln, text: l.slice(1) });
      ln++;
    } else if (file && l.startsWith(' ')) {
      ln++;
    }
  }
  return out;
}

export function readText(file, max = 1024 * 1024) {
  try {
    if (statSync(file).size > max) return null;
    const t = readFileSync(file, 'utf8');
    return t.includes('\0') ? null : t;
  } catch {
    return null;
  }
}

// ---------- GitHub Actions output ----------
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** finding: {severity: 'error'|'warn', file?, line?, title?, message} */
export function annotation(f) {
  const level = f.severity === 'error' ? 'error' : 'warning';
  const props = [f.file && `file=${escProp(f.file)}`, f.line && `line=${f.line}`, f.title && `title=${escProp(f.title)}`]
    .filter(Boolean).join(',');
  return `::${level}${props ? ` ${props}` : ''}::${escData(f.message)}`;
}

export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

/** Print annotations + write the summary table; returns the number of error-level findings. */
export function report(title, findings, { limit = 100 } = {}) {
  for (const f of findings) console.log(annotation(f));
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.length - errors;
  const icon = errors ? '❌' : warns ? '⚠️' : '✅';
  let md = `### ${icon} ${title}: ${errors} error(s), ${warns} warning(s)\n`;
  if (findings.length) {
    md += '\n| | Location | Rule | Details |\n|---|---|---|---|\n';
    for (const f of findings.slice(0, limit)) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      md += `| ${f.severity === 'error' ? '❌' : '⚠️'} | ${where} | ${f.title ?? ''} | ${String(f.message).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
    }
    if (findings.length > limit) md += `\n…and ${findings.length - limit} more\n`;
  }
  summary(md);
  return errors;
}
