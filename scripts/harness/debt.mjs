#!/usr/bin/env node
// Đo "nợ" của một repo CÓ SẴN trước khi bật harness: mỗi rule kiến trúc đang bị vi phạm bao nhiêu chỗ,
// file nào bị commit nhầm, migration nào sai tên… rồi đề xuất cấu hình .github/harness.yml.
//
// Chạy ở root của repo cần onboard (cần clone repo .github của org bên cạnh):
//   node ../.github/scripts/harness/debt.mjs            → in báo cáo markdown
//   node ../.github/scripts/harness/debt.mjs --json     → JSON cho máy đọc
// ENV: HARNESS_DIR (mặc định: repo .github chứa script này), REVIEW_AT (mặc định 30)
//
// Lưu ý cách đọc: trên PR rule kiến trúc chỉ xét DÒNG MỚI, nên nợ cũ không bao giờ chặn PR.
// Số vi phạm cũ lớn chỉ là dấu hiệu rule có thể không hợp kiến trúc thực tế (code mới viết theo
// pattern cũ sẽ bị chặn) → xem lại trong giai đoạn observe, KHÔNG tự tắt/hạ mức dựa trên con số này.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, DEFAULT_HARNESS_DIR } from './config.mjs';
import { scan } from './rules.mjs';
import { trackedFiles } from './lib.mjs';

export function measure({ root = '.', harnessDir = DEFAULT_HARNESS_DIR, reviewAt = 30 } = {}) {
  const cfg = resolveConfig({ root, harnessDir });
  const files = trackedFiles(root);
  const findings = scan({ rules: cfg.rules, base: '', scope: 'all', root });

  const byRule = new Map(cfg.rules.map((r) => [r.id, { id: r.id, severity: r.severity ?? 'error', security: r.security === true, count: 0, files: new Map() }]));
  for (const f of findings) {
    const r = byRule.get(f.title);
    r.count++;
    r.files.set(f.file, (r.files.get(f.file) ?? 0) + 1);
  }
  const rules = [...byRule.values()].map((r) => {
    let suggest = 'giữ';
    if (r.security) suggest = r.count ? 'giữ (rule bảo mật). Nợ cũ không chặn PR, nên mở issue sửa' : 'giữ (rule bảo mật)';
    else if (r.count >= reviewAt) suggest = 'xem lại trong giai đoạn observe: code mới viết theo pattern cũ sẽ bị chặn';
    else if (r.count) suggest = 'giữ: nợ cũ không chặn PR, dọn dần';
    const top = [...r.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { id: r.id, severity: r.severity, security: r.security, count: r.count, fileCount: r.files.size, top, suggest };
  }).sort((a, b) => b.count - a.count);

  const envFiles = files.filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/\.env\.(example|sample|template|defaults)$/.test(f));
  const vercelDir = files.filter((f) => /(^|\/)\.vercel\//.test(f));
  const badMigrations = files.filter((f) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(f) && !/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(path.posix.basename(f)));
  const missing = [];
  for (const p of cfg.profiles) {
    const has = (re) => files.some((f) => f.startsWith(p.path === '.' ? '' : `${p.path}/`) && re.test(path.posix.basename(f)));
    if (p.name === 'rails' && !has(/^\.rubocop\.yml$/)) missing.push(`${p.path}: chưa có .rubocop.yml (profiles/starter/rails/.rubocop.yml)`);
    if (p.name !== 'rails' && !has(/^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/)) missing.push(`${p.path}: chưa có ESLint config (profiles/starter/react/eslint.config.mjs)`);
  }
  if (!files.includes('ARCHITECTURE.md')) missing.push('chưa có ARCHITECTURE.md (AI review cần, Claude Code viết từ code hiện có)');

  const review = rules.filter((r) => r.suggest.startsWith('xem lại')).map((r) => ({ id: r.id, count: r.count }));
  return { profiles: cfg.profiles, detected: cfg.detected, rules, envFiles, vercelDir, badMigrations, missing, suggestion: { review } };
}

export function renderDebt(d) {
  const L = ['# Báo cáo nợ trước khi bật harness', ''];
  L.push(`Profile${d.detected ? ' (tự nhận diện)' : ''}: ${d.profiles.map((p) => `\`${p.name}\` @ \`${p.path}\``).join(', ') || '_không nhận diện được_'}`, '');
  const crit = [...d.envFiles.map((f) => `File env bị commit: \`${f}\`: xoá khỏi git **và rotate secret**`), ...d.vercelDir.slice(0, 1).map(() => '`.vercel/` bị commit')];
  if (crit.length) L.push('## 🔴 Sửa trước khi bật (chặn mọi PR kể cả ở chế độ enforce)', '', ...crit.map((c) => `- ${c}`), '');
  L.push('## Rule kiến trúc trên toàn repo', '', '| Rule | Mức | Vi phạm | Số file | Nhiều nhất | Đề xuất |', '|---|---|--:|--:|---|---|');
  for (const r of d.rules) {
    L.push(`| \`${r.id}\` | ${r.severity} | ${r.count} | ${r.fileCount} | ${r.top.map(([f, n]) => `\`${f}\` (${n})`).join(', ') || '-'} | ${r.suggest} |`);
  }
  L.push('');
  if (d.badMigrations.length) L.push(`Migration đặt tên khác chuẩn (không chặn PR, chỉ áp cho migration mới): ${d.badMigrations.length} file.`, '');
  if (d.missing.length) L.push('## Còn thiếu', '', ...d.missing.map((m) => `- ${m}`), '');
  L.push('## Đề xuất `.github/harness.yml`', '', '```yaml', 'enforcement: observe', '');
  if (!d.detected || d.profiles.length > 1) {
    L.push('profiles:', ...d.profiles.map((p) => `  - name: ${p.name}\n    path: ${p.path}`), '');
  }
  if (d.suggestion.review.length) {
    L.push('# Xem lại sau giai đoạn quan sát (nhiều vi phạm cũ → rule có thể không hợp kiến trúc thực tế).',
      '# Chỉ hạ mức/tắt nếu thấy BÁO NHẦM trên PR thật, không dựa vào con số nợ cũ:',
      ...d.suggestion.review.map((r) => `#   ${r.id} (${r.count} vi phạm cũ)`),
      '# architecture:', '#   severity:', '#     <rule-id>: warn', '#   disable: [<rule-id>]');
  }
  L.push('```', '',
    'Trên PR, mọi check chỉ chặn **lỗi mới** (dòng mới với rule kiến trúc; so với bản base với ESLint, RuboCop, tsc, Brakeman, Trivy, Hadolint, compose), nên nợ cũ không cần baseline.',
    'Riêng Supabase Advisor: chạy job một lần rồi copy key ở summary vào `advisors_ignore`.');
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const d = measure({
    harnessDir: process.env.HARNESS_DIR || DEFAULT_HARNESS_DIR,
    reviewAt: Number(process.env.REVIEW_AT ?? 30),
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...d, rules: d.rules.map((r) => ({ ...r, top: Object.fromEntries(r.top) })) }, null, 2));
  else console.log(renderDebt(d));
}
