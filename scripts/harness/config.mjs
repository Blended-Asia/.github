// Đọc cấu hình harness: profiles/base.yml ← profiles/<stack>.yml ← .github/harness.yml của repo.
// CLI: node config.mjs plan   → in kế hoạch chạy (profile nào, ở thư mục nào) cho workflow.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deepMerge, joinPath, loadYaml, loadYamlAt, readText, setOutput, summary, trackedFiles, annotation } from './lib.mjs';

export const PROFILES = ['rails', 'react', 'node'];
export const DEFAULT_HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_PROFILES = 8;
const SKIP_DIR = /(^|\/)(node_modules|vendor|fixtures|examples?|test|spec|tmp|dist|build)\//;

/** Tự nhận diện stack từ danh sách file tracked. read(path) → nội dung hoặc null. */
export function detectProfiles(files, read) {
  const set = new Set(files);
  const manifests = files.filter((f) => /(^|\/)(Gemfile|package\.json)$/.test(f) && f.split('/').length <= 3 && !SKIP_DIR.test(f));
  const dirs = [...new Set(manifests.map((f) => path.posix.dirname(f)))].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const found = [];
  for (const dir of dirs) {
    const at = (f) => joinPath(dir, f);
    let rails = false;
    if (set.has(at('Gemfile'))) {
      const gemfile = read(at('Gemfile')) ?? '';
      // Không dò Gemfile.lock: gem/engine cũng kéo rails vào lock nhưng không phải app Rails
      rails = set.has(at('config/application.rb')) || /^\s*gem\s+["'](rails|railties)["']/m.test(gemfile);
      if (rails) found.push({ name: 'rails', path: dir });
    }
    if (set.has(at('package.json'))) {
      let pkg = {};
      try { pkg = JSON.parse(read(at('package.json')) ?? '{}'); } catch { continue; }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const workspaceRoot = !!pkg.workspaces || set.has(at('pnpm-workspace.yaml'));
      if (['react', 'next', 'react-dom', 'react-native', '@remix-run/react'].some((d) => d in deps)) {
        found.push({ name: 'react', path: dir });
      } else if (!rails && !workspaceRoot && (Object.keys(deps).length || pkg.scripts)) {
        found.push({ name: 'node', path: dir });
      }
    }
  }
  if (found.length > MAX_PROFILES) {
    console.log(annotation({ severity: 'warn', title: 'harness', message: `Nhận diện ${found.length} profile, chỉ chạy ${MAX_PROFILES} đầu tiên. Khai báo profiles trong .github/harness.yml.` }));
  }
  return found.slice(0, MAX_PROFILES);
}

function validateRule(r, where) {
  const problems = [];
  if (!r.id) problems.push('thiếu id');
  if (!Array.isArray(r.paths) || !r.paths.length) problems.push('thiếu paths');
  if (!r.forbid) problems.push('thiếu forbid');
  for (const k of ['forbid', 'allow', 'if_file_matches']) {
    if (r[k]) try { new RegExp(r[k]); } catch (e) { problems.push(`${k} không phải regex hợp lệ: ${e.message}`); }
  }
  if (r.severity && !['error', 'warn'].includes(r.severity)) problems.push('severity phải là error|warn');
  if (problems.length) throw new Error(`Rule ${r.id ?? '(không id)'} trong ${where}: ${problems.join('; ')}`);
}

/**
 * configRef: commit để đọc .github/harness.yml. Trên PR luôn là BASE — PR không thể tự nới lỏng
 * cấu hình chấm điểm chính nó; thay đổi harness.yml chỉ có hiệu lực sau khi merge (và cần người duyệt).
 */
export function resolveConfig({ root = '.', harnessDir = DEFAULT_HARNESS_DIR, files, configPath = '.github/harness.yml', configRef = '' } = {}) {
  const read = (p) => readText(path.join(root, p));
  const base = loadYaml(path.join(harnessDir, 'profiles/base.yml')) ?? {};
  const repo = loadYamlAt(configRef, configPath, root) ?? {};
  const list = files ?? trackedFiles(root);

  const declared = Array.isArray(repo.profiles) && repo.profiles.length;
  const profiles = declared
    ? repo.profiles.map((p) => (typeof p === 'string' ? { name: p, path: '.' } : { name: p.name, path: p.path ?? '.', checks: p.checks }))
    : detectProfiles(list, read);
  for (const p of profiles) {
    if (!PROFILES.includes(p.name)) throw new Error(`Profile "${p.name}" không tồn tại (có: ${PROFILES.join(', ')})`);
  }

  const { profiles: _p, architecture: _a, checks: _c, ...rest } = repo;
  const merged = deepMerge(base, rest);
  const disabled = new Set(repo.architecture?.disable ?? []);
  // Hạ/nâng mức của rule mặc định, vd { "rails/view-no-query": warn } khi onboard repo có nhiều nợ
  const severityOverride = repo.architecture?.severity ?? {};
  const rules = [];
  const notices = [];
  const out = profiles.map((p) => {
    const def = loadYaml(path.join(harnessDir, `profiles/${p.name}.yml`)) ?? {};
    for (const r of def.architecture?.rules ?? []) {
      // Rule bảo mật của org không tắt/hạ mức được từ repo (bỏ qua từng dòng bằng harness-disable-line → cần người duyệt)
      if (r.security && (disabled.has(r.id) || severityOverride[r.id] === 'warn')) {
        notices.push(`Rule bảo mật ${r.id} không tắt hay hạ mức được từ harness.yml; cấu hình này bị bỏ qua.`);
      } else if (disabled.has(r.id)) continue;
      rules.push({
        ...r,
        severity: r.security ? r.severity : (severityOverride[r.id] ?? r.severity),
        paths: r.paths.map((g) => joinPath(p.path, g)),
        exclude: (r.exclude ?? []).map((g) => joinPath(p.path, g)),
        source: `${p.name}@${p.path}`,
      });
    }
    return { name: p.name, path: p.path, checks: deepMerge(def.checks, repo.checks?.[p.name], p.checks) };
  });
  for (const r of repo.architecture?.rules ?? []) rules.push({ ...r, exclude: r.exclude ?? [], source: 'repo' });
  for (const r of rules) validateRule(r, r.source === 'repo' ? configPath : `profiles/${r.source.split('@')[0]}.yml`);

  return { ...merged, detected: !declared, profiles: out, rules, notices: [...new Set(notices)] };
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2];
  if (cmd !== 'plan') {
    console.error('Dùng: node config.mjs plan');
    process.exit(2);
  }
  const configPath = process.env.CONFIG_PATH || '.github/harness.yml';
  try {
    const cfg = resolveConfig({ harnessDir: process.env.HARNESS_DIR || DEFAULT_HARNESS_DIR, configPath, configRef: process.env.BASE_SHA || '' });
    for (const n of cfg.notices) console.log(annotation({ severity: 'warn', file: configPath, title: 'harness config', message: n }));
    const outFile = process.env.HARNESS_CONFIG_OUT || path.join(process.env.RUNNER_TEMP || '.', 'harness.json');
    writeFileSync(outFile, JSON.stringify(cfg, null, 2));
    const pick = (fn) => JSON.stringify(cfg.profiles.filter(fn));
    setOutput('rails', pick((p) => p.name === 'rails'));
    setOutput('js', pick((p) => p.name !== 'rails'));
    setOutput('scope', cfg.convention?.scope ?? 'changed');
    setOutput('granularity', cfg.convention?.granularity ?? 'line');
    const list = cfg.profiles.map((p) => `\`${p.name}\` @ \`${p.path}\``).join(', ') || '_không nhận diện được stack nào_';
    const src = process.env.BASE_SHA ? ` · config đọc từ base \`${process.env.BASE_SHA.slice(0, 7)}\`` : '';
    summary(`### Harness plan\nProfiles${cfg.detected ? ' (tự nhận diện)' : ''}: ${list} · ${cfg.rules.length} rule kiến trúc · scope: \`${cfg.convention?.scope}\`${src}`);
    console.log(JSON.stringify(cfg.profiles));
  } catch (e) {
    console.log(annotation({ severity: 'error', file: configPath, title: 'harness config', message: e.message }));
    process.exit(1);
  }
}
