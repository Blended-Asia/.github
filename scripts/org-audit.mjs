#!/usr/bin/env node
// Quét toàn bộ repo trong org → báo cáo compliance; FIX=true thì mở PR áp dụng workflow chuẩn.
// Không cần npm install (Node >= 20, dùng fetch có sẵn).
//
// ENV:
//   GH_TOKEN         token GitHub App (khuyên dùng) hoặc PAT. Quyền cần: Contents R/W, Pull requests R/W,
//                    Workflows R/W (chỉ khi FIX), Administration R, Deployments R, Metadata R
//   ORG              tên org
//   FIX              "true" để mở PR sửa
//   ONLY             giới hạn repo, vd "api,web"
//   GUARD_REF        ref của workflow chuẩn, mặc định v1
//   PLATFORM_OWNERS  vd "@my-org/platform": thêm CODEOWNERS cho .github/workflows nếu repo chưa có
//   OUT_DIR          nơi ghi report.md / report.json (mặc định thư mục hiện tại)

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadYaml } from './harness/lib.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_CHECKS = ['org / pr-convention', 'harness / gate'];
const STALE_DAYS = 180;

export function config(env = process.env) {
  if (!env.ORG || !env.GH_TOKEN) throw new Error('Thiếu ORG hoặc GH_TOKEN');
  return {
    org: env.ORG,
    token: env.GH_TOKEN,
    api: env.GITHUB_API_URL || 'https://api.github.com',
    fix: env.FIX === 'true',
    only: (env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
    ref: env.GUARD_REF || 'v1',
    owners: env.PLATFORM_OWNERS || '',
    outDir: env.OUT_DIR || '.',
    quiet: env.QUIET === 'true', // repo chạy audit là public → không in tên repo ra log
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

// ---------- So sánh caller với template ----------
const CALLERS = {
  'org-harness.yml': 'workflow-templates/org-harness.yml',
  'org-pr-convention.yml': 'workflow-templates/org-pr-convention.yml',
  'org-vercel-preview.yml': 'workflow-templates/org-vercel-preview.yml',
};
// Input mà nếu repo tự đổi thì nới lỏng kiểm tra → hiện trong report để platform review
const WEAKENING = ['semgrep', 'stacks', 'fail_severity', 'ignore_unfixed', 'supabase_db_checks', 'advisors_fail_on',
  'migration_immutable', 'migration_order', 'hadolint_threshold', 'hadolint_ignore', 'misconfig_ignore', 'deno_check',
  'ignore_bots', 'branch_pattern', 'required_sections', 'env_file_allowlist', 'title_types', 'fail_on', 'advisors_ignore'];

/** Bỏ comment, block `with:`/`secrets:`, ref và tên org → phần còn lại phải giống hệt template. */
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

/** Các `key: value` trong block `with:` của caller. */
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

/** Những chỗ .github/harness.yml nới lỏng so với mặc định của org. */
export function harnessWeakening(cfg) {
  const out = [];
  const disabled = cfg?.architecture?.disable ?? [];
  if (disabled.length) out.push(`tắt rule ${disabled.join(', ')}`);
  const downgraded = Object.entries(cfg?.architecture?.severity ?? {}).filter(([, v]) => v === 'warn').map(([k]) => k);
  if (downgraded.length) out.push(`hạ xuống cảnh báo: ${downgraded.join(', ')}`);
  for (const [profile, checks] of Object.entries(cfg?.checks ?? {})) {
    for (const [tool, v] of Object.entries(checks ?? {})) if (v === false) out.push(`tắt ${profile}.${tool}`);
  }
  for (const p of cfg?.profiles ?? []) {
    for (const [tool, v] of Object.entries(p?.checks ?? {})) if (v === false) out.push(`tắt ${p.name}.${tool}`);
  }
  if (cfg?.merge?.human_required_paths) out.push('thay danh sách path cần người duyệt');
  if (cfg?.merge?.suppression_markers) out.push('thay danh sách marker tắt kiểm tra');
  if ((cfg?.merge?.bot_approve?.max_lines ?? 0) > 500) out.push(`bot tự approve PR tới ${cfg.merge.bot_approve.max_lines} dòng`);
  const blockOn = cfg?.review?.block_on;
  if (blockOn && !(blockOn.includes('critical') && blockOn.includes('major'))) out.push(`AI review chỉ chặn ${blockOn.join('/') || 'không gì'}`);
  if (cfg?.review?.override_label) out.push(`đổi label override AI thành "${cfg.review.override_label}"`);
  if (cfg?.review?.diff_exclude) out.push('thay danh sách file giấu khỏi AI review');

  return out;
}

/** CODEOWNERS: dòng khớp CUỐI CÙNG quyết định owner (giống GitHub). */
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

// ---------- Nhánh làm việc ----------
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
 * Nhánh mà PR được gate và adoption PR nhắm vào:
 * gate.branches (nhánh cụ thể đầu tiên, đọc ở develop rồi default) → có branch develop (git-flow) → default branch.
 */
export async function workBranch(gh, cfg, repo) {
  const base = `/repos/${cfg.org}/${repo.name}`;
  const dev = repo.default_branch === 'develop' ? null : await gh.get(`${base}/branches/develop`, [404]);
  const candidates = dev?.data ? ['develop', repo.default_branch] : [repo.default_branch];
  for (const ref of candidates) {
    const { cfg: hcfg } = await readHarnessConfig(gh, base, ref);
    const list = Array.isArray(hcfg?.gate?.branches) ? hcfg.gate.branches.map(String) : [];
    const literal = list.find((b) => b && !/[*?[{]/.test(b));
    if (literal) return { branch: literal, source: `gate.branches trong harness.yml (${ref})` };
  }
  if (dev?.data) return { branch: 'develop', source: 'có branch develop (git-flow)' };
  return { branch: repo.default_branch, source: 'default branch' };
}

// ---------- Phân tích 1 repo ----------
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
    add('info', 'Repo rỗng');
    r.empty = true;
    return r;
  }
  // Repo git-flow: audit trên nhánh làm việc (develop), không phải default branch
  const wb = await workBranch(gh, cfg, repo);
  r.branch = wb.branch;
  if (r.branch !== repo.default_branch) add('info', `Audit trên nhánh \`${r.branch}\` (${wb.source}), default branch là \`${repo.default_branch}\``);
  const ref = encodeURIComponent(r.branch);
  const tree = r.branch === repo.default_branch ? tree0 : await gh.get(`${base}/git/trees/${ref}?recursive=1`, [404, 409]);
  if (!tree.data) {
    add('info', 'Repo rỗng');
    r.empty = true;
    return r;
  }
  if (tree.data.truncated) add('info', 'Repo quá lớn, cây file bị cắt bớt — kết quả phát hiện có thể thiếu');
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
        if (weak.length) add('warn', `\`harness.yml\` nới lỏng: ${weak.join('; ')}`);
        if (hcfg?.enforcement === 'observe') {
          r.observe = true;
          add('info', 'Đang ở chế độ quan sát (`enforcement: observe`): gate không chặn, không tự approve/merge');
        }
      } catch (e) {
        add('high', `\`.github/harness.yml\` không đọc được (${e.message.split('\n')[0].slice(0, 80)}): harness sẽ fail`);
      }
    }
  }

  // Leak trong repo
  const envFiles = files.filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/\.env(\.[^/.]+)*\.(example|sample|template|defaults)$/.test(f));
  for (const f of envFiles) add('critical', `File env bị commit: \`${f}\` → xoá khỏi git + rotate secret`);
  if (has(/(^|\/)\.vercel\//)) add('critical', 'Thư mục `.vercel/` bị commit');

  // Workflows dùng reusable của org
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
  if (r.checks.harness === 'warn' || r.checks.convention === 'warn') add('warn', `Workflow org đang ghim ref cũ (cần ${cfg.ref})`);
  r.found = found;
  if (vercel && !found['vercel-preview']) r.missingPreview = true;

  // Caller bị sửa ngoài phần `with:` (vd thêm `if:` để job bị skip) hoặc config nới lỏng
  for (const [p, text] of Object.entries(r.workflowFiles)) {
    const tpl = CALLERS[path.basename(p)];
    if (tpl) {
      const expected = normalizeCaller(await readFile(path.join(ROOT, tpl), 'utf8'), r.branch);
      if (normalizeCaller(text, r.branch) !== expected) {
        add('high', `\`${p}\` khác template ngoài phần \`with:\`, cần review (có thể đã bị sửa để né check)`);
        if (p.endsWith('org-harness.yml')) r.checks.harness = 'warn';
        if (p.endsWith('org-pr-convention.yml')) r.checks.convention = 'warn';
      }
    } else {
      add('info', `Workflow org được gọi từ \`${p}\` (tên tự đặt), không so được với template`);
    }
    const weak = Object.entries(callerOverrides(text)).filter(([k]) => WEAKENING.includes(k));
    if (weak.length) add('warn', `Override trong \`${path.basename(p)}\`: ${weak.map(([k, v]) => `${k}=${v || '""'}`).join(', ')}`);
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
  // Branch protection kiểu cũ (không nằm trong rulesets)
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
    if (r.checks.protection === 'warn') add('warn', 'Có bảo vệ branch nhưng chưa bắt buộc PR + check harness / gate + org / pr-convention');
  }
  if (r.checks.protection === 'fail') add(r.visibility === 'public' ? 'high' : 'warn', `Nhánh \`${r.branch}\` không được bảo vệ (push thẳng được)`);

  // Ownership + cập nhật dependency
  const coPath = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((p) => files.includes(p));
  if (!coPath) {
    r.checks.codeowners = 'fail';
  } else {
    const co = await gh.get(`${base}/contents/${enc(coPath)}?ref=${br}`, [404]);
    const text = co.data?.content ? unb64(co.data.content) : '';
    // Cả caller lẫn config của harness phải có owner, nếu không dev tự sửa được luật chấm
    const uncovered = ['.github/workflows/org-harness.yml', '.github/harness.yml'].filter((f) => !codeownersFor(text, f).length);
    const owners = uncovered.length ? [] : ['ok'];
    r.checks.codeowners = owners.length ? 'pass' : 'warn';
    if (!owners.length) add('warn', `\`${coPath}\` không có owner cho ${uncovered.map((f) => `\`${f}\``).join(', ')}: dev có thể sửa harness trong PR mà không cần review`);
    else if (!codeOwnerReview && r.checks.protection !== 'unknown') add('warn', 'CODEOWNERS chưa được enforce (bật "Require review from Code Owners")');
  }
  r.checks.depsBot = has(/^\.github\/dependabot\.ya?ml$|(^|\/)renovate\.json5?$|^\.github\/renovate\.json5?$/) ? 'pass' : 'fail';
  r.hasPrTemplate = has(/(^|\/)pull_request_template\.md$/i) || has(/(^|\/)PULL_REQUEST_TEMPLATE\//i);

  const va = await gh.get(`${base}/vulnerability-alerts`, [403, 404]);
  r.checks.vulnAlerts = va.status === 204 ? 'pass' : va.status === 404 ? 'fail' : 'unknown';
  if (r.checks.vulnAlerts === 'fail') add('warn', 'Dependabot alerts đang tắt (miễn phí, nên bật)');

  let sa = repo.security_and_analysis;
  if (r.visibility === 'public' && !sa) sa = (await gh.get(base, [403, 404])).data?.security_and_analysis;
  if (r.visibility === 'public' && sa && sa.secret_scanning_push_protection?.status !== 'enabled') {
    add('high', 'Repo public chưa bật Secret scanning push protection (miễn phí cho public)');
  }

  const days = (Date.now() - new Date(repo.pushed_at).getTime()) / 86400000;
  if (days > STALE_DAYS) add('info', `Không có push ${Math.floor(days)} ngày — cân nhắc archive`);
  return r;
}

// ---------- Mở PR sửa ----------
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
  // File đã có nhưng ghim ref cũ → chỉ đổi ref, giữ nguyên config `with:`
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
    // Nhánh làm việc khác default branch (git-flow) → gate đúng nhánh đó, nếu không mọi PR vào develop bị bỏ qua
    if (r.branch !== (r.defaultBranch ?? repo.default_branch)) {
      starter = starter.replace(/# gate:\n#   branches: \[develop\]\n/, `gate:\n  branches: [${JSON.stringify(r.branch)}]\n`);
    }
    out.push({ path: '.github/harness.yml', content: starter, message: 'ci: add harness config' });
  }
  if (!r.hasPrTemplate) {
    out.push({ path: '.github/pull_request_template.md', content: await readFile(path.join(ROOT, 'pull_request_template.md'), 'utf8'), message: 'docs: add PR template' });
  }
  if (cfg.owners && r.checks.codeowners === 'fail') {
    out.push({ path: '.github/CODEOWNERS', content: `# Thay đổi CI và cấu hình harness cần platform review\n/.github/ ${cfg.owners}\n`, message: 'chore: add CODEOWNERS for .github' });
  }
  // Gộp theo path (file sau ghi đè file trước)
  return [...new Map(out.map((f) => [f.path, f])).values()];
}

