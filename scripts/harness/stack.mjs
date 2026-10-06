// Chạy tool theo stack cho 1 profile, chuẩn hoá kết quả thành annotation (path tính từ root repo).
//   node stack.mjs js      → eslint, tsc, prettier, dependency-cruiser
//   node stack.mjs rails   → rubocop, brakeman, packwerk
// ENV: PROFILE_PATH, PROFILE_NAME, CHECKS (JSON), BASE_SHA, SCOPE, HARNESS_DIR
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addedLines, changedFiles, report, summary } from './lib.mjs';
import { DEFAULT_HARNESS_DIR } from './config.mjs';

const JS_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/;
const PRETTIER_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|css|scss|less|md|mdx|ya?ml|html|vue|graphql)$/;
const RUBY_FILE = /\.(rb|rake|ru|gemspec|jbuilder)$|(^|\/)(Gemfile|Rakefile)$/;
const DEPCRUISE = 'dependency-cruiser@18.5.0';
const BRAKEMAN = '8.1.0';
const tail = (s, n = 15) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

// ---------- Parser (export để test) ----------
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

/** Khoá so sánh lỗi giữa base và PR: bỏ số dòng (dòng xê dịch khi sửa file). */
export const findingKey = (f) => `${f.file}|${f.title}|${String(f.message).replace(/\b(line|column|dòng|cột)\s*\d+/gi, '$1 #')}`;

