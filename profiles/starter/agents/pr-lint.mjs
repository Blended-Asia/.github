#!/usr/bin/env node
// Managed by the org (Blended-Asia/.github, profiles/starter/agents) — do not edit; changes are overwritten.
//
// Checks a pull request against the org PR convention BEFORE it is created, with the same rules as the
// `org / pr-convention` check (title, branch, required body sections). Zero dependencies, Node ≥ 18.
//
//   node .github/scripts/pr-lint.mjs --title "feat(api): add x" --body-file pr.md [--branch feat/x]
//   node .github/scripts/pr-lint.mjs --claude-hook     # Claude Code PreToolUse hook (reads the tool call on stdin)
//
// The repo can override rules in `.github/workflows/org-pr-convention.yml` (`with:`); this script reads them.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Same defaults as the reusable workflow's inputs (tests in the org repo keep them in sync).
export const DEFAULTS = {
  title_types: 'feat,fix,chore,docs,refactor,perf,test,build,ci,revert,style',
  require_scope: false,
  allowed_scopes: '',
  title_max_length: 72,
  branch_pattern: '^(feat|feature|fix|chore|docs|refactor|perf|test|build|ci|hotfix|release|revert)/[a-z0-9._-]+$',
  ticket_pattern: '',
  ticket_in: 'title,branch,body',
  required_sections: '## Summary,## How to test',
  require_checklist_done: false,
};

