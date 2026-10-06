// Architecture scan: rule dạng "file khớp paths không được chứa forbid" — chạy cho mọi ngôn ngữ.
// Scope "changed": chỉ xét dòng thêm/sửa trong PR (nợ cũ không chặn). Scope "all": quét toàn repo.
// Bỏ qua 1 dòng có chủ đích: thêm comment `harness-disable-line <rule-id>` trên dòng đó (hiện trong diff → reviewer thấy).
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
 * Bỏ phần comment của một dòng, trả về phần code còn lại. Chỉ bỏ những span đã đóng
 * và comment đầu dòng theo đúng ngôn ngữ của file, để không né được rule bằng cách đặt một
 * comment rỗng trước code, hay nhầm private field `#x` của JS là comment.
 */
export function stripComments(text, file) {
  let t = text.replace(/\/\*.*?\*\//g, ' ').replace(/<%#.*?%>/g, ' ').replace(/<!--.*?-->/g, ' ');
  if (SLASH_COMMENT.test(file) && /^\s*\/\//.test(t)) return '';
  if (HASH_COMMENT.test(file) && /^\s*#/.test(t)) return '';
  if (/\.sql$/.test(file) && /^\s*--/.test(t)) return '';
  return t;
}

/** lines: [{line, text}]; content: toàn bộ file (cho if_file_matches). */
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
      out.push({ severity: r.severity, file, line, title: r.id, message: r.message ?? `Vi phạm ${r.id}` });
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
  // push/schedule không có base: quét toàn repo để xem nợ, nhưng chỉ cảnh báo (trừ khi repo chọn scope: all)
  const informational = !base && configured !== 'all';
  const findings = scan({ rules: cfg.rules, base, scope })
    .map((f) => (informational ? { ...f, severity: 'warn' } : f));
  const errors = report(`Architecture (${cfg.rules.length} rule, scope ${scope}${informational ? ', chỉ báo cáo' : ''})`, findings);
  process.exit(errors ? 1 : 0);
}
