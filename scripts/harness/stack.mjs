// Run the stack's tools for one profile and normalize results into annotations (paths relative to the repo root).
//   node stack.mjs js      → eslint, tsc, prettier, dependency-cruiser
//   node stack.mjs rails   → rubocop, brakeman, packwerk
// ENV: PROFILE_PATH, PROFILE_NAME, CHECKS (JSON), BASE_SHA, SCOPE, HARNESS_DIR
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addedLines, changedFiles, report, summary } from './lib.mjs';
import { DEFAULT_HARNESS_DIR } from './config.mjs';

const JS_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/;
const PRETTIER_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|css|scss|less|md|mdx|ya?ml|html|vue|graphql)$/;
const RUBY_FILE = /\.(rb|rake|ru|gemspec|jbuilder)$|(^|\/)(Gemfile|Rakefile)$/;
const DEPCRUISE = 'dependency-cruiser@18.5.0';
const DEPCRUISE_TS = 'typescript@5.9.3'; // depcruise does not support TS 7 (the Go port) yet
const BRAKEMAN = '8.1.0';
const tail = (s, n = 15) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

// ---------- Parsers (exported for tests) ----------
export function parseEslint(json, toRepo) {
  const out = [];
  for (const file of JSON.parse(json)) {
    for (const m of file.messages) {
      if (!m.ruleId && /File ignored|no matching configuration/i.test(m.message)) continue;
      out.push({
        severity: m.fatal || m.severity === 2 ? 'error' : 'warn',
        file: toRepo(file.filePath), line: m.line, title: m.ruleId ? `eslint ${m.ruleId}` : 'eslint', message: m.message,
      });
    }
  }
  return out;
}

export function parseTsc(text, toRepo) {
  const out = [];
  for (const l of text.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l.trim());
    if (m) out.push({ severity: 'error', file: toRepo(m[1]), line: Number(m[2]), title: `tsc ${m[4]}`, message: m[5] });
  }
  return out;
}

/** Key for comparing findings between base and PR: drops line numbers (lines shift when a file is edited). */
export const findingKey = (f) => `${f.file}|${f.title}|${String(f.message).replace(/\b(line|column)\s*\d+/gi, '$1 #')}`;

/**
 * Split findings in UNCHANGED files into: pre-existing on base (non-blocking) and new ones caused by the PR (blocking).
 * baseline: Map<key, count> or null (base could not be built → treat as pre-existing, as before).
 */
export function splitByBaseline(outside, baseline, keyFn = findingKey) {
  if (!baseline) return { fresh: [], preexisting: outside.length };
  const left = new Map(baseline);
  const fresh = [];
  let preexisting = 0;
  for (const f of outside) {
    const k = keyFn(f);
    if ((left.get(k) ?? 0) > 0) { left.set(k, left.get(k) - 1); preexisting++; } else fresh.push(f);
  }
  return { fresh, preexisting };
}

export function parseRubocop(json, toRepo) {
  const out = [];
  for (const f of JSON.parse(json).files ?? []) {
    for (const o of f.offenses) {
      if (o.severity === 'info') continue;
      out.push({
        severity: 'error', file: toRepo(f.path), line: o.location?.start_line ?? o.location?.line,
        title: `rubocop ${o.cop_name}`, message: o.message,
      });
    }
  }
  return out;
}

export function parseBrakeman(json, toRepo, failAt = 'Medium') {
  const data = JSON.parse(json);
  const rank = { High: 3, Medium: 2, Weak: 1 };
  const out = (data.warnings ?? []).map((w) => ({
    severity: (rank[w.confidence] ?? 0) >= (rank[failAt] ?? 2) ? 'error' : 'warn',
    file: toRepo(w.file), line: w.line ?? undefined,
    title: `brakeman ${w.warning_type}`, message: `${w.message} (${w.confidence})${w.link ? ` ${w.link}` : ''}`,
    fingerprint: w.fingerprint,
  }));
  for (const e of data.errors ?? []) out.push({ severity: 'warn', title: 'brakeman', message: `Could not analyze: ${e.error}`, file: e.location ? toRepo(e.location) : undefined });
  return out;
}

