#!/usr/bin/env node
// Self-service adoption of the org harness, driven by a registry repo (Blended-Asia/gh-harness).
//
//   node scripts/adopt.mjs request    a member asks to adopt a repo → PR adding repos/<repo>.yml to the registry
//   node scripts/adopt.mjs reconcile  after platform merges that PR (and daily): make every registered repo match
//
// request   env: ORG, GH_TOKEN (harness App), REGISTRY (registry repo name), REPO, KIND (new|existing),
//                TEAM (solo|team), REQUESTER
// reconcile env: ORG, GH_TOKEN (harness App: PRs into target repos), ADMIN_TOKEN (admin App: runner group,
//                repo settings/variables, org rulesets), MANIFEST_DIR, RUNNER_GROUP, RUNNER_LABEL, GUARD_REF
import { readdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './harness/lib.mjs';
import { client, workBranch, auditRepo, planFixes, openFixPr } from './org-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const KINDS = ['new', 'existing'];
const TEAMS = ['solo', 'team'];
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** Validates one registry entry (also used on request inputs). Throws with a readable message. */
export function validateEntry(e, file = 'entry') {
  if (!e || typeof e !== 'object') throw new Error(`${file}: not a YAML mapping`);
  if (!NAME.test(String(e.repo ?? ''))) throw new Error(`${file}: invalid repo name "${e.repo}"`);
  if (!KINDS.includes(e.kind)) throw new Error(`${file}: kind must be ${KINDS.join('|')}`);
  if (!TEAMS.includes(e.team)) throw new Error(`${file}: team must be ${TEAMS.join('|')}`);
  if (e.flow && !['trunk', 'gitflow'].includes(e.flow)) throw new Error(`${file}: flow must be trunk|gitflow`);
  if (path.basename(file, '.yml') !== e.repo && file !== 'entry') throw new Error(`${file}: file name must match repo (${e.repo}.yml)`);
  return { repo: e.repo, kind: e.kind, team: e.team, flow: e.flow ?? null };
}

export function entryYaml(e) {
  return [
    '# Registered by `gh harness init` / the "Request adoption" workflow. Merging this file is the platform approval.',
    `repo: ${e.repo}`,
    `kind: ${e.kind}        # new: enforce from day one · existing: observe first (see docs/onboarding-existing-repo.md)`,
    `team: ${e.team}        # solo: no human approval required · team: 1 approval + code owners`,
    `flow: ${e.flow}       # trunk: gate the default branch · gitflow: gate develop`,
    `requested_by: ${e.requestedBy ?? 'unknown'}`,
    '',
  ].join('\n');
}

export const rulesetName = (e) => `org-${e.flow === 'gitflow' ? 'gitflow' : 'trunk'}-${e.team}`;

function out(env, key, value) {
  if (env.GITHUB_OUTPUT) return appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
function summary(env, md) {
  if (env.GITHUB_STEP_SUMMARY) return appendFile(env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

// ---------- request ----------
export async function request(env = process.env) {
  const cfg = { org: env.ORG, token: env.GH_TOKEN, api: env.GITHUB_API_URL || 'https://api.github.com', ref: env.GUARD_REF || 'v1' };
  const e = validateEntry({ repo: env.REPO?.trim(), kind: env.KIND, team: env.TEAM });
  const registry = env.REGISTRY || 'gh-harness';
  const gh = client(cfg);
  const target = await gh.get(`/repos/${cfg.org}/${e.repo}`, [404]);
  if (!target.data) throw new Error(`Repo ${cfg.org}/${e.repo} not found (or the harness App is not installed on it)`);
  if (target.data.archived) throw new Error(`Repo ${e.repo} is archived`);
  const wb = await workBranch(gh, cfg, target.data);
  e.flow = wb.branch === target.data.default_branch ? 'trunk' : 'gitflow';
  e.requestedBy = env.REQUESTER || 'unknown';

  const base = `/repos/${cfg.org}/${registry}`;
  const filePath = `repos/${e.repo}.yml`;
  const branch = `adopt/${e.repo}`;
  const open = await gh.get(`${base}/pulls?state=open&head=${encodeURIComponent(`${cfg.org}:${branch}`)}`);
  const main = (await gh.get(`/repos/${cfg.org}/${registry}`)).data.default_branch;
  const head = await gh.get(`${base}/git/ref/heads/${encodeURIComponent(main)}`);
  const created = await gh.req('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.data.object.sha }, [422]);
  if (created.status === 422 && !open.data.length) {
    await gh.req('PATCH', `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: head.data.object.sha, force: true });
  }
  const cur = await gh.get(`${base}/contents/${filePath}?ref=${encodeURIComponent(branch)}`, [404]);
  await gh.req('PUT', `${base}/contents/${filePath}`, {
    message: `chore: register ${e.repo} for the org harness`, content: b64(entryYaml(e)), branch,
    ...(cur.data?.sha ? { sha: cur.data.sha } : {}),
  });
  let url = open.data[0]?.html_url;
  if (!url) {
    const pr = await gh.req('POST', `${base}/pulls`, {
      title: `feat: adopt org harness in ${e.repo}`, head: branch, base: main,
      body: [
        '## Summary',
        `Request by @${e.requestedBy} to adopt the org harness in \`${e.repo}\`.`,
        '',
        `| kind | team | flow (detected) |`, '|---|---|---|', `| ${e.kind} | ${e.team} | ${e.flow} (${wb.source}) |`,
        '',
        'Merging this PR is the platform approval. The reconcile workflow then:',
        '1. lets the repo use the self-hosted CI runners and enables auto-merge,',
        `2. opens the adoption PR in \`${e.repo}\` (${e.kind === 'new' ? 'enforce from day one' : 'observe mode first'}),`,
        `3. once that PR is merged, adds the repo to the \`${rulesetName(e)}\` ruleset.`,
        '',
        '## How to test',
        'After merge, check the "reconcile" workflow run summary for the adoption PR link.',
      ].join('\n'),
    });
    url = pr.data.html_url;
  }
  await out(env, 'pr_url', url);
  await summary(env, `### Adoption request for \`${e.repo}\`\n${e.kind} · ${e.team} · ${e.flow} → ${url}`);
  console.log(url);
  return { entry: e, url };
}

// ---------- reconcile ----------
export async function loadRegistry(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.yml')).sort();
  return files.map((f) => validateEntry(loadYaml(path.join(dir, f)), f));
}

async function ensureRunnerAccess(admin, cfg, repo) {
  const groups = await admin.get(`/orgs/${cfg.org}/actions/runner-groups?per_page=100`);
  const group = (groups.data.runner_groups ?? []).find((g) => g.name === cfg.runnerGroup);
  if (!group) throw new Error(`Runner group ${cfg.runnerGroup} not found`);
  await admin.req('PUT', `/orgs/${cfg.org}/actions/runner-groups/${group.id}/repositories/${repo.id}`);
  const v = await admin.req('PATCH', `/repos/${cfg.org}/${repo.name}/actions/variables/HARNESS_RUNS_ON`, { name: 'HARNESS_RUNS_ON', value: cfg.runnerLabel }, [404]);
  if (v.status === 404) await admin.req('POST', `/repos/${cfg.org}/${repo.name}/actions/variables`, { name: 'HARNESS_RUNS_ON', value: cfg.runnerLabel });
}

async function ensureRuleset(admin, cfg, e) {
  const name = rulesetName(e);
  const list = await admin.paginate(`/orgs/${cfg.org}/rulesets?per_page=100`);
  const found = list.find((r) => r.name === name);
  if (!found) {
    const body = JSON.parse(await readFile(path.join(ROOT, 'rulesets', `${name}.json`), 'utf8'));
    body.conditions.repository_name.include = [e.repo];
    await admin.req('POST', `/orgs/${cfg.org}/rulesets`, body);
    return 'created';
  }
  const full = (await admin.get(`/orgs/${cfg.org}/rulesets/${found.id}`)).data;
  const include = full.conditions?.repository_name?.include ?? [];
  if (include.includes(e.repo) || include.includes('~ALL')) return 'present';
  const { name: n, target, enforcement, conditions, rules, bypass_actors: bypass } = full;
  conditions.repository_name.include = [...include, e.repo];
  await admin.req('PUT', `/orgs/${cfg.org}/rulesets/${found.id}`, { name: n, target, enforcement, conditions, rules, bypass_actors: bypass });
  return 'added';
}

export async function reconcile(env = process.env) {
  const cfg = {
    org: env.ORG, token: env.GH_TOKEN, api: env.GITHUB_API_URL || 'https://api.github.com', ref: env.GUARD_REF || 'v1',
    owners: env.PLATFORM_OWNERS || '', runnerGroup: env.RUNNER_GROUP || 'blended-ci', runnerLabel: env.RUNNER_LABEL || 'blended-ci',
    minutesDays: 7,
  };
  if (!env.ADMIN_TOKEN) throw new Error('Missing ADMIN_TOKEN');
  const gh = client(cfg);
  const admin = client({ ...cfg, token: env.ADMIN_TOKEN });
  const entries = await loadRegistry(env.MANIFEST_DIR || 'repos');
  const rows = [];
  let failed = 0;
  for (const e of entries) {
    const row = { repo: e.repo, steps: [] };
    try {
      const repo = (await admin.get(`/repos/${cfg.org}/${e.repo}`)).data;
      if (repo.archived) { row.steps.push('archived, skipped'); rows.push(row); continue; }
      if (repo.private || repo.visibility !== 'public') {
        await ensureRunnerAccess(admin, cfg, repo);
        row.steps.push(`runners: ${cfg.runnerLabel}`);
      } else row.steps.push('public: GitHub-hosted runners');
      if (!repo.allow_auto_merge || !repo.delete_branch_on_merge) {
        await admin.req('PATCH', `/repos/${cfg.org}/${e.repo}`, { allow_auto_merge: true, delete_branch_on_merge: true });
      }
      row.steps.push('auto-merge on');
      const r = await auditRepo(gh, { ...cfg, kind: e.kind }, repo);
      const adopted = r.found?.harness && r.found?.['pr-convention'];
      if (!adopted) {
        const fixes = await planFixes({ ...cfg, kind: e.kind }, r, repo);
        const url = await openFixPr(gh, { ...cfg, kind: e.kind }, repo, fixes, r.branch);
        row.steps.push(`adoption PR: ${url}`);
      } else {
        row.steps.push(`ruleset ${rulesetName(e)}: ${await ensureRuleset(admin, cfg, e)}`);
      }
    } catch (err) {
      failed++;
      row.steps.push(`❌ ${err.message.split('\n')[0].slice(0, 200)}`);
    }
    rows.push(row);
  }
  const md = ['### Harness registry reconcile', '', '| Repo | Result |', '|---|---|', ...rows.map((r) => `| ${r.repo} | ${r.steps.join('<br>')} |`)].join('\n');
  await summary(env, md);
  console.log(md);
  return { rows, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2];
  const run = cmd === 'request' ? request : cmd === 'reconcile' ? reconcile : null;
  if (!run) {
    console.error('Usage: adopt.mjs request|reconcile');
    process.exit(2);
  }
  run().then((res) => process.exit(res?.failed ? 1 : 0), (err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
