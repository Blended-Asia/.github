// Architecture scan: rules of the form "files matching paths must not contain forbid" — runs for every language.
// Scope "changed": only lines added/modified in the PR are checked (existing debt does not block). Scope "all": scan the whole repo.
// To intentionally skip a line: add a `harness-disable-line <rule-id>` comment on that line (it shows in the diff → reviewers see it).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addedLines, globToRegExp, matchAny, readText, report, trackedFiles } from './lib.mjs';

export function compileRules(rules) {
  return rules.map((r) => ({
    ...r,
    severity: r.severity ?? 'error',
    pathRes: r.paths.map(globToRegExp),
    excludeRes: (r.exclude ?? []).map(globToRegExp),
    forbidRe: new RegExp(r.forbid, r.flags ?? ''),
    allowRe: r.allow ? new RegExp(r.allow, r.flags ?? '') : null,
    fileRe: r.if_file_matches ? new RegExp(r.if_file_matches, 'm') : null,
  }));
}

const HASH_COMMENT = /\.(rb|rake|ru|gemspec|ya?ml|py|sh|toml|tf)$|(^|\/)(Gemfile|Rakefile|Dockerfile[^/]*)$/;
const SLASH_COMMENT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|go|java|kt|swift|c|cc|cpp|h|cs|scss|less|rs)$/;

/**
 * Strip comments from a line and return the remaining code. Only closed spans and
 * line-leading comments in the file's own language are removed, so a rule cannot be dodged by
 * putting an empty comment before the code, and a JS private field `#x` is not mistaken for a comment.
 */
export function stripComments(text, file) {
  let t = text.replace(/\/\*.*?\*\//g, ' ').replace(/<%#.*?%>/g, ' ').replace(/<!--.*?-->/g, ' ');
  if (SLASH_COMMENT.test(file) && /^\s*\/\//.test(t)) return '';
  if (HASH_COMMENT.test(file) && /^\s*#/.test(t)) return '';
  if (/\.sql$/.test(file) && /^\s*--/.test(t)) return '';
  return t;
}

/** lines: [{line, text}]; content: the whole file (for if_file_matches). */
export function checkFile(compiled, file, lines, content) {
  const out = [];
  for (const r of compiled) {
    if (!matchAny(r.pathRes, file) || matchAny(r.excludeRes, file)) continue;
    if (r.fileRe && !r.fileRe.test(content ?? '')) continue;
    for (const { line, text } of lines) {
      const code = r.comments === true ? text : stripComments(text, file);
      if (!code.trim() || !r.forbidRe.test(code)) continue;
      if (r.allowRe?.test(code)) continue;
      if (text.includes(`harness-disable-line ${r.id}`)) continue;
      out.push({ severity: r.severity, file, line, title: r.id, message: r.message ?? `Violates ${r.id}` });
    }
  }
  return out;
}

export function scan({ rules, base, scope = 'changed', root = '.' }) {
  const compiled = compileRules(rules);
  const relevant = (f) => compiled.some((r) => matchAny(r.pathRes, f));
  const findings = [];
  if (scope === 'changed' && base) {
    for (const [file, lines] of addedLines(base, root)) {
      if (!lines.length || !relevant(file)) continue;
      findings.push(...checkFile(compiled, file, lines, readText(path.join(root, file))));
    }
  } else {
    for (const file of trackedFiles(root).filter(relevant)) {
      const content = readText(path.join(root, file));
      if (content == null) continue;
      const lines = content.split('\n').map((text, i) => ({ line: i + 1, text }));
      findings.push(...checkFile(compiled, file, lines, content));
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8'));
  const base = process.env.BASE_SHA || '';
  const configured = cfg.convention?.scope ?? 'changed';
  const scope = base ? configured : 'all';
  // push/schedule have no base: scan the whole repo to surface debt, but only warn (unless the repo chose scope: all)
  const informational = !base && configured !== 'all';
  const findings = scan({ rules: cfg.rules, base, scope })
    .map((f) => (informational ? { ...f, severity: 'warn' } : f));
  const errors = report(`Architecture (${cfg.rules.length} rule, scope ${scope}${informational ? ', report only' : ''})`, findings);
  process.exit(errors ? 1 : 0);
}