export function parseDepcruise(json, toRepo) {
  const out = [];
  for (const v of JSON.parse(json).summary?.violations ?? []) {
    if (!['error', 'warn'].includes(v.rule.severity)) continue;
    const cycle = (v.cycle ?? []).map((c) => (typeof c === 'string' ? c : c.name));
    out.push({
      severity: v.rule.severity, file: toRepo(v.from), title: `depcruise ${v.rule.name}`,
      message: cycle.length ? `Import cycle: ${[v.from, ...cycle].join(' → ')}` : `${v.from} → ${v.to}`,
      related: [v.from, v.to, ...cycle].map(toRepo),
    });
  }
  return out;
}

export function parsePackwerk(text, toRepo) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S+\.(?:rb|rake|erb)):(\d+):\d+$/.exec(lines[i].trim());
    if (!m) continue;
    const msg = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !/^\S+\.(rb|rake|erb):\d+:\d+$/.test(lines[j].trim()); j++) msg.push(lines[j].trim());
    out.push({ severity: 'error', file: toRepo(m[1]), line: Number(m[2]), title: 'packwerk', message: msg.join(' ') || 'Package boundary violation' });
  }
  return out;
}

/** Find the nearest lockfile walking up from dir to root. */
export function detectPM(dir, root) {
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
  let d = path.resolve(dir);
  const stop = path.resolve(root);
  for (;;) {
    for (const [f, pm] of locks) if (existsSync(path.join(d, f))) return { pm, dir: d };
    if (d === stop || d === path.dirname(d)) return { pm: 'npm', dir: path.resolve(dir), noLock: true };
    d = path.dirname(d);
  }
}

// ---------- Runner ----------
export function makeContext(env = process.env, root = process.cwd()) {
  const profilePath = env.PROFILE_PATH || '.';
  const abs = path.resolve(root, profilePath);
  const base = env.BASE_SHA || '';
  const scope = base ? (env.SCOPE || 'changed') : 'all';
  const prefix = profilePath === '.' || profilePath === './' ? '' : `${profilePath.replace(/^\.\//, '').replace(/\/$/, '')}/`;
  const toRepo = (p) => {
    if (!p) return p;
    const a = path.isAbsolute(p) ? p : path.resolve(abs, p);
    return path.relative(root, a).split(path.sep).join('/');
  };
  const changed = scope === 'changed' && base
    ? changedFiles(base, root).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
    : null;
  const cleanup = [];
  let worktree;
  let added;
  // line: lint/format only blocks problems on added/modified lines (editing one line of an old file doesn't require cleaning the whole file) · file: the whole changed file
  const granularity = env.GRANULARITY === 'file' ? 'file' : 'line';
  return {
    root, abs, base, scope, prefix, toRepo, changed, cleanup, granularity,
    /** Map<new path, old path> of files renamed in the PR (relative to the repo root). */
    renames() {
      if (!base) return new Map();
      const out = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '-M', '--name-status', '--diff-filter=R', '-z', `${base}...HEAD`], { cwd: root, encoding: 'utf8' }).stdout ?? '';
      const parts = out.split('\0').filter(Boolean);
      const m = new Map();
      for (let i = 0; i + 2 < parts.length + 1; i += 3) if (parts[i]?.startsWith('R')) m.set(parts[i + 2], parts[i + 1]);
      return m;
    },
    /** Every file changed in the PR (including outside the profile), paths relative to the repo root. */
    changedAll() {
      return base ? changedFiles(base, root) : [];
    },
    /** Map<path from repo root, Set<added line numbers>> relative to base. */
    addedMap() {
      if (added === undefined) added = base ? new Map([...addedLines(base, root)].map(([f, ls]) => [f, new Set(ls.map((l) => l.line))])) : null;
      return added;
    },
    checks: JSON.parse(env.CHECKS || '{}'),
    harnessDir: env.HARNESS_DIR || DEFAULT_HARNESS_DIR,
    /** Check out the base commit into a temp directory (git worktree), created once. null if there is no base. */
    baseWorktree() {
      if (worktree !== undefined) return worktree;
      worktree = null;
      if (!base) return null;
      // realpath: the macOS tmpdir (/var → /private/var) is a symlink and tools return the real path → baseline keys would mismatch
      const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-base-'))), 'wt');
      const r = spawnSync('git', ['worktree', 'add', '--detach', dir, base], { cwd: root, encoding: 'utf8' });
      if (r.status === 0) {
        worktree = dir;
        cleanup.push(() => spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }));
      }
      return worktree;
    },
    run(cmd, args, opts = {}) {
      console.log(`::group::${cmd} ${args.join(' ').slice(0, 200)}`);
      const r = spawnSync(cmd, args, { cwd: opts.cwd ?? abs, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...opts.env } });
      if (!opts.quiet) console.log(tail(r.stdout, 40), tail(r.stderr, 40));
      console.log('::endgroup::');
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
    },
  };
}