export async function openFixPr(gh, cfg, repo, files, target = repo.default_branch) {
  const base = `/repos/${cfg.org}/${repo.name}`;
  const branch = `ci/org-harness-${cfg.ref.replace(/[^\w.-]/g, '-')}`;
  const head = await gh.get(`${base}/git/ref/heads/${encodeURIComponent(target)}`);
  const open = await gh.get(`${base}/pulls?state=open&head=${encodeURIComponent(`${cfg.org}:${branch}`)}`);
  const created = await gh.req('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.data.object.sha }, [422]);
  if (created.status === 422 && !open.data.length) {
    // Branch cũ còn sót (PR trước đã merge/đóng) → đưa về nhánh đích để không kéo commit cũ vào
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
    `Áp dụng bộ workflow chuẩn của org (\`${cfg.ref}\`):`,
    ...files.map((f) => `- \`${f.path}\` — ${f.message}`),
    '',
    'PR này được tạo tự động bởi org-audit.',
    ...(files.some((f) => f.path === '.github/harness.yml') ? [
      '',
      'Sau khi merge, repo ở **chế độ quan sát** (`enforcement: observe`): harness comment "nếu bật thì sẽ chặn vì…" nhưng không chặn merge.',
      'Repo đã có code lâu năm thì làm theo `docs/onboarding-existing-repo.md` của repo `.github` (đo nợ, viết ARCHITECTURE.md, chỉnh rule) trước khi đổi sang `enforce`.',
    ] : []),
    '',
    '## How to test',
    'Các check `org / pr-convention` và `harness / gate` sẽ chạy ngay trên PR này (với cấu hình mặc định, vì `harness.yml` chỉ có hiệu lực sau khi merge). Nếu ruleset chưa áp cho repo này thì gate đỏ vì nợ cũ cũng không chặn merge PR này.',
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
    `Cập nhật: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · workflow chuẩn: \`${cfg.ref}\``,
    '',
    `**${compliant}/${active.length}** repo đạt chuẩn đầy đủ (harness + convention + protection) · **${crit.length}** vấn đề nghiêm trọng · **${active.filter((r) => r.observe).length}** repo đang ở chế độ quan sát`,
    '',
  ];
  if (crit.length) {
    lines.push('## Cần xử lý ngay', '');
    for (const f of crit) lines.push(`- ${LEVEL[f.level]} **${f.repo}**: ${f.msg}`);
    lines.push('');
  }
  lines.push(
    '## Theo repo', '',
    '| Repo | Stack | Harness | Convention | Protection | CODEOWNERS | Deps bot | Vuln alerts | Ghi chú |',
    '|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|',
  );
  for (const r of active) {
    const c = r.checks;
    const notes = r.findings.filter((f) => !['critical', 'high'].includes(f.level)).map((f) => `${LEVEL[f.level]} ${f.msg}`);
    if (r.prUrl) notes.push(`🔧 [PR sửa](${r.prUrl})`);
    else if (r.fixes.length) notes.push(`🔧 sẽ sửa: ${r.fixes.map((f) => '`' + path.basename(f.path) + '`').join(', ')}`);
    lines.push(`| [${r.name}](${r.url})${r.visibility === 'public' ? ' 🌐' : ''} | ${r.stacks.join(', ') || '-'} | ${ICON[c.harness]} | ${ICON[c.convention]} | ${ICON[c.protection]} | ${ICON[c.codeowners]} | ${ICON[c.depsBot]} | ${ICON[c.vulnAlerts]} | ${notes.join('<br>')} |`);
  }
  const empty = results.filter((r) => r.empty).map((r) => r.name);
  if (empty.length) lines.push('', `Repo rỗng (bỏ qua): ${empty.join(', ')}`);
  lines.push('', '<sub>✅ đạt · ⚠️ một phần/ref cũ · ❌ thiếu · ❔ không đủ quyền đọc · 🌐 public</sub>');
  return lines.join('\n');
}

// ---------- Main ----------
export async function main(env = process.env) {
  const cfg = config(env);
  const gh = client(cfg);
  let repos = await gh.paginate(`/orgs/${cfg.org}/repos?type=all&per_page=100`);
  repos = repos.filter((r) => !r.archived && !r.fork && !r.disabled && r.name !== '.github');
  if (cfg.only.length) repos = repos.filter((r) => cfg.only.includes(r.name));
  console.log(`Quét ${repos.length} repo trong ${cfg.org}${cfg.fix ? ' (FIX)' : ''}${cfg.quiet ? ' (quiet)' : ''}`);

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
      console.error(cfg.quiet ? '::warning::Lỗi khi quét 1 repo (xem report)' : `::warning::${repo.name}: ${e.message}`);
      results.push({ name: repo.name, url: repo.html_url, visibility: repo.visibility, stacks: [], fixes: [],
        checks: { harness: 'unknown', convention: 'unknown', protection: 'unknown', codeowners: 'unknown', depsBot: 'unknown', vulnAlerts: 'unknown' },
        findings: [{ level: 'warn', msg: `Lỗi khi quét: ${e.message.slice(0, 120)}` }] });
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
    if (critical) console.log('::warning::Có vấn đề nghiêm trọng, xem report');
  }).catch((e) => { console.error(e); process.exit(1); });
}
