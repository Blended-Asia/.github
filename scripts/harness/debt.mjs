#!/usr/bin/env node
// Measure the "debt" of an EXISTING repo before enabling the harness: how many violations each architecture rule has,
// which files were committed by mistake, which migrations are misnamed… then suggest a .github/harness.yml config.
//
// Run at the root of the repo being onboarded (with the org's .github repo cloned alongside):
//   node ../.github/scripts/harness/debt.mjs            → print a markdown report
//   node ../.github/scripts/harness/debt.mjs --json     → machine-readable JSON
// ENV: HARNESS_DIR (default: the .github repo containing this script), REVIEW_AT (default 30)
//
// How to read it: on PRs, architecture rules only check NEW LINES, so existing debt never blocks a PR.
// A large count of existing violations only hints that the rule may not fit the actual architecture (new code
// following the old pattern will be blocked) → review during the observe phase; do NOT disable/downgrade based on this number.
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
    let suggest = 'keep';
    if (r.security) suggest = r.count ? 'keep (security rule). Existing debt does not block PRs; open an issue to fix it' : 'keep (security rule)';
    else if (r.count >= reviewAt) suggest = 'review during the observe phase: new code following the old pattern will be blocked';
    else if (r.count) suggest = 'keep: existing debt does not block PRs; clean up gradually';
    const top = [...r.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { id: r.id, severity: r.severity, security: r.security, count: r.count, fileCount: r.files.size, top, suggest };
  }).sort((a, b) => b.count - a.count);

  const envFiles = files.filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/\.env(\.[^/.]+)*\.(example|sample|template|defaults)$/.test(f));
  const vercelDir = files.filter((f) => /(^|\/)\.vercel\//.test(f));
  const badMigrations = files.filter((f) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(f) && !/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(path.posix.basename(f)));
  const missing = [];
  for (const p of cfg.profiles) {
    const has = (re) => files.some((f) => f.startsWith(p.path === '.' ? '' : `${p.path}/`) && re.test(path.posix.basename(f)));
    if (p.name === 'rails' && !has(/^\.rubocop\.yml$/)) missing.push(`${p.path}: no .rubocop.yml yet (profiles/starter/rails/.rubocop.yml)`);
    if (p.name !== 'rails' && !has(/^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/)) missing.push(`${p.path}: no ESLint config yet (profiles/starter/react/eslint.config.mjs)`);
  }
  if (!files.includes('ARCHITECTURE.md')) missing.push('no ARCHITECTURE.md yet (needed by AI review; have Claude Code write it from the existing code)');

  const review = rules.filter((r) => r.suggest.startsWith('review')).map((r) => ({ id: r.id, count: r.count }));
  return { profiles: cfg.profiles, detected: cfg.detected, rules, envFiles, vercelDir, badMigrations, missing, suggestion: { review } };
}

export function renderDebt(d) {
  const L = ['# Debt report before enabling the harness', ''];
  L.push(`Profile${d.detected ? ' (auto-detected)' : ''}: ${d.profiles.map((p) => `\`${p.name}\` @ \`${p.path}\``).join(', ') || '_none detected_'}`, '');
  const crit = [...d.envFiles.map((f) => `Env file committed: \`${f}\`: remove it from git **and rotate the secrets**`), ...d.vercelDir.slice(0, 1).map(() => '`.vercel/` committed')];
  if (crit.length) L.push('## 🔴 Fix before enabling (blocks every PR, even in enforce mode)', '', ...crit.map((c) => `- ${c}`), '');
  L.push('## Architecture rules across the whole repo', '', '| Rule | Severity | Violations | Files | Top files | Suggestion |', '|---|---|--:|--:|---|---|');
  for (const r of d.rules) {
    L.push(`| \`${r.id}\` | ${r.severity} | ${r.count} | ${r.fileCount} | ${r.top.map(([f, n]) => `\`${f}\` (${n})`).join(', ') || '-'} | ${r.suggest} |`);
  }
  L.push('');
  if (d.badMigrations.length) L.push(`Migrations with non-standard names (does not block PRs; the rule only applies to new migrations): ${d.badMigrations.length} file(s).`, '');
  if (d.missing.length) L.push('## Missing', '', ...d.missing.map((m) => `- ${m}`), '');
  L.push('## Suggested `.github/harness.yml`', '', '```yaml', 'enforcement: observe', '');
  if (!d.detected || d.profiles.length > 1) {
    L.push('profiles:', ...d.profiles.map((p) => `  - name: ${p.name}\n    path: ${p.path}`), '');
  }
  if (d.suggestion.review.length) {
    L.push('# Review after the observe phase (many existing violations → the rule may not fit the actual architecture).',
      '# Only downgrade/disable if you see FALSE POSITIVES on real PRs, not based on the existing-debt count:',
      ...d.suggestion.review.map((r) => `#   ${r.id} (${r.count} existing violations)`),
      '# architecture:', '#   severity:', '#     <rule-id>: warn', '#   disable: [<rule-id>]');
  }
  L.push('```', '',
    'On PRs, every check only blocks **new problems** (new lines for architecture rules; compared against the base for ESLint, RuboCop, tsc, Brakeman, Trivy, Hadolint, compose), so existing debt needs no baseline.',
    'Supabase Advisor is the exception: run the job once, then copy the keys from its summary into `advisors_ignore`.');
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