/**
 * Install dependency-cruiser + typescript into a separate directory (once per process). Not `npx -p`: when the repo already has
 * typescript in node_modules, npx doesn't install typescript next to depcruise → depcruise can't find the TS transpiler
 * and silently skips every .ts/.tsx file while still exiting 0.
 */
let depcruiseCache;
function depcruiseBin(ctx) {
  if (depcruiseCache !== undefined) return depcruiseCache;
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-depcruise-'));
  const i = ctx.run('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', DEPCRUISE, DEPCRUISE_TS], { quiet: true });
  depcruiseCache = i.code === 0 ? path.join(dir, 'node_modules', '.bin', 'depcruise') : null;
  return depcruiseCache;
}

const firstExisting = (dir, names) => names.find((n) => existsSync(path.join(dir, n)));

/** Find a tool's binary in node_modules/.bin walking up from the profile directory (supports workspace hoisting). Yarn PnP → `yarn <tool>`. */
export function resolveBin(tool, fromDir, rootDir) {
  let d = path.resolve(fromDir);
  const stop = path.resolve(rootDir);
  for (;;) {
    const p = path.join(d, 'node_modules', '.bin', tool);
    if (existsSync(p)) return [p, []];
    if (existsSync(path.join(d, '.pnp.cjs'))) return ['yarn', [tool]];
    if (d === stop || d === path.dirname(d)) return null;
    d = path.dirname(d);
  }
}

const DEP_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?|\.pnp\.c?js)$/;

/** Nearest directory containing a package.json for the file (in the PR checkout). */
function nearestPkgDir(root, file) {
  let d = path.dirname(path.join(root, file));
  for (;;) {
    if (existsSync(path.join(d, 'package.json'))) return d;
    if (d === root || d === path.dirname(d)) return root;
    d = path.dirname(d);
  }
}

/**
 * Does the base need its own dependency install (instead of borrowing the PR's node_modules via symlink)?
 * Yes, when the PR changes a manifest/lockfile, or in a workspace the PR changes code in ANOTHER package (workspace symlinks
 * in node_modules point at the PR's code, so the base would "see" that change and treat problems caused by the PR as pre-existing).
 */
function baseNeedsOwnDeps(ctx, pmDir) {
  const changed = ctx.changedAll();
  if (changed.some((f) => DEP_FILE.test(f))) return true;
  let workspace = existsSync(path.join(pmDir, 'pnpm-workspace.yaml'));
  try { workspace ||= !!JSON.parse(readFileSync(path.join(pmDir, 'package.json'), 'utf8')).workspaces; } catch { /* no package.json at root */ }
  return workspace && changed.some((f) => JS_EXT.test(f) && nearestPkgDir(ctx.root, f) !== ctx.abs);
}

