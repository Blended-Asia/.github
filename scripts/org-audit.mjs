#!/usr/bin/env node
// Scan every repo in the org → compliance report; with FIX=true, open PRs that adopt the standard workflows.
// No npm install needed (Node >= 20, uses built-in fetch).
//
// ENV:
//   GH_TOKEN         GitHub App token (recommended) or PAT. Required permissions: Contents R/W, Pull requests R/W,
//                    Workflows R/W (FIX only), Administration R, Deployments R, Metadata R
//   ORG              org name
//   FIX              "true" to open fix PRs
//   ONLY             limit to these repos, e.g. "api,web"
//   GUARD_REF        ref of the standard workflows, default v1
//   PLATFORM_OWNERS  e.g. "@my-org/platform": add CODEOWNERS for .github/workflows if the repo has none
//   OUT_DIR          where to write report.md / report.json (default: current directory)

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadYaml } from './harness/lib.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_CHECKS = ['org / pr-convention', 'harness / gate'];
const STALE_DAYS = 180;

export function config(env = process.env) {
  if (!env.ORG || !env.GH_TOKEN) throw new Error('Missing ORG or GH_TOKEN');
  return {
    org: env.ORG,
    token: env.GH_TOKEN,
    api: env.GITHUB_API_URL || 'https://api.github.com',
    fix: env.FIX === 'true',
    only: (env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
    ref: env.GUARD_REF || 'v1',
    owners: env.PLATFORM_OWNERS || '',
    outDir: env.OUT_DIR || '.',
    quiet: env.QUIET === 'true', // the repo running the audit is public → don't print repo names to the log
  };
}

// ---------- GitHub API ----------
export function client(cfg) {
  async function req(method, url, body, allow = []) {
    const res = await fetch(url.startsWith('http') ? url : cfg.api + url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'org-audit',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(res.status)) return { status: res.status, data: null, res };
    if (!res.ok) {
      const err = new Error(`${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data: res.status === 204 ? null : await res.json(), res };
  }
  return {
    req,
    get: (url, allow) => req('GET', url, undefined, allow),
    async paginate(url) {
      let out = [];
      let next = url;
      while (next) {
        const { data, res } = await req('GET', next);
        out = out.concat(Array.isArray(data) ? data : data.repositories ?? []);
        next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
      }
      return out;
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Compare callers with templates ----------
const CALLERS = {
  'org-harness.yml': 'workflow-templates/org-harness.yml',
  'org-pr-convention.yml': 'workflow-templates/org-pr-convention.yml',
  'org-vercel-preview.yml': 'workflow-templates/org-vercel-preview.yml',
};
// Inputs that loosen checks when a repo overrides them → shown in the report for platform review
const WEAKENING = ['semgrep', 'stacks', 'fail_severity', 'ignore_unfixed', 'supabase_db_checks', 'advisors_fail_on',
  'migration_immutable', 'migration_order', 'hadolint_threshold', 'hadolint_ignore', 'misconfig_ignore', 'deno_check',
  'ignore_bots', 'branch_pattern', 'required_sections', 'env_file_allowlist', 'title_types', 'fail_on', 'advisors_ignore'];

/** Strip comments, `with:`/`secrets:` blocks, ref and org name → the rest must match the template exactly. */
export function normalizeCaller(text, branch = 'main') {
  const out = [];
  let skip = -1;
  for (const raw of text.replaceAll('$default-branch', branch).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = line.match(/^ */)[0].length;
    if (skip >= 0) {
      if (ind > skip) continue;
      skip = -1;
    }
    if (/^\s*(with|secrets):$/.test(line)) { skip = ind; continue; }
    out.push(line
      .replace(/[\w.-]+(?=\/\.github\/\.github\/workflows\/)/g, 'ORG')
      .replace(/(\.github\/workflows\/[\w-]+\.yml)@[\w./-]+/g, '$1@REF'));
  }
  return out.join('\n');
}

/** The `key: value` pairs in the caller's `with:` block. */
export function callerOverrides(text) {
  const out = {};
  let withIndent = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = line.match(/^ */)[0].length;
    if (withIndent >= 0 && ind <= withIndent) withIndent = -1;
    if (/^\s*with:\s*$/.test(line)) { withIndent = ind; continue; }
    const m = withIndent >= 0 && line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** Where .github/harness.yml is looser than the org defaults. */
export function harnessWeakening(cfg) {
  const out = [];
  const disabled = cfg?.architecture?.disable ?? [];
  if (disabled.length) out.push(`disables rule ${disabled.join(', ')}`);
  const downgraded = Object.entries(cfg?.architecture?.severity ?? {}).filter(([, v]) => v === 'warn').map(([k]) => k);
  if (downgraded.length) out.push(`downgrades to warning: ${downgraded.join(', ')}`);
  for (const [profile, checks] of Object.entries(cfg?.checks ?? {})) {
    for (const [tool, v] of Object.entries(checks ?? {})) if (v === false) out.push(`disables ${profile}.${tool}`);
  }
  for (const p of cfg?.profiles ?? []) {
    for (const [tool, v] of Object.entries(p?.checks ?? {})) if (v === false) out.push(`disables ${p.name}.${tool}`);
  }
  if (cfg?.merge?.human_required_paths) out.push('replaces the list of paths that need human review');
  if (cfg?.merge?.suppression_markers) out.push('replaces the list of check-suppression markers');
  if ((cfg?.merge?.bot_approve?.max_lines ?? 0) > 500) out.push(`bot auto-approves PRs up to ${cfg.merge.bot_approve.max_lines} lines`);
  const blockOn = cfg?.review?.block_on;
  if (blockOn && !(blockOn.includes('critical') && blockOn.includes('major'))) out.push(`AI review only blocks on ${blockOn.join('/') || 'nothing'}`);
  if (cfg?.review?.override_label) out.push(`changes the AI override label to "${cfg.review.override_label}"`);
  if (cfg?.review?.diff_exclude) out.push('replaces the list of files hidden from AI review');

  return out;
}

/** CODEOWNERS: the LAST matching line decides the owner (same as GitHub). */
export function codeownersFor(text, file) {
  const toRe = (pat) => {
    let p = pat.replace(/^\//, '');
    const anchored = pat.startsWith('/') || p.replace(/\/$/, '').includes('/');
    p = p.replace(/\/$/, '');
    const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
    return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
  };
  let owners = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pat, ...who] = line.split(/\s+/);
    if (toRe(pat).test(file)) owners = who;
  }
  return owners ?? [];
}

// ---------- Working branch ----------
async function readHarnessConfig(gh, base, ref) {
  const hc = await gh.get(`${base}/contents/.github/harness.yml?ref=${encodeURIComponent(ref)}`, [404]);
  if (!hc.data?.content) return { exists: false };
  try {
    const tmp = path.join(await mkdtemp(path.join(tmpdir(), 'harness-')), 'h.yml');
    await writeFile(tmp, unb64(hc.data.content));
    return { exists: true, cfg: loadYaml(tmp) };
  } catch (e) {
    return { exists: true, error: e };
  }
}

/**
 * The branch whose PRs are gated and that the adoption PR targets:
 * gate.branches (first literal branch, read from develop then default) → a develop branch exists (git-flow) → default branch.
 */
export async function workBranch(gh, cfg, repo) {
  const base = `/repos/${cfg.org}/${repo.name}`;
  const dev = repo.default_branch === 'develop' ? null : await gh.get(`${base}/branches/develop`, [404]);
  const candidates = dev?.data ? ['develop', repo.default_branch] : [repo.default_branch];
  for (const ref of candidates) {
    const { cfg: hcfg } = await readHarnessConfig(gh, base, ref);
    const list = Array.isArray(hcfg?.gate?.branches) ? hcfg.gate.branches.map(String) : [];
    const literal = list.find((b) => b && !/[*?[{]/.test(b));
    if (literal) return { branch: literal, source: `gate.branches in harness.yml (${ref})` };
  }
  if (dev?.data) return { branch: 'develop', source: 'develop branch exists (git-flow)' };
  return { branch: repo.default_branch, source: 'default branch' };
}

// ---------- Audit one repo ----------
export async function auditRepo(gh, cfg, repo) {
  const r = {
    name: repo.name,
    url: repo.html_url,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    branch: repo.default_branch,
    defaultBranch: repo.default_branch,
    stacks: [],
    checks: {},
    findings: [],
    fixes: [],
    workflowFiles: {},
  };
  const add = (level, msg) => r.findings.push({ level, msg });
  const base = `/repos/${cfg.org}/${repo.name}`;

  const tree0 = await gh.get(`${base}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`, [404, 409]);
  if (!tree0.data) {
    add('info', 'Empty repo');
    r.empty = true;
    return r;
  }
  // git-flow repo: audit the working branch (develop), not the default branch
  const wb = await workBranch(gh, cfg, repo);
  r.branch = wb.branch;
  if (r.branch !== repo.default_branch) add('info', `Audited branch \`${r.branch}\` (${wb.source}); default branch is \`${repo.default_branch}\``);
  const ref = encodeURIComponent(r.branch);
  const tree = r.branch === repo.default_branch ? tree0 : await gh.get(`${base}/git/trees/${ref}?recursive=1`, [404, 409]);
  if (!tree.data) {
    add('info', 'Empty repo');
    r.empty = true;
    return r;
  }
  if (tree.data.truncated) add('info', 'Repo too large, file tree truncated — detection may be incomplete');
  const files = tree.data.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  const has = (re) => files.some((f) => re.test(f));

  // Stack
  if (has(/(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$|(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/)) r.stacks.push('docker');
  if (has(/(^|\/)supabase\/config\.toml$/)) r.stacks.push('supabase');
  let vercel = has(/(^|\/)vercel\.json$/);
  if (!vercel) {
    const d = await gh.get(`${base}/deployments?per_page=10`, [403, 404]);
    vercel = (d.data ?? []).some((x) => x.creator?.login === 'vercel[bot]');
  }
  if (vercel) r.stacks.push('vercel');
  if (has(/(^|\/)next\.config\.(js|mjs|ts|cjs)$/)) r.stacks.push('next');
  if (has(/(^|\/)config\/application\.rb$/)) r.stacks.push('rails');
  r.hasHarnessConfig = files.includes('.github/harness.yml');
  if (r.hasHarnessConfig) {
    const hc = await readHarnessConfig(gh, base, r.branch);
    if (hc.exists) {
      try {
        if (hc.error) throw hc.error;
        const hcfg = hc.cfg;
        const weak = harnessWeakening(hcfg);
        if (weak.length) add('warn', `\`harness.yml\` loosens checks: ${weak.join('; ')}`);
        if (hcfg?.enforcement === 'observe') {
          r.observe = true;
          add('info', 'In observe mode (`enforcement: observe`): gate does not block, no auto-approve/merge');
        }
      } catch (e) {
        add('high', `\`.github/harness.yml\` is unreadable (${e.message.split('\n')[0].slice(0, 80)}): harness will fail`);
      }
    }
  }

  // Leaks in the repo
  const envFiles = files.filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/\.env(\.[^/.]+)*\.(example|sample|template|defaults)$/.test(f));
  for (const f of envFiles) add('critical', `Env file committed: \`${f}\` → remove it from git + rotate secrets`);
  if (has(/(^|\/)\.vercel\//)) add('critical', '`.vercel/` directory committed');

  // Workflows using the org's reusable workflows
  const wfPaths = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).slice(0, 30);
  const usesRe = new RegExp(`${escRe(cfg.org)}/\\.github/\\.github/workflows/(security|infra|stack|harness|pr-convention|vercel-preview)\\.yml@([\\w./-]+)`, 'gi');
  const found = {};
  for (const p of wfPaths) {
    const c = await gh.get(`${base}/contents/${enc(p)}?ref=${ref}`, [404]);
    if (!c.data?.content) continue;
    const text = unb64(c.data.content);
    for (const m of text.matchAll(usesRe)) {
      found[m[1].toLowerCase()] = { path: p, ref: m[2] };
      r.workflowFiles[p] = text;
    }
  }
  const state = (...names) => {
    const hits = names.map((n) => found[n]);
    if (hits.some((h) => !h)) return 'fail';
    return hits.every((h) => h.ref === cfg.ref) ? 'pass' : 'warn';
  };
  r.checks.harness = state('security', 'infra', 'stack', 'harness');
  r.checks.convention = state('pr-convention');
  if (r.checks.harness === 'warn' || r.checks.convention === 'warn') add('warn', `Org workflows pinned to an old ref (expected ${cfg.ref})`);
  r.found = found;
  if (vercel && !found['vercel-preview']) r.missingPreview = true;

  // Caller modified outside `with:` (e.g. an added `if:` that skips a job) or loosened config
  for (const [p, text] of Object.entries(r.workflowFiles)) {
    const tpl = CALLERS[path.basename(p)];
    if (tpl) {
      const expected = normalizeCaller(await readFile(path.join(ROOT, tpl), 'utf8'), r.branch);
      if (normalizeCaller(text, r.branch) !== expected) {
        add('high', `\`${p}\` differs from the template outside \`with:\`; needs review (may have been modified to evade checks)`);
        if (p.endsWith('org-harness.yml')) r.checks.harness = 'warn';
        if (p.endsWith('org-pr-convention.yml')) r.checks.convention = 'warn';
      }
    } else {
      add('info', `Org workflows called from \`${p}\` (custom file name); cannot compare with the template`);
    }
    const weak = Object.entries(callerOverrides(text)).filter(([k]) => WEAKENING.includes(k));
    if (weak.length) add('warn', `Override in \`${path.basename(p)}\`: ${weak.map(([k, v]) => `${k}=${v || '""'}`).join(', ')}`);
  }

  // Branch protection / ruleset
  const br = ref;
  const rules = await gh.get(`${base}/rules/branches/${br}`, [403, 404]);
  const types = new Set((rules.data ?? []).map((x) => x.type));
  const contexts = (rules.data ?? [])
    .filter((x) => x.type === 'required_status_checks')
    .flatMap((x) => x.parameters?.required_status_checks ?? [])
    .map((x) => x.context);
  let codeOwnerReview = (rules.data ?? []).some((x) => x.type === 'pull_request' && x.parameters?.require_code_owner_review);
  let readable = rules.data !== null;
  // Classic branch protection (not part of rulesets)
  const branch = await gh.get(`${base}/branches/${br}`, [403, 404]);
  if (branch.data?.protected) {
    const prot = await gh.get(`${base}/branches/${br}/protection`, [403, 404]);
    if (prot.data) {
      readable = true;
      if (prot.data.required_pull_request_reviews) types.add('pull_request');
      if (prot.data.required_pull_request_reviews?.require_code_owner_reviews) codeOwnerReview = true;
      const rsc = prot.data.required_status_checks;
      contexts.push(...(rsc?.checks ?? []).map((c) => c.context), ...(rsc?.contexts ?? []));
    } else if (!types.has('pull_request')) {
      types.add('protected');
    }
  }
  if (!readable && !branch.data?.protected) {
    r.checks.protection = r.visibility === 'public' ? 'fail' : 'unknown';
  } else {
    const checksOk = types.has('workflows') || REQUIRED_CHECKS.every((c) => contexts.includes(c));
    r.checks.protection = types.has('pull_request') && checksOk ? 'pass'
      : types.has('pull_request') || types.has('protected') ? 'warn' : 'fail';
    if (r.checks.protection === 'warn') add('warn', 'Branch is protected but does not require PR + checks harness / gate + org / pr-convention');
  }
  if (r.checks.protection === 'fail') add(r.visibility === 'public' ? 'high' : 'warn', `Branch \`${r.branch}\` is unprotected (direct pushes allowed)`);

  // Ownership + dependency updates
  const coPath = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((p) => files.includes(p));
  if (!coPath) {
    r.checks.codeowners = 'fail';
  } else {
    const co = await gh.get(`${base}/contents/${enc(coPath)}?ref=${br}`, [404]);
    const text = co.data?.content ? unb64(co.data.content) : '';
    // Both the harness caller and its config need an owner, otherwise devs can change the rules they're graded by
    const uncovered = ['.github/workflows/org-harness.yml', '.github/harness.yml'].filter((f) => !codeownersFor(text, f).length);
    const owners = uncovered.length ? [] : ['ok'];
    r.checks.codeowners = owners.length ? 'pass' : 'warn';
    if (!owners.length) add('warn', `\`${coPath}\` has no owner for ${uncovered.map((f) => `\`${f}\``).join(', ')}: devs can change the harness in a PR without review`);
    else if (!codeOwnerReview && r.checks.protection !== 'unknown') add('warn', 'CODEOWNERS not enforced (enable "Require review from Code Owners")');
  }
  r.checks.depsBot = has(/^\.github\/dependabot\.ya?ml$|(^|\/)renovate\.json5?$|^\.github\/renovate\.json5?$/) ? 'pass' : 'fail';
  r.hasPrTemplate = has(/(^|\/)pull_request_template\.md$/i) || has(/(^|\/)PULL_REQUEST_TEMPLATE\//i);

  const va = await gh.get(`${base}/vulnerability-alerts`, [403, 404]);
  r.checks.vulnAlerts = va.status === 204 ? 'pass' : va.status === 404 ? 'fail' : 'unknown';
  if (r.checks.vulnAlerts === 'fail') add('warn', 'Dependabot alerts are disabled (free, should be enabled)');

  let sa = repo.security_and_analysis;
  if (r.visibility === 'public' && !sa) sa = (await gh.get(base, [403, 404])).data?.security_and_analysis;
  if (r.visibility === 'public' && sa && sa.secret_scanning_push_protection?.status !== 'enabled') {
    add('high', 'Public repo without Secret scanning push protection (free for public repos)');
  }

  const days = (Date.now() - new Date(repo.pushed_at).getTime()) / 86400000;
  if (days > STALE_DAYS) add('info', `No pushes in ${Math.floor(days)} days — consider archiving`);
  return r;
}

// ---------- Open fix PRs ----------
async function template(cfg, file, branch) {
  const t = await readFile(path.join(ROOT, file), 'utf8');
  return t
    .replace(/[\w.-]+(?=\/\.github\/\.github\/workflows\/)/g, cfg.org)
    .replaceAll('$default-branch', branch)
    .replace(/(\/\.github\/workflows\/[\w-]+\.yml)@v1\b/g, `$1@${cfg.ref}`);
}

export async function planFixes(cfg, r, repo) {
  const out = [];
  const bumpRef = (text) => text.replace(
    new RegExp(`(${escRe(cfg.org)}/\\.github/\\.github/workflows/[\\w-]+\\.yml)@[\\w./-]+`, 'gi'),
    `$1@${cfg.ref}`,
  );
  // File exists but pins an old ref → only bump the ref, keep the `with:` config
  for (const [p, text] of Object.entries(r.workflowFiles)) {
    const next = bumpRef(text);
    if (next !== text) out.push({ path: p, content: next, message: `ci: bump org workflows to ${cfg.ref}` });
  }
  if (!r.found.security || !r.found.infra || !r.found.stack || !r.found.harness) {
    out.push({ path: '.github/workflows/org-harness.yml', content: await template(cfg, 'workflow-templates/org-harness.yml', r.branch), message: 'ci: add org harness workflow' });
  }
  if (!r.found['pr-convention']) {
    out.push({ path: '.github/workflows/org-pr-convention.yml', content: await template(cfg, 'workflow-templates/org-pr-convention.yml', r.branch), message: 'ci: add org PR convention check' });
  }
  if (r.missingPreview) {
    out.push({ path: '.github/workflows/org-vercel-preview.yml', content: await template(cfg, 'workflow-templates/org-vercel-preview.yml', r.branch), message: 'ci: add Vercel preview check' });
  }
  if (!r.hasHarnessConfig) {
    let starter = await readFile(path.join(ROOT, 'profiles/starter/harness.yml'), 'utf8');
    // Working branch differs from the default branch (git-flow) → gate that branch, otherwise every PR into develop is skipped
    if (r.branch !== (r.defaultBranch ?? repo.default_branch)) {
      starter = starter.replace(/# gate:\n#   branches: \[develop\]\n/, `gate:\n  branches: [${JSON.stringify(r.branch)}]\n`);
    }
    out.push({ path: '.github/harness.yml', content: starter, message: 'ci: add harness config' });
  }
  if (!r.hasPrTemplate) {
    out.push({ path: '.github/pull_request_template.md', content: await readFile(path.join(ROOT, 'pull_request_template.md'), 'utf8'), message: 'docs: add PR template' });
  }
  if (cfg.owners && r.checks.codeowners === 'fail') {
    out.push({ path: '.github/CODEOWNERS', content: `# CI and harness config changes require platform review\n/.github/ ${cfg.owners}\n`, message: 'chore: add CODEOWNERS for .github' });
  }
  // Dedupe by path (later entries override earlier ones)
  return [...new Map(out.map((f) => [f.path, f])).values()];
}

export async function openFixPr(gh, cfg, repo, files, target = repo.default_branch) {
  const base = `/repos/${cfg.org}/${repo.name}`;
  const branch = `ci/org-harness-${cfg.ref.replace(/[^\w.-]/g, '-')}`;
  const head = await gh.get(`${base}/git/ref/heads/${encodeURIComponent(target)}`);
  const open = await gh.get(`${base}/pulls?state=open&head=${encodeURIComponent(`${cfg.org}:${branch}`)}`);
  const created = await gh.req('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.data.object.sha }, [422]);
  if (created.status === 422 && !open.data.length) {
    // Leftover branch (previous PR merged/closed) → reset it to the target branch so old commits aren't pulled in
    await gh.req('PATCH', `${base}/git/refs/heads/${branch}`, { sha: head.data.object.sha, force: true });
  }
  for (const f of files) {
    const cur = await gh.get(`${base}/contents/${enc(f.path)}?ref=${encodeURIComponent(branch)}`, [404]);
    if (cur.data?.content && unb64(cur.data.content) === f.content) continue;
    await gh.req('PUT', `${base}/contents/${enc(f.path)}`, {
      message: f.message, content: b64(f.content), branch, ...(cur.data?.sha ? { sha: cur.data.sha } : {}),
    });
  }
  if (open.data.length) return open.data[0].html_url;
  const body = [
    '## Summary',
    `Adopt the org's standard workflows (\`${cfg.ref}\`):`,
    ...files.map((f) => `- \`${f.path}\` — ${f.message}`),
    '',
    'This PR was opened automatically by org-audit.',
    ...(files.some((f) => f.path === '.github/harness.yml') ? [
      '',
      'After merge, the repo is in **observe mode** (`enforcement: observe`): the harness comments "would block because…" but does not block merging.',
      'For repos with an existing codebase, follow `docs/onboarding-existing-repo.md` in the `.github` repo (measure debt, write ARCHITECTURE.md, tune rules) before switching to `enforce`.',
    ] : []),
    '',
    '## How to test',
    'The `org / pr-convention` and `harness / gate` checks run on this PR right away (with the default config, since `harness.yml` only takes effect after merge). If no ruleset applies to this repo yet, a red gate caused by existing debt will not block merging this PR.',
  ].join('\n');
  const pr = await gh.req('POST', `${base}/pulls`, {
    title: `ci: adopt org harness (${cfg.ref})`, head: branch, base: target, body,
  });
  return pr.data.html_url;
}

// ---------- Report ----------
const ICON = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '❔' };
const LEVEL = { critical: '🔴', high: '🟠', warn: '🟡', info: '⚪' };

export function render(cfg, results) {
  const active = results.filter((r) => !r.empty);
  const fails = (r) => Object.values(r.checks).filter((v) => v === 'fail').length
    + r.findings.filter((f) => f.level === 'critical').length * 3;
  active.sort((a, b) => fails(b) - fails(a) || a.name.localeCompare(b.name));
  const crit = active.flatMap((r) => r.findings.filter((f) => ['critical', 'high'].includes(f.level)).map((f) => ({ ...f, repo: r.name })));
  const compliant = active.filter((r) => ['harness', 'convention', 'protection'].every((k) => r.checks[k] === 'pass')).length;

  const lines = [
    `# Org compliance report — ${cfg.org}`,
    '',
    `Updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · standard workflows: \`${cfg.ref}\``,
    '',
    `**${compliant}/${active.length}** repos fully compliant (harness + convention + protection) · **${crit.length}** serious issues · **${active.filter((r) => r.observe).length}** repos in observe mode`,
    '',
  ];
  if (crit.length) {
    lines.push('## Needs immediate action', '');
    for (const f of crit) lines.push(`- ${LEVEL[f.level]} **${f.repo}**: ${f.msg}`);
    lines.push('');
  }
  lines.push(
    '## By repo', '',
    '| Repo | Stack | Harness | Convention | Protection | CODEOWNERS | Deps bot | Vuln alerts | Notes |',
    '|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|',
  );
  for (const r of active) {
    const c = r.checks;
    const notes = r.findings.filter((f) => !['critical', 'high'].includes(f.level)).map((f) => `${LEVEL[f.level]} ${f.msg}`);
    if (r.prUrl) notes.push(`🔧 [Fix PR](${r.prUrl})`);
    else if (r.fixes.length) notes.push(`🔧 will fix: ${r.fixes.map((f) => '`' + path.basename(f.path) + '`').join(', ')}`);
    lines.push(`| [${r.name}](${r.url})${r.visibility === 'public' ? ' 🌐' : ''} | ${r.stacks.join(', ') || '-'} | ${ICON[c.harness]} | ${ICON[c.convention]} | ${ICON[c.protection]} | ${ICON[c.codeowners]} | ${ICON[c.depsBot]} | ${ICON[c.vulnAlerts]} | ${notes.join('<br>')} |`);
  }
  const empty = results.filter((r) => r.empty).map((r) => r.name);
  if (empty.length) lines.push('', `Empty repos (skipped): ${empty.join(', ')}`);
  lines.push('', '<sub>✅ pass · ⚠️ partial/old ref · ❌ missing · ❔ insufficient read permission · 🌐 public</sub>');
  return lines.join('\n');
}

// ---------- Main ----------
export async function main(env = process.env) {
  const cfg = config(env);
  const gh = client(cfg);
  let repos = await gh.paginate(`/orgs/${cfg.org}/repos?type=all&per_page=100`);
  repos = repos.filter((r) => !r.archived && !r.fork && !r.disabled && r.name !== '.github');
  if (cfg.only.length) repos = repos.filter((r) => cfg.only.includes(r.name));
  console.log(`Scanning ${repos.length} repos in ${cfg.org}${cfg.fix ? ' (FIX)' : ''}${cfg.quiet ? ' (quiet)' : ''}`);

  const results = [];
  for (const repo of repos) {
    try {
      const r = await auditRepo(gh, cfg, repo);
      if (!r.empty) {
        r.fixes = await planFixes(cfg, r, repo);
        if (cfg.fix && r.fixes.length) r.prUrl = await openFixPr(gh, cfg, repo, r.fixes, r.branch);
      }
      results.push(r);
      if (!cfg.quiet) console.log(`- ${repo.name}: ${JSON.stringify(r.checks)}${r.prUrl ? ` → ${r.prUrl}` : ''}`);
    } catch (e) {
      console.error(cfg.quiet ? '::warning::Error scanning a repo (see report)' : `::warning::${repo.name}: ${e.message}`);
      results.push({ name: repo.name, url: repo.html_url, visibility: repo.visibility, stacks: [], fixes: [],
        checks: { harness: 'unknown', convention: 'unknown', protection: 'unknown', codeowners: 'unknown', depsBot: 'unknown', vulnAlerts: 'unknown' },
        findings: [{ level: 'warn', msg: `Error while scanning: ${e.message.slice(0, 120)}` }] });
    }
  }

  const md = render(cfg, results);
  const json = results.map(({ workflowFiles, found, ...rest }) => ({ ...rest, fixes: rest.fixes.map((f) => f.path) }));
  await writeFile(path.join(cfg.outDir, 'report.md'), md);
  await writeFile(path.join(cfg.outDir, 'report.json'), JSON.stringify(json, null, 2));
  if (env.GITHUB_STEP_SUMMARY && !cfg.quiet) await writeFile(env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  const critical = results.some((r) => r.findings.some((f) => f.level === 'critical'));
  return { results, md, critical };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(({ critical }) => {
    if (critical) console.log('::warning::Serious issues found, see report');
  }).catch((e) => { console.error(e); process.exit(1); });
}