const list = (s) => String(s ?? '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** Same checks as the `org-pr-convention` script. Each field is checked only when given (null = skip). */
export function checkPr({ title = null, branch = null, body = null }, inputs = {}) {
  const I = { ...DEFAULTS, ...inputs };
  const errors = [];
  const warnings = [];
  if (title !== null) {
    const types = list(I.title_types);
    const t = title.trim();
    const m = t.match(/^([a-z]+)(?:\(([^()\s]+)\))?(!)?: (\S.*)$/);
    if (!m) {
      errors.push(['Title', `\`${t}\` does not match \`type(scope): description\`. Valid types: ${types.join(', ')}`]);
    } else {
      const [, type, scope, , subject] = m;
      if (!types.includes(type)) errors.push(['Title', `type \`${type}\` is not allowed. Use one of: ${types.join(', ')}`]);
      if (I.require_scope && !scope) errors.push(['Title', 'missing scope, e.g. `feat(auth): ...`']);
      const scopes = list(I.allowed_scopes);
      if (scope && scopes.length && !scopes.includes(scope)) errors.push(['Title', `scope \`${scope}\` is not one of: ${scopes.join(', ')}`]);
      if (/[.。]$/.test(subject)) warnings.push(['Title', 'should not end with a period']);
    }
    if (t.length > Number(I.title_max_length)) errors.push(['Title', `is ${t.length} characters long (max ${I.title_max_length})`]);
  }
  if (branch !== null && I.branch_pattern && !new RegExp(I.branch_pattern).test(branch)) {
    errors.push(['Branch', `\`${branch}\` does not match \`${I.branch_pattern}\``]);
  }
  if (body !== null) {
    const clean = body.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
    const isHeading = (l) => /^#{1,6}\s+\S/.test(l);
    const norm = (h) => h.replace(/^#{1,6}\s*/, '').trim().toLowerCase();
    const section = (heading) => {
      const lines = clean.split('\n');
      const start = lines.findIndex((l) => isHeading(l) && norm(l) === norm(heading));
      if (start < 0) return null;
      const out = [];
      for (let i = start + 1; i < lines.length && !isHeading(lines[i]); i++) out.push(lines[i]);
      return out.join('\n').trim();
    };
    for (const sec of list(I.required_sections)) {
      const c = section(sec);
      if (c === null) errors.push(['Body', `missing section \`${sec}\``]);
      else if (!c) errors.push(['Body', `section \`${sec}\` is empty (write "N/A" if not applicable)`]);
    }
    if ((I.require_checklist_done === true || I.require_checklist_done === 'true') && /^\s*[-*] \[ \]/m.test(clean)) {
      errors.push(['Checklist', 'has unticked `- [ ]` items']);
    }
  }
  if (I.ticket_pattern && title !== null && branch !== null && body !== null) {
    const re = new RegExp(I.ticket_pattern);
    const hay = { title, branch, body };
    const where = list(I.ticket_in);
    if (!where.some((w) => re.test(hay[w] ?? ''))) errors.push(['Ticket', `no ticket ID matching \`${I.ticket_pattern}\` found in ${where.join('/')}`]);
  }
  return { errors, warnings };
}

/** Repo overrides: the uncommented `key: value` lines under `with:` in the convention workflow. */
export function repoInputs(workflowText) {
  const out = {};
  const lines = String(workflowText ?? '').split('\n');
  const w = lines.findIndex((l) => /^\s+with:\s*$/.test(l));
  if (w < 0) return out;
  const indent = lines[w].match(/^ */)[0].length;
  for (let i = w + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (l.match(/^ */)[0].length <= indent) break;
    const m = l.match(/^\s+([a-z_]+):\s*(.*?)\s*(?:#.*)?$/);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$|^".*"$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

/** Split a shell command into words (quotes, escapes); `$(...)` / heredocs are kept as opaque words. */
export function shellWords(cmd) {
  const words = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (c === '\\' && i + 1 < cmd.length) cur += cmd[++i];
    else if (/\s/.test(c)) {
      if (cur || any) words.push(cur);
      cur = '';
      any = false;
    } else if (c === '$' && cmd[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')' && --depth === 0) break;
      }
      cur += cmd.slice(i, j + 1);
      i = j;
    } else if (';&|'.includes(c)) {
      if (cur || any) words.push(cur);
      words.push(c);
      cur = '';
      any = false;
    } else cur += c;
  }
  if (cur || any) words.push(cur);
  return words;
}

/** Find every `gh pr create|edit` in a command line and read --title/--body/--body-file/--head. */
export function ghPrCalls(cmd) {
  const w = shellWords(cmd);
  const calls = [];
  for (let i = 0; i < w.length - 2; i++) {
    if (!(w[i] === 'gh' || w[i].endsWith('/gh')) || w[i + 1] !== 'pr' || !['create', 'edit'].includes(w[i + 2])) continue;
    const call = { action: w[i + 2], title: null, body: null, bodyFile: null, head: null, fill: false, opaque: [] };
    for (let j = i + 3; j < w.length && !';&|'.includes(w[j]); j++) {
      const [flag, inline] = w[j].startsWith('--') && w[j].includes('=') ? [w[j].slice(0, w[j].indexOf('=')), w[j].slice(w[j].indexOf('=') + 1)] : [w[j], null];
      const val = () => (inline !== null ? inline : w[++j]);
      if (flag === '--title' || flag === '-t') call.title = val();
      else if (flag === '--body' || flag === '-b') call.body = val();
      else if (flag === '--body-file' || flag === '-F') call.bodyFile = val();
      else if (flag === '--head' || flag === '-H') call.head = val();
      else if (flag === '--fill' || flag === '--fill-first' || flag === '--fill-verbose' || flag === '-f') call.fill = true;
    }
    for (const k of ['title', 'body']) if (call[k]?.includes('$(')) { call.opaque.push(k); call[k] = null; }
    calls.push(call);
  }
  return calls;
}

/** Current branch name (also right after `git checkout -b`, before the first commit); null when detached. */
function gitBranch(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function loadInputs(root) {
  const p = path.join(root, '.github/workflows/org-pr-convention.yml');
  return existsSync(p) ? repoInputs(readFileSync(p, 'utf8')) : {};
}

const format = (errors) => errors.map(([k, m]) => `- ${k}: ${m}`).join('\n');

/** Claude Code PreToolUse hook: exit 2 with the reasons blocks the tool call and tells the agent what to fix. */
export function hookDecision(event, root) {
  const cmd = event?.tool_input?.command;
  if (event?.tool_name !== 'Bash' || typeof cmd !== 'string') return { code: 0 };
  const calls = ghPrCalls(cmd);
  if (!calls.length) return { code: 0 };
  const inputs = loadInputs(root);
  const problems = [];
  for (const c of calls) {
    if (c.action === 'create' && c.fill) problems.push(['Command', '`--fill` takes the title/body from commits; pass `--title` and `--body-file` explicitly']);
    if (c.action === 'create' && c.title === null && !c.opaque.includes('title')) problems.push(['Command', 'pass the PR title with `--title`']);
    if (c.action === 'create' && c.body === null && c.bodyFile === null && !c.opaque.includes('body')) problems.push(['Command', 'pass the PR description with `--body-file <file>` (sections: ## Summary, ## How to test)']);
    let body = c.body;
    if (c.bodyFile && c.bodyFile !== '-') {
      const f = path.resolve(root, c.bodyFile);
      if (existsSync(f)) body = readFileSync(f, 'utf8');
      else problems.push(['Command', `body file not found: ${c.bodyFile}`]);
    }
    const branch = c.action === 'create' ? (c.head ?? gitBranch(root)) : null;
    problems.push(...checkPr({ title: c.title, branch, body }, inputs).errors);
  }
  if (!problems.length) return { code: 0 };
  return {
    code: 2,
    message: `PR does not follow the org convention (AGENTS.md → Pull requests). Fix and retry:\n${format(problems)}`,
  };
}

async function main(argv) {
  const root = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    } catch {
      return process.cwd();
    }
  })();
  if (argv.includes('--claude-hook')) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let event = null;
    try {
      event = JSON.parse(raw);
    } catch {
      return 0; // not a hook payload: never block on our own parsing problem
    }
    const d = hookDecision(event, root);
    if (d.message) process.stderr.write(`${d.message}\n`);
    return d.code;
  }
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const title = arg('--title');
  const bodyFile = arg('--body-file');
  const body = bodyFile ? readFileSync(bodyFile, 'utf8') : arg('--body');
  const branch = arg('--branch') ?? gitBranch(root);
  if (title === null && body === null) {
    process.stderr.write('Usage: pr-lint.mjs --title "<title>" (--body-file <file> | --body "<text>") [--branch <name>]\n');
    return 2;
  }
  const { errors, warnings } = checkPr({ title, branch, body }, loadInputs(root));
  for (const [k, m] of warnings) process.stdout.write(`warning · ${k}: ${m}\n`);
  if (errors.length) {
    process.stderr.write(`PR does not follow the org convention:\n${format(errors)}\n`);
    return 1;
  }
  process.stdout.write('PR convention: OK\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