/** Install dependencies in dir. Returns true on success; with returnError, returns the error string instead of false. */
function installDeps(ctx, dir, pm, noLock = !existsSync(path.join(dir, { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', npm: 'package-lock.json' }[pm] ?? 'bun.lock')), returnError = false) {
  if (['pnpm', 'yarn'].includes(pm) && ctx.run('corepack', ['--version'], { quiet: true }).code !== 0) {
    // Node ≥ 25 no longer ships corepack → install it from npm
    ctx.run('npm', ['install', '-g', 'corepack@latest'], { quiet: true });
  }
  const steps = {
    pnpm: [['corepack', ['enable']], ['pnpm', ['install', '--frozen-lockfile']]],
    yarn: [['corepack', ['enable']], ['yarn', existsSync(path.join(dir, '.yarnrc.yml')) ? ['install', '--immutable'] : ['install', '--frozen-lockfile']]],
    bun: [['npx', ['-y', 'bun@1', 'install', '--frozen-lockfile']]],
    npm: [['npm', noLock ? ['install'] : ['ci']]],
  }[pm];
  for (const [cmd, args] of steps) {
    const r = ctx.run(cmd, args, { cwd: dir });
    if (r.code !== 0) return returnError ? tail(r.stderr || r.stdout, 5) : false;
  }
  return true;
}

/** Reuse the PR's node_modules for the base (symlink) so tools can run on the base without reinstalling. */
function linkNodeModules(ctx, wt) {
  let d = ctx.abs;
  for (;;) {
    const nm = path.join(d, 'node_modules');
    const target = path.join(wt, path.relative(ctx.root, d), 'node_modules');
    if (existsSync(nm) && !existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(nm, target, 'dir');
    }
    if (d === ctx.root || d === path.dirname(d)) return;
    d = path.dirname(d);
  }
}

/** Keep findings on lines the PR added/modified (findings without a line number are kept). */
export function onlyAddedLines(findings, addedMap) {
  if (!addedMap) return { kept: findings, dropped: 0 };
  const kept = findings.filter((f) => !f.line || addedMap.get(f.file)?.has(f.line));
  return { kept, dropped: findings.length - kept.length };
}

function lineFilter(ctx, findings, notes, label) {
  if (ctx.granularity === 'file' || !ctx.changed) return findings;
  const { kept, dropped } = onlyAddedLines(findings, ctx.addedMap());
  if (dropped) notes.push(`${label}: ${dropped} problem(s) on unchanged lines of modified files (non-blocking; clean up gradually).`);
  return kept;
}

/**
 * Lint problems in modified files: rerun the tool on the base version of those same files and keep only problems NOT on base
 * (compared by file + rule + message, not line number). This also catches new problems on old lines — e.g. removing a usage
 * of a variable makes it unused. If the base can't be built, fall back to filtering by added lines.
 * runOnBase(wt, wtAbs, relFiles) → findings with repo-relative paths (or null if the tool failed).
 */
function baselineFilter(ctx, findings, notes, label, runOnBase) {
  if (ctx.granularity === 'file' || !ctx.changed || !findings.length) return findings;
  const wt = ctx.baseWorktree();
  if (wt) {
    const wtAbs = path.join(wt, ctx.prefix);
    // Renamed files: run the base on the OLD path, then map keys to the new path so existing debt doesn't become "new problems"
    const renames = ctx.renames();
    const back = new Map();
    const rel = [];
    for (const f of new Set(findings.map((x) => x.file).filter(Boolean))) {
      const src = renames.get(f) ?? f;
      if (!src.startsWith(ctx.prefix) || !existsSync(path.join(wt, src))) continue;
      rel.push(src.slice(ctx.prefix.length));
      back.set(src, f);
    }
    const baseFindings = rel.length ? runOnBase(wt, wtAbs, rel) : [];
    if (baseFindings) {
      const baseline = new Map();
      for (const f of baseFindings) {
        const k = findingKey({ ...f, file: back.get(f.file) ?? f.file });
        baseline.set(k, (baseline.get(k) ?? 0) + 1);
      }
      // Duplicate keys (same rule + message): count problems on UNMODIFIED lines as pre-existing first, so new problems are reported on the lines the PR added
      const added = ctx.addedMap();
      const onAdded = (f) => (added?.get(f.file)?.has(f.line) ? 1 : 0);
      const ordered = [...findings].sort((a, b) => onAdded(a) - onAdded(b));
      const { fresh, preexisting } = splitByBaseline(ordered, baseline);
      if (preexisting) notes.push(`${label}: ${preexisting} pre-existing problem(s) from base in modified files (non-blocking; clean up gradually).`);
      return fresh.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
    }
  }
  return lineFilter(ctx, findings, notes, label);
}

function onlyChanged(ctx, findings, notes, label) {
  if (!ctx.changed) return findings;
  const set = new Set(ctx.changed.map((f) => ctx.prefix + f));
  const keep = findings.filter((f) => set.has(f.file) || (f.related ?? []).some((x) => set.has(x)));
  const dropped = findings.length - keep.length;
  if (dropped) notes.push(`${label}: ${dropped} pre-existing problem(s) in files not changed by the PR (non-blocking).`);
  return keep;
}

export function runJs(ctx) {
  const findings = [];
  const notes = [];
  const pkg = JSON.parse(readFileSync(path.join(ctx.abs, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // 1) Install dependencies (once, in the lockfile's directory; supports workspaces)
  const { pm, dir, noLock } = detectPM(ctx.abs, ctx.root);
  if (noLock) findings.push({ severity: 'warn', file: ctx.toRepo('package.json'), title: 'deps', message: 'No lockfile: builds are not reproducible. Commit a lockfile.' });
  if (!existsSync(path.join(dir, 'node_modules'))) {
    const err = installDeps(ctx, dir, pm, noLock, true);
    if (err !== true) {
      findings.push({ severity: 'error', title: `${pm} install`, message: `Dependency install failed: ${err}` });
      return { findings, notes };
    }
  }

  const changedJs = ctx.changed?.filter((f) => JS_EXT.test(f) && existsSync(path.join(ctx.abs, f)));
  const skipLint = ctx.changed && !changedJs.length;
  // Config present but tool missing = broken setup → error (don't silently skip)
  const tool = (name, label) => {
    const b = resolveBin(name, ctx.abs, ctx.root);
    if (!b) findings.push({ severity: 'error', file: ctx.toRepo('package.json'), title: label, message: `Found a ${label} config but ${name} is not in node_modules. Add it to devDependencies.` });
    return b;
  };

  // 2) ESLint (the repo's config)
  if (ctx.checks.eslint !== false) {
    const cfg = firstExisting(ctx.abs, ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts',
      '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc']) || pkg.eslintConfig;
    if (!cfg) {
      findings.push({ severity: 'warn', file: ctx.toRepo('package.json'), title: 'eslint', message: 'No ESLint config. Copy profiles/starter/react/eslint.config.mjs from the org .github repo.' });
    } else if (!skipLint) {
      const b = tool('eslint', 'eslint');
      if (b) {
        const eslint = (cwd, files) => ctx.run(b[0], [...b[1], '--format', 'json', '--no-error-on-unmatched-pattern', ...files], { quiet: true, cwd });
        const r = eslint(ctx.abs, changedJs ?? ['.']);
        if (r.stdout.trim().startsWith('[')) {
          findings.push(...baselineFilter(ctx, parseEslint(r.stdout, ctx.toRepo), notes, 'eslint', (wt, wtAbs, rel) => {
            if (b[0] === 'yarn') return null;
            linkNodeModules(ctx, wt);
            const rb = eslint(wtAbs, rel);
            const toRepoBase = (p) => path.relative(wt, path.resolve(wtAbs, p)).split(path.sep).join('/');
            return rb.stdout.trim().startsWith('[') ? parseEslint(rb.stdout, toRepoBase) : null;
          }));
        } else findings.push({ severity: 'error', title: 'eslint', message: `ESLint failed to run: ${tail(r.stderr || r.stdout, 5)}` });
      }
    }
  }

  // 3) TypeScript
  // tsc runs even when the PR only changes non-TS files (e.g. a package.json version bump breaking types elsewhere)
  const NEXT_ENV = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n';
  // …and also when the PR only changes ANOTHER workspace package this app depends on (types may break here)
  const typecheckNeeded = !ctx.changed || ctx.changed.length > 0 || baseNeedsOwnDeps(ctx, dir);
  if (ctx.checks.typecheck !== false && typecheckNeeded && existsSync(path.join(ctx.abs, 'tsconfig.json'))) {
    // next-env.d.ts is usually gitignored; without it tsc errors on image/css imports
    if (deps.next && !existsSync(path.join(ctx.abs, 'next-env.d.ts'))) writeFileSync(path.join(ctx.abs, 'next-env.d.ts'), NEXT_ENV);
    const b = tool('tsc', 'tsc');
    if (b) {
      const tsc = (cwd, toRepo) => {
        const r = ctx.run(b[0], [...b[1], '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], { quiet: true, cwd });
        return { r, errs: parseTsc(r.stdout, toRepo) };
      };
      const { r, errs } = tsc(ctx.abs, ctx.toRepo);
      if (r.code !== 0 && !errs.length) findings.push({ severity: 'error', title: 'tsc', message: `tsc failed: ${tail(r.stdout + r.stderr, 5)}` });
      if (!ctx.changed) findings.push(...errs);
      else {
        const set = new Set(ctx.changed.map((f) => ctx.prefix + f));
        // granularity file: changed files must be fully clean; line: only block problems not present on base
        const strict = ctx.granularity === 'file' ? errs.filter((f) => set.has(f.file)) : [];
        findings.push(...strict);
        const rest = errs.filter((f) => !strict.includes(f));
        let baseline = null;
        const wt = rest.length ? ctx.baseWorktree() : null;
        if (wt && existsSync(path.join(wt, ctx.prefix, 'tsconfig.json'))) {
          // Run tsc on the base to tell which errors the PR caused.
          // Sharing the PR's node_modules is only safe when the PR doesn't change dependencies or other workspace packages:
          // if it does, the base must install its own dependencies (workspace symlinks would point at the PR's code).
          const wtAbs = path.join(wt, ctx.prefix);
          const risky = baseNeedsOwnDeps(ctx, dir);
          const ready = risky ? installDeps(ctx, path.join(wt, path.relative(ctx.root, dir)), pm) : (linkNodeModules(ctx, wt), true);
          if (ready) {
            if (deps.next && !existsSync(path.join(wtAbs, 'next-env.d.ts'))) writeFileSync(path.join(wtAbs, 'next-env.d.ts'), NEXT_ENV);
            const tb = risky ? resolveBin('tsc', wtAbs, wt) : b;
            const toRepoBase = (p) => path.relative(wt, path.resolve(wtAbs, p)).split(path.sep).join('/');
            const renames = new Map([...ctx.renames()].map(([n, o]) => [o, n]));
            if (tb) {
              const rb = ctx.run(tb[0], [...tb[1], '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], { quiet: true, cwd: wtAbs });
              baseline = new Map();
              for (const f of parseTsc(rb.stdout, toRepoBase)) {
                const k = findingKey({ ...f, file: renames.get(f.file) ?? f.file });
                baseline.set(k, (baseline.get(k) ?? 0) + 1);
              }
            }
          }
        }
        if (!baseline) {
          // No trustworthy base → can't tell old from new errors → block all (safer than letting them through)
          findings.push(...rest.map((f) => ({ ...f, message: `${f.message} (could not compare with base, so counted as an error)` })));
        } else {
          const { fresh, preexisting } = splitByBaseline(rest, baseline);
          findings.push(...fresh.map((f) => (set.has(f.file) ? f : { ...f, message: `${f.message} (new error in an unchanged file, caused by changes in this PR)` })));
          if (preexisting) notes.push(`tsc: ${preexisting} pre-existing error(s) from base (non-blocking; clean up gradually).`);
        }
      }
    }
  }

  // 4) Prettier (only if the repo has opted into Prettier)
  const prettierCfg = firstExisting(ctx.abs, ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js',
    '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts']) || pkg.prettier;
  const prettierTargets = ctx.changed ? ctx.changed.filter((f) => PRETTIER_EXT.test(f) && existsSync(path.join(ctx.abs, f))) : ['.'];
  const pb = ctx.checks.prettier !== false && prettierCfg && prettierTargets.length ? tool('prettier', 'prettier') : null;
  if (pb) {
    const r = ctx.run(pb[0], [...pb[1], '--list-different', '--ignore-unknown', ...prettierTargets], { quiet: true });
    if (r.code === 1) {
      const unformatted = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      // File was already unformatted on base (legacy repo) → warn only; formatting the whole file belongs in a separate PR for easier review
      let legacy = new Set();
      const wt = ctx.granularity === 'line' && ctx.changed && pb[0] !== 'yarn' ? ctx.baseWorktree() : null;
      if (wt) {
        const wtAbs = path.join(wt, ctx.prefix);
        const existed = unformatted.filter((f) => existsSync(path.join(wtAbs, f)));
        if (existed.length) {
          linkNodeModules(ctx, wt);
          const rb = ctx.run(pb[0], [...pb[1], '--list-different', '--ignore-unknown', ...existed], { quiet: true, cwd: wtAbs });
          legacy = new Set(rb.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
        }
      }
      for (const f of unformatted) {
        findings.push(legacy.has(f)
          ? { severity: 'warn', file: ctx.toRepo(f), title: 'prettier', message: 'File was already unformatted before this PR. Format the whole file in a separate PR.' }
          : { severity: 'error', file: ctx.toRepo(f), title: 'prettier', message: `Not formatted. Run: npx prettier --write ${f}` });
      }
    } else if (r.code !== 0) {
      findings.push({ severity: 'error', title: 'prettier', message: `Prettier failed: ${tail(r.stderr, 5)}` });
    }
  }

  // 5) Import architecture: dependency-cruiser
  if (ctx.checks.depcruise !== false && !skipLint) {
    const dirs = (ctx.checks.depcruise_dirs ?? ['src', 'app', 'lib']).filter((d) => existsSync(path.join(ctx.abs, d)));
    if (dirs.length) {
      const own = firstExisting(ctx.abs, ['.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs', '.dependency-cruiser.json']);
      const cfg = own ? path.join(ctx.abs, own) : path.join(ctx.harnessDir, 'profiles/starter/react/.dependency-cruiser.cjs');
      const tsArgs = existsSync(path.join(ctx.abs, 'tsconfig.json')) ? ['--ts-config', 'tsconfig.json'] : [];
      const bin = depcruiseBin(ctx);
      const r = bin ? ctx.run(bin, ['--config', cfg, '--output-type', 'json', ...tsArgs, ...dirs], { quiet: true }) : null;
      if (r?.stdout.trim().startsWith('{')) {
        findings.push(...onlyChanged(ctx, parseDepcruise(r.stdout, ctx.toRepo), notes, 'depcruise'));
        // No files cruised although the repo has TS/JS → the tool is a "false green" (e.g. missing TypeScript transpiler)
        if (!JSON.parse(r.stdout).summary?.totalCruised && (changedJs ?? []).some((f) => dirs.some((d) => f.startsWith(`${d}/`)))) {
          findings.push({ severity: 'warn', title: 'depcruise', message: `dependency-cruiser did not scan any files in ${dirs.join(', ')} — import architecture rules were not checked.` });
        }
      } else findings.push({ severity: 'warn', title: 'depcruise', message: `Could not run dependency-cruiser: ${tail(r?.stderr ?? 'install failed', 3)}` });
    }
  }
  return { findings, notes };
}

export function runRails(ctx) {
  const findings = [];
  const notes = [];
  const lock = existsSync(path.join(ctx.abs, 'Gemfile.lock')) ? readFileSync(path.join(ctx.abs, 'Gemfile.lock'), 'utf8') : '';
  const has = (gem) => new RegExp(`^ {4}${gem} \\(`, 'm').test(lock);
  const changedRb = ctx.changed?.filter((f) => RUBY_FILE.test(f) && existsSync(path.join(ctx.abs, f)));

  // 1) RuboCop (the version in the repo's Gemfile.lock, with the repo's config)
  if (ctx.checks.rubocop !== false) {
    if (!has('rubocop')) {
      findings.push({ severity: 'warn', file: ctx.toRepo('Gemfile'), title: 'rubocop', message: 'No rubocop in Gemfile. Add gem "rubocop-rails-omakase" and copy profiles/starter/rails/.rubocop.yml.' });
    } else if (!ctx.changed || changedRb.length) {
      const rubocop = (cwd, files) => ctx.run('bundle', ['exec', 'rubocop', '--format', 'json', '--force-exclusion', ...files],
        { quiet: true, cwd, env: { BUNDLE_GEMFILE: path.join(ctx.abs, 'Gemfile') } });
      const r = rubocop(ctx.abs, changedRb ?? []);
      if (r.stdout.trim().startsWith('{')) {
        findings.push(...baselineFilter(ctx, parseRubocop(r.stdout, ctx.toRepo), notes, 'rubocop', (wt, wtAbs, rel) => {
          const rb = rubocop(wtAbs, rel);
          const toRepoBase = (p) => path.relative(wt, path.resolve(wtAbs, p)).split(path.sep).join('/');
          return rb.stdout.trim().startsWith('{') ? parseRubocop(rb.stdout, toRepoBase) : null;
        }));
      } else findings.push({ severity: 'error', title: 'rubocop', message: `RuboCop failed to run: ${tail(r.stderr, 5)}` });
    }
  }

  // 2) Brakeman (Rails security)
  if (ctx.checks.brakeman !== false) {
    let cmd = ['bundle', ['exec', 'brakeman']];
    if (!has('brakeman')) {
      const i = ctx.run('gem', ['install', 'brakeman', '-v', BRAKEMAN, '--no-document']);
      // call by full path: the gem bin directory isn't always on PATH
      const bindir = ctx.run('ruby', ['-e', 'print Gem.bindir'], { quiet: true }).stdout.trim();
      cmd = i.code === 0 ? [bindir ? path.join(bindir, 'brakeman') : 'brakeman', []] : null;
      if (!cmd) findings.push({ severity: 'warn', title: 'brakeman', message: `Could not install brakeman: ${tail(i.stderr, 3)}` });
    }
    if (cmd) {
      const brakeman = (target) => {
        const out = path.join(mkdtempSync(path.join(tmpdir(), 'brakeman-')), 'out.json');
        const r = ctx.run(cmd[0], [...cmd[1], '-q', '--no-pager', '--no-exit-on-warn', '--no-exit-on-error', '-w2', '-f', 'json', '-o', out, target]);
        return existsSync(out) ? { warnings: readFileSync(out, 'utf8') } : { error: tail(r.stderr, 5) };
      };
      const head = brakeman('.');
      if (head.error) findings.push({ severity: 'error', title: 'brakeman', message: `Brakeman failed: ${head.error}` });
      else {
        const all = parseBrakeman(head.warnings, ctx.toRepo, ctx.checks.brakeman_fail_confidence);
        if (!ctx.changed) findings.push(...all);
        else {
          const set = new Set(ctx.changed.map((f) => ctx.prefix + f));
          const strict = all.filter((f) => !f.file || (ctx.granularity === 'file' && set.has(f.file)));
          findings.push(...strict);
          const outside = all.filter((f) => !strict.includes(f));
          let baseline = null;
          const wt = outside.length ? ctx.baseWorktree() : null;
          if (wt) {
            // Brakeman on base: fingerprints are stable when lines shift → tells which warnings are new in the PR
            const b = brakeman(path.join(wt, ctx.prefix));
            if (!b.error) {
              baseline = new Map();
              for (const w of JSON.parse(b.warnings).warnings ?? []) baseline.set(w.fingerprint, (baseline.get(w.fingerprint) ?? 0) + 1);
            }
          }
          if (!baseline) {
            findings.push(...outside.filter((f) => set.has(f.file)));
          } else {
            const { fresh, preexisting } = splitByBaseline(outside, baseline, (f) => f.fingerprint);
            findings.push(...fresh.map((f) => (set.has(f.file) ? f : { ...f, message: `${f.message} — new, caused by changes in this PR` })));
            if (preexisting) notes.push(`brakeman: ${preexisting} pre-existing warning(s) from base (non-blocking).`);
          }
        }
      }
    }
  }

  // 3) Packwerk (package boundaries), if the repo uses it
  const pw = ctx.checks.packwerk;
  if (pw === true || (pw === 'auto' && existsSync(path.join(ctx.abs, 'packwerk.yml')))) {
    if (!has('packwerk')) {
      findings.push({ severity: 'warn', title: 'packwerk', message: 'packwerk.yml exists but the packwerk gem is not in the Gemfile.' });
    } else if (!ctx.changed || changedRb.length) {
      const r = ctx.run('bundle', ['exec', 'packwerk', 'check', ...(changedRb ?? [])], { quiet: true });
      const v = parsePackwerk(r.stdout, ctx.toRepo);
      if (r.code !== 0 && !v.length) findings.push({ severity: 'error', title: 'packwerk', message: tail(r.stdout + r.stderr, 5) });
      findings.push(...v);
    }
  }
  return { findings, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const kind = process.argv[2];
  const ctx = makeContext();
  let result;
  try {
    result = kind === 'rails' ? runRails(ctx) : runJs(ctx);
  } finally {
    for (const fn of ctx.cleanup) fn();
  }
  // push/schedule (no base): scan everything to surface tech debt but only warn, unless the repo chose scope: all
  const informational = !ctx.base && process.env.SCOPE !== 'all';
  const findings = informational ? result.findings.map((f) => ({ ...f, severity: 'warn' })) : result.findings;
  const { notes } = result;
  const errors = report(`${process.env.PROFILE_NAME || kind} @ ${process.env.PROFILE_PATH || '.'} (scope ${ctx.scope}${informational ? ', report only' : ''})`, findings);
  if (notes.length) summary(notes.map((n) => `> ${n}`).join('\n'));
  process.exit(errors ? 1 : 0);
}