/**
 * Tách lỗi ở file KHÔNG đổi thành: có sẵn từ base (không chặn) và mới do PR gây ra (chặn).
 * baseline: Map<key, count> hoặc null (không dựng được base → coi là có sẵn, như trước).
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
  for (const e of data.errors ?? []) out.push({ severity: 'warn', title: 'brakeman', message: `Không phân tích được: ${e.error}`, file: e.location ? toRepo(e.location) : undefined });
  return out;
}

export function parseDepcruise(json, toRepo) {
  const out = [];
  for (const v of JSON.parse(json).summary?.violations ?? []) {
    if (!['error', 'warn'].includes(v.rule.severity)) continue;
    const cycle = (v.cycle ?? []).map((c) => (typeof c === 'string' ? c : c.name));
    out.push({
      severity: v.rule.severity, file: toRepo(v.from), title: `depcruise ${v.rule.name}`,
      message: cycle.length ? `Vòng import: ${[v.from, ...cycle].join(' → ')}` : `${v.from} → ${v.to}`,
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
    out.push({ severity: 'error', file: toRepo(m[1]), line: Number(m[2]), title: 'packwerk', message: msg.join(' ') || 'Vi phạm ranh giới package' });
  }
  return out;
}

/** Tìm lockfile gần nhất từ dir đi lên tới root. */
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
  // line: lint/format chỉ chặn lỗi ở dòng thêm/sửa (sửa 1 dòng trong file cũ không phải dọn cả file) · file: cả file đổi
  const granularity = env.GRANULARITY === 'file' ? 'file' : 'line';
  return {
    root, abs, base, scope, prefix, toRepo, changed, cleanup, granularity,
    /** Map<path mới, path cũ> của file đổi tên trong PR (theo root repo). */
    renames() {
      if (!base) return new Map();
      const out = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '-M', '--name-status', '--diff-filter=R', '-z', `${base}...HEAD`], { cwd: root, encoding: 'utf8' }).stdout ?? '';
      const parts = out.split('\0').filter(Boolean);
      const m = new Map();
      for (let i = 0; i + 2 < parts.length + 1; i += 3) if (parts[i]?.startsWith('R')) m.set(parts[i + 2], parts[i + 1]);
      return m;
    },
    /** Mọi file đổi trong PR (cả ngoài profile), path theo root repo. */
    changedAll() {
      return base ? changedFiles(base, root) : [];
    },
    /** Map<path từ root repo, Set<số dòng thêm>> so với base. */
    addedMap() {
      if (added === undefined) added = base ? new Map([...addedLines(base, root)].map(([f, ls]) => [f, new Set(ls.map((l) => l.line))])) : null;
      return added;
    },
    checks: JSON.parse(env.CHECKS || '{}'),
    harnessDir: env.HARNESS_DIR || DEFAULT_HARNESS_DIR,
    /** Checkout commit base ra thư mục tạm (git worktree), tạo 1 lần. null nếu không có base. */
    baseWorktree() {
      if (worktree !== undefined) return worktree;
      worktree = null;
      if (!base) return null;
      const dir = path.join(mkdtempSync(path.join(tmpdir(), 'harness-base-')), 'wt');
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

const firstExisting = (dir, names) => names.find((n) => existsSync(path.join(dir, n)));

/** Tìm binary của tool trong node_modules/.bin từ thư mục profile đi lên (hỗ trợ workspace hoist). Yarn PnP → `yarn <tool>`. */
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

/** Thư mục package.json gần nhất chứa file (theo checkout của PR). */
function nearestPkgDir(root, file) {
  let d = path.dirname(path.join(root, file));
  for (;;) {
    if (existsSync(path.join(d, 'package.json'))) return d;
    if (d === root || d === path.dirname(d)) return root;
    d = path.dirname(d);
  }
}

/**
 * Base có phải tự cài dependency không (thay vì mượn node_modules của PR qua symlink)?
 * Có, khi PR đổi manifest/lockfile, hoặc trong workspace PR đổi code ở package KHÁC (symlink workspace
 * trong node_modules trỏ về code của PR, nên base sẽ "thấy" thay đổi đó và coi lỗi do PR gây ra là có sẵn).
 */
function baseNeedsOwnDeps(ctx, pmDir) {
  const changed = ctx.changedAll();
  if (changed.some((f) => DEP_FILE.test(f))) return true;
  let workspace = existsSync(path.join(pmDir, 'pnpm-workspace.yaml'));
  try { workspace ||= !!JSON.parse(readFileSync(path.join(pmDir, 'package.json'), 'utf8')).workspaces; } catch { /* không có package.json ở root */ }
  return workspace && changed.some((f) => JS_EXT.test(f) && nearestPkgDir(ctx.root, f) !== ctx.abs);
}

/** Cài dependency tại dir. Trả về true nếu xong; với returnError trả về chuỗi lỗi thay vì false. */
function installDeps(ctx, dir, pm, noLock = !existsSync(path.join(dir, { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', npm: 'package-lock.json' }[pm] ?? 'bun.lock')), returnError = false) {
  if (['pnpm', 'yarn'].includes(pm) && ctx.run('corepack', ['--version'], { quiet: true }).code !== 0) {
    // Node ≥ 25 không còn kèm corepack → cài từ npm
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

/** Dùng node_modules của PR cho bản base (symlink), để chạy được tool ở base mà không cài lại. */
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

/** Giữ lỗi nằm trên dòng PR thêm/sửa (lỗi không có số dòng thì giữ). */
export function onlyAddedLines(findings, addedMap) {
  if (!addedMap) return { kept: findings, dropped: 0 };
  const kept = findings.filter((f) => !f.line || addedMap.get(f.file)?.has(f.line));
  return { kept, dropped: findings.length - kept.length };
}

function lineFilter(ctx, findings, notes, label) {
  if (ctx.granularity === 'file' || !ctx.changed) return findings;
  const { kept, dropped } = onlyAddedLines(findings, ctx.addedMap());
  if (dropped) notes.push(`${label}: ${dropped} lỗi ở dòng cũ của file đã sửa (không chặn, nên dọn dần).`);
  return kept;
}

/**
 * Lỗi lint ở file đã sửa: chạy lại tool trên bản base của chính các file đó, chỉ giữ lỗi KHÔNG có ở base
 * (so theo file + rule + message, không theo số dòng). Bắt được cả lỗi mới nằm ở dòng cũ — vd xoá chỗ dùng
 * biến làm biến đó thành unused. Không dựng được base thì lùi về lọc theo dòng thêm.
 * runOnBase(wt, wtAbs, relFiles) → findings với path theo repo (hoặc null nếu tool lỗi).
 */
function baselineFilter(ctx, findings, notes, label, runOnBase) {
  if (ctx.granularity === 'file' || !ctx.changed || !findings.length) return findings;
  const wt = ctx.baseWorktree();
  if (wt) {
    const wtAbs = path.join(wt, ctx.prefix);
    // File đổi tên: chạy base trên path CŨ rồi quy key về path mới, để nợ cũ không thành "lỗi mới"
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
      // Trùng key (cùng rule + message): coi lỗi ở dòng KHÔNG sửa là lỗi cũ trước, để lỗi mới báo đúng dòng PR thêm
      const added = ctx.addedMap();
      const onAdded = (f) => (added?.get(f.file)?.has(f.line) ? 1 : 0);
      const ordered = [...findings].sort((a, b) => onAdded(a) - onAdded(b));
      const { fresh, preexisting } = splitByBaseline(ordered, baseline);
      if (preexisting) notes.push(`${label}: ${preexisting} lỗi có sẵn từ base trong các file đã sửa (không chặn, nên dọn dần).`);
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
  if (dropped) notes.push(`${label}: ${dropped} lỗi có sẵn ở file không đổi trong PR (không chặn).`);
  return keep;
}

export function runJs(ctx) {
  const findings = [];
  const notes = [];
  const pkg = JSON.parse(readFileSync(path.join(ctx.abs, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // 1) Cài dependency (một lần ở thư mục chứa lockfile, hỗ trợ workspace)
  const { pm, dir, noLock } = detectPM(ctx.abs, ctx.root);
  if (noLock) findings.push({ severity: 'warn', file: ctx.toRepo('package.json'), title: 'deps', message: 'Không có lockfile: build không tái lập được. Commit lockfile.' });
  if (!existsSync(path.join(dir, 'node_modules'))) {
    const err = installDeps(ctx, dir, pm, noLock, true);
    if (err !== true) {
      findings.push({ severity: 'error', title: `${pm} install`, message: `Cài dependency thất bại: ${err}` });
      return { findings, notes };
    }
  }

  const changedJs = ctx.changed?.filter((f) => JS_EXT.test(f) && existsSync(path.join(ctx.abs, f)));
  const skipLint = ctx.changed && !changedJs.length;
  // Có config mà không có tool = cấu hình hỏng → lỗi (không âm thầm bỏ qua)
  const tool = (name, label) => {
    const b = resolveBin(name, ctx.abs, ctx.root);
    if (!b) findings.push({ severity: 'error', file: ctx.toRepo('package.json'), title: label, message: `Có config ${label} nhưng không tìm thấy ${name} trong node_modules. Thêm vào devDependencies.` });
    return b;
  };

  // 2) ESLint (config của repo)
  if (ctx.checks.eslint !== false) {
    const cfg = firstExisting(ctx.abs, ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts',
      '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc']) || pkg.eslintConfig;
    if (!cfg) {
      findings.push({ severity: 'warn', file: ctx.toRepo('package.json'), title: 'eslint', message: 'Chưa có ESLint config. Copy profiles/starter/react/eslint.config.mjs từ repo .github của org.' });
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
        } else findings.push({ severity: 'error', title: 'eslint', message: `ESLint lỗi khi chạy: ${tail(r.stderr || r.stdout, 5)}` });
      }
    }
  }

  // 3) TypeScript
  // tsc chạy cả khi PR chỉ đổi file không phải TS (vd package.json nâng version làm vỡ type ở chỗ khác)
  const NEXT_ENV = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n';
  // …và cả khi PR chỉ sửa package KHÁC trong workspace mà app này phụ thuộc (type có thể vỡ ở đây)
  const typecheckNeeded = !ctx.changed || ctx.changed.length > 0 || baseNeedsOwnDeps(ctx, dir);
  if (ctx.checks.typecheck !== false && typecheckNeeded && existsSync(path.join(ctx.abs, 'tsconfig.json'))) {
    // next-env.d.ts thường bị gitignore, thiếu nó tsc báo lỗi import ảnh/css
    if (deps.next && !existsSync(path.join(ctx.abs, 'next-env.d.ts'))) writeFileSync(path.join(ctx.abs, 'next-env.d.ts'), NEXT_ENV);
    const b = tool('tsc', 'tsc');
    if (b) {
      const tsc = (cwd, toRepo) => {
        const r = ctx.run(b[0], [...b[1], '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], { quiet: true, cwd });
        return { r, errs: parseTsc(r.stdout, toRepo) };
      };
      const { r, errs } = tsc(ctx.abs, ctx.toRepo);
      if (r.code !== 0 && !errs.length) findings.push({ severity: 'error', title: 'tsc', message: `tsc lỗi: ${tail(r.stdout + r.stderr, 5)}` });
      if (!ctx.changed) findings.push(...errs);
      else {
        const set = new Set(ctx.changed.map((f) => ctx.prefix + f));
        // granularity file: file đổi phải sạch hoàn toàn; line: chỉ chặn lỗi không có ở base
        const strict = ctx.granularity === 'file' ? errs.filter((f) => set.has(f.file)) : [];
        findings.push(...strict);
        const rest = errs.filter((f) => !strict.includes(f));
        let baseline = null;
        const wt = rest.length ? ctx.baseWorktree() : null;
        if (wt && existsSync(path.join(wt, ctx.prefix, 'tsconfig.json'))) {
          // Chạy tsc trên bản base để biết lỗi nào là do PR gây ra.
          // Dùng chung node_modules của PR chỉ an toàn khi PR không đổi dependency hay package workspace khác:
          // nếu đổi, base phải tự cài dependency của chính nó (symlink workspace sẽ trỏ về code của PR).
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
          // Không dựng được base đáng tin → không phân biệt được lỗi cũ/mới → chặn tất cả (an toàn hơn bỏ lọt)
          findings.push(...rest.map((f) => ({ ...f, message: `${f.message} (không so được với base nên tính là lỗi)` })));
        } else {
          const { fresh, preexisting } = splitByBaseline(rest, baseline);
          findings.push(...fresh.map((f) => (set.has(f.file) ? f : { ...f, message: `${f.message} (lỗi mới ở file không đổi, do thay đổi trong PR gây ra)` })));
          if (preexisting) notes.push(`tsc: ${preexisting} lỗi có sẵn từ base (không chặn, nên dọn dần).`);
        }
      }
    }
  }

  // 4) Prettier (chỉ khi repo đã chọn dùng Prettier)
  const prettierCfg = firstExisting(ctx.abs, ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js',
    '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts']) || pkg.prettier;
  const prettierTargets = ctx.changed ? ctx.changed.filter((f) => PRETTIER_EXT.test(f) && existsSync(path.join(ctx.abs, f))) : ['.'];
  const pb = ctx.checks.prettier !== false && prettierCfg && prettierTargets.length ? tool('prettier', 'prettier') : null;
  if (pb) {
    const r = ctx.run(pb[0], [...pb[1], '--list-different', '--ignore-unknown', ...prettierTargets], { quiet: true });
    if (r.code === 1) {
      const unformatted = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      // File vốn chưa format từ base (repo cũ) → chỉ cảnh báo; format cả file nên làm ở PR riêng cho dễ review
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
          ? { severity: 'warn', file: ctx.toRepo(f), title: 'prettier', message: 'File vốn chưa format từ trước. Nên format cả file ở một PR riêng.' }
          : { severity: 'error', file: ctx.toRepo(f), title: 'prettier', message: `Chưa format. Chạy: npx prettier --write ${f}` });
      }
    } else if (r.code !== 0) {
      findings.push({ severity: 'error', title: 'prettier', message: `Prettier lỗi: ${tail(r.stderr, 5)}` });
    }
  }

  // 5) Kiến trúc import: dependency-cruiser
  if (ctx.checks.depcruise !== false && !skipLint) {
    const dirs = (ctx.checks.depcruise_dirs ?? ['src', 'app', 'lib']).filter((d) => existsSync(path.join(ctx.abs, d)));
    if (dirs.length) {
      const own = firstExisting(ctx.abs, ['.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs', '.dependency-cruiser.json']);
      const cfg = own ? path.join(ctx.abs, own) : path.join(ctx.harnessDir, 'profiles/starter/react/.dependency-cruiser.cjs');
      const tsArgs = existsSync(path.join(ctx.abs, 'tsconfig.json')) ? ['--ts-config', 'tsconfig.json'] : [];
      const r = ctx.run('npx', ['-y', '-p', DEPCRUISE, '-p', 'typescript@5', 'depcruise', '--config', cfg, '--output-type', 'json', ...tsArgs, ...dirs], { quiet: true });
      if (r.stdout.trim().startsWith('{')) findings.push(...onlyChanged(ctx, parseDepcruise(r.stdout, ctx.toRepo), notes, 'depcruise'));
      else findings.push({ severity: 'warn', title: 'depcruise', message: `Không chạy được dependency-cruiser: ${tail(r.stderr, 3)}` });
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

  // 1) RuboCop (bản trong Gemfile.lock của repo, đúng config của repo)
  if (ctx.checks.rubocop !== false) {
    if (!has('rubocop')) {
      findings.push({ severity: 'warn', file: ctx.toRepo('Gemfile'), title: 'rubocop', message: 'Chưa có rubocop trong Gemfile. Thêm gem "rubocop-rails-omakase" và copy profiles/starter/rails/.rubocop.yml.' });
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
      } else findings.push({ severity: 'error', title: 'rubocop', message: `RuboCop lỗi khi chạy: ${tail(r.stderr, 5)}` });
    }
  }

  // 2) Brakeman (security cho Rails)
  if (ctx.checks.brakeman !== false) {
    let cmd = ['bundle', ['exec', 'brakeman']];
    if (!has('brakeman')) {
      const i = ctx.run('gem', ['install', 'brakeman', '-v', BRAKEMAN, '--no-document']);
      // gọi bằng đường dẫn đầy đủ: thư mục bin của gem không phải lúc nào cũng nằm trong PATH
      const bindir = ctx.run('ruby', ['-e', 'print Gem.bindir'], { quiet: true }).stdout.trim();
      cmd = i.code === 0 ? [bindir ? path.join(bindir, 'brakeman') : 'brakeman', []] : null;
      if (!cmd) findings.push({ severity: 'warn', title: 'brakeman', message: `Không cài được brakeman: ${tail(i.stderr, 3)}` });
    }
    if (cmd) {
      const brakeman = (target) => {
        const out = path.join(mkdtempSync(path.join(tmpdir(), 'brakeman-')), 'out.json');
        const r = ctx.run(cmd[0], [...cmd[1], '-q', '--no-pager', '--no-exit-on-warn', '--no-exit-on-error', '-w2', '-f', 'json', '-o', out, target]);
        return existsSync(out) ? { warnings: readFileSync(out, 'utf8') } : { error: tail(r.stderr, 5) };
      };
      const head = brakeman('.');
      if (head.error) findings.push({ severity: 'error', title: 'brakeman', message: `Brakeman lỗi: ${head.error}` });
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
            // Brakeman ở base: fingerprint ổn định khi dòng xê dịch → biết cảnh báo nào mới do PR
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
            findings.push(...fresh.map((f) => (set.has(f.file) ? f : { ...f, message: `${f.message} — mới do thay đổi trong PR` })));
            if (preexisting) notes.push(`brakeman: ${preexisting} cảnh báo có sẵn từ base (không chặn).`);
          }
        }
      }
    }
  }

  // 3) Packwerk (ranh giới package), nếu repo dùng
  const pw = ctx.checks.packwerk;
  if (pw === true || (pw === 'auto' && existsSync(path.join(ctx.abs, 'packwerk.yml')))) {
    if (!has('packwerk')) {
      findings.push({ severity: 'warn', title: 'packwerk', message: 'Có packwerk.yml nhưng gem packwerk chưa có trong Gemfile.' });
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
  // push/schedule (không có base): quét toàn bộ để thấy nợ kỹ thuật nhưng chỉ cảnh báo, trừ khi repo chọn scope: all
  const informational = !ctx.base && process.env.SCOPE !== 'all';
  const findings = informational ? result.findings.map((f) => ({ ...f, severity: 'warn' })) : result.findings;
  const { notes } = result;
  const errors = report(`${process.env.PROFILE_NAME || kind} @ ${process.env.PROFILE_PATH || '.'} (scope ${ctx.scope}${informational ? ', chỉ báo cáo' : ''})`, findings);
  if (notes.length) summary(notes.map((n) => `> ${n}`).join('\n'));
  process.exit(errors ? 1 : 0);
}
