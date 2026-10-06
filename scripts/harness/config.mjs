// Read harness config: profiles/base.yml ← profiles/<stack>.yml ← the repo's .github/harness.yml.
// CLI: node config.mjs plan   → print the run plan (which profiles, in which directories) for the workflow.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deepMerge, joinPath, loadYaml, loadYamlAt, readText, setOutput, summary, trackedFiles, annotation } from './lib.mjs';

export const PROFILES = ['rails', 'react', 'node'];
export const DEFAULT_HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_PROFILES = 8;
const SKIP_DIR = /(^|\/)(node_modules|vendor|fixtures|examples?|test|spec|tmp|dist|build)\//;

/** Auto-detect stacks from the list of tracked files. read(path) → content or null. */
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
      // Don't inspect Gemfile.lock: gems/engines also pull rails into the lock without being a Rails app
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
    console.log(annotation({ severity: 'warn', title: 'harness', message: `Detected ${found.length} profiles; only the first ${MAX_PROFILES} will run. Declare profiles in .github/harness.yml.` }));
  }
  return found.slice(0, MAX_PROFILES);
}

function validateRule(r, where) {
  const problems = [];
  if (!r.id) problems.push('missing id');
  if (!Array.isArray(r.paths) || !r.paths.length) problems.push('missing paths');
  if (!r.forbid) problems.push('missing forbid');
  for (const k of ['forbid', 'allow', 'if_file_matches']) {
    if (r[k]) try { new RegExp(r[k]); } catch (e) { problems.push(`${k} is not a valid regex: ${e.message}`); }
  }
  if (r.severity && !['error', 'warn'].includes(r.severity)) problems.push('severity must be error|warn');
  if (problems.length) throw new Error(`Rule ${r.id ?? '(no id)'} in ${where}: ${problems.join('; ')}`);
}

/**
 * configRef: the commit to read .github/harness.yml from. On a PR this is always the BASE — a PR cannot loosen
 * the config that grades it; harness.yml changes only take effect after merge (and require a reviewer).
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
    if (!PROFILES.includes(p.name)) throw new Error(`Profile "${p.name}" does not exist (available: ${PROFILES.join(', ')})`);
  }

  const { profiles: _p, architecture: _a, checks: _c, ...rest } = repo;
  const merged = deepMerge(base, rest);
  const disabled = new Set(repo.architecture?.disable ?? []);
  // Lower/raise a default rule's severity, e.g. { "rails/view-no-query": warn } when onboarding a repo with lots of debt
  const severityOverride = repo.architecture?.severity ?? {};
  const rules = [];
  const notices = [];
  const out = profiles.map((p) => {
    const def = loadYaml(path.join(harnessDir, `profiles/${p.name}.yml`)) ?? {};
    for (const r of def.architecture?.rules ?? []) {
      // Org security rules cannot be disabled/downgraded from the repo (skip individual lines with harness-disable-line → needs a reviewer)
      if (r.security && (disabled.has(r.id) || severityOverride[r.id] === 'warn')) {
        notices.push(`Security rule ${r.id} cannot be disabled or downgraded from harness.yml; this setting is ignored.`);
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
    console.error('Usage: node config.mjs plan');
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
    const list = cfg.profiles.map((p) => `\`${p.name}\` @ \`${p.path}\``).join(', ') || '_no stack detected_';
    const src = process.env.BASE_SHA ? ` · config read from base \`${process.env.BASE_SHA.slice(0, 7)}\`` : '';
    summary(`### Harness plan\nProfiles${cfg.detected ? ' (auto-detected)' : ''}: ${list} · ${cfg.rules.length} architecture rule(s) · scope: \`${cfg.convention?.scope}\`${src}`);
    console.log(JSON.stringify(cfg.profiles));
  } catch (e) {
    console.log(annotation({ severity: 'error', file: configPath, title: 'harness config', message: e.message }));
    process.exit(1);
  }
}
