# HANDOFF — rolling the harness out to the real org

Recipient: Claude Code, running on a machine where `gh` is logged in to the org. Read `CLAUDE.md` first.

## Current status (2026-10-03)

**Done and verified offline:**
- All workflows, scripts, profiles and starters (see `README.md`).
- 97 unit tests pass; actionlint and shellcheck clean. Three independent review rounds; every issue found was fixed and has a test.
- **Existing** repos are supported:
  - `enforcement: observe` mode
  - every check blocks only new debt (line-level lint, tsc/Brakeman/Trivy compared with base, Prettier distinguishes files that were already unformatted)
  - `debt.mjs` measures debt before onboarding
  - playbook `docs/onboarding-existing-repo.md`
- Integration tests run real tools (3 scenarios: Next.js, Rails, monorepo workspace): ESLint 9 + eslint-config-next 16, tsc 5.9, Prettier 3, dependency-cruiser 18.5, RuboCop 1.91 (rails-omakase), Brakeman 8.1.
- Trivy 0.75, Hadolint 2.15.1, Semgrep 1.179 and Supabase CLI 2.119 (`db advisors` catches tables missing RLS) were run manually via shims.
- Two independent review rounds; the vulnerabilities found were fixed and have tests. The list of invariants is in `CLAUDE.md`.

**Never run on real GitHub yet.** All GitHub and AI provider (OpenAI/Anthropic) API calls have only been tested with mocks. This is the biggest risk, so Phase 2 is mandatory before rollout.

## Working rules

- Stop and ask the user at every step marked **⛔ STOP**: org-wide changes, creating GitHub Apps, enabling rulesets, opening PRs in bulk. These are hard to undo or affect other people.
- For every bug found while running for real: fix the code, add a reproducing test (mocking the real response you observed), re-run all tests + actionlint, then move the `v1` tag.
- Record progress at the end of this file (the "Log" section) so the next session can pick up.

---

## Phase 0 — Ask the user (⛔ STOP: do not continue without answers)

| Need to know | Why |
|---|---|
| GitHub org name | `./scripts/init.sh <org>` |
| Plan: Free / Team / Enterprise Cloud | Determines how enforcement works (`README.md` → "Your GitHub plan determines how strictly this can be enforced") |
| Does the org have public repos | The `.github` repo must be public; audit reports must go to a private repo |
| Which repos to pilot | Ideally 1 Next.js repo + 1 Rails repo with few users |
| Single-person repos or team review | `SOLO=true` when applying rulesets |
| Enable AI review? Which provider (`review.provider: openai` default, or `anthropic`), and is `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` available | `review.ai`, `review.provider` |
| Which person/team is the platform owner | `PLATFORM_OWNERS`, CODEOWNERS |

## Phase 1 — Initialize the `.github` repo

1. `git init -b main` in this directory, then run `./scripts/init.sh <org>`.
2. `node --test 'tests/*.test.mjs'` and actionlint must both be clean.
3. ⛔ STOP: confirm with the user before `gh repo create <org>/.github --public`. If the repo already exists (it often has `profile/README.md`), merge into it rather than overwrite.
4. Commit, push `main`, tag `v1`.
5. Check that `self-test` is green on GitHub, including the `integration` job.

**Acceptance:** `gh run list -R <org>/.github` shows a successful self-test. `git ls-remote --tags` shows `v1`.

## Phase 2 — Verify on a sandbox repo (mandatory)

Create a private repo `<org>/harness-sandbox`; you can reuse the fixtures in `tests/integration.test.mjs`:
- `web/`: Next.js
- `api/`: minimal Rails
- `supabase/`: 1 migration

Add `org-harness.yml` + `org-pr-convention.yml` (from `workflow-templates/`, replacing `$default-branch`), enable **Allow auto-merge**, and enable the ruleset **for the sandbox repo only** (set `conditions.repository_name.include` to `["harness-sandbox"]`).

Ideally write `scripts/e2e-sandbox.sh` using `gh` to automate the scenarios below. For each scenario: create a branch, push, `gh pr create`, wait for checks, then assert with `gh pr checks`, `gh pr view --json reviews,comments,autoMergeRequest`.

| # | Scenario | Expected | Uncertain points to confirm |
|---|---|---|---|
| E1 | Clean PR, 20 lines in `web/app/` | Checks named exactly `harness / gate` + `org / pr-convention`; bot APPROVEs; auto-merge enabled; PR merges itself | Check names of reusable workflows (`<caller job> / <job name>`); dynamic `name:` of the `gate` job; `enablePullRequestAutoMerge` with GITHUB_TOKEN |
| E2 | Add `const x: number = 'a'` + `'use client'` reading `process.env.SECRET` | Gate red; sticky comment lists `tsc TS2322` and `react/client-no-server-code` with `file:line` | Gate can read annotations of jobs nested in a reusable workflow (`check-runs/{job.id}/annotations`; is the job id = check run id) |
| E3 | Edit `supabase/migrations/<old>.sql` | `infra / supabase` red, no approval | `supabase db start` + `db advisors --local` on the runner |
| E4 | PR edits `.github/harness.yml` to `max_lines: 99999` plus 500 lines of code | No bot approval (config read from base + `.github/**` needs a human) | `fetch-depth: 0` is enough for `git show <base>:...` |
| E5 | "Run workflow" `org-harness` on the branch of a red PR | New run named `harness / gate (workflow_dispatch)`; the PR's `harness / gate` check stays red | Dynamic name inside a reusable workflow |
| E6 | Re-run an old run after pushing a new commit | Gate only writes a summary "old commit", no comment/approve | — |
| E7 | Enable `review.ai: true` (merged into base first), PR with an obvious authorization bug | Inline COMMENT review with marker `harness-ai:<sha> blockers=N`; gate red; re-run does not call the API again | Structured output (OpenAI `response_format` json_schema strict / Anthropic `output_config.format`) with the provider's default model (`DEFAULT_MODELS`); inline comment `line`/`side` |
| E8 | Author applies `harness:override-ai` themselves, then a different maintainer applies it | First time has no effect; second time gate green but no bot approval | `issues/{n}/events` + `collaborators/{u}/permission` with GITHUB_TOKEN (`issues: read`) |
| E9 | Rails: `User.where("name = '#{params[:q]}'")` in a controller | `stack / rails (api)` red due to `brakeman SQL Injection` | `ruby/setup-ruby` `bundler-cache` in a subdirectory; `Gem.bindir` |
| E10 | pnpm workspace (switch `web/` to pnpm) | Installs fine, ESLint/tsc run | corepack on the Node 24 runner; `resolveBin` finds hoisted binaries |
| E11 | No GitHub App, "Allow GitHub Actions to create and approve PRs" not enabled | Comment notes how to enable it, no crash | The real 422 error message |
| E12 | `HARNESS_APP_*` present | Approve/merge performed by the App; the push to `main` after merge **does** trigger workflows | `app-slug` → `HARNESS_BOT_LOGIN` |
| E13 | Vercel preview (if the sandbox is connected to Vercel) | `org-vercel-preview` runs after `deployment_status`, checks headers | `environment_url`, bypass header |
| E14 | Base has `enforcement: observe`; PR has a tsc error | `harness / gate` check **green**, comment "👀 … if enforce were on, this PR would be blocked"; no approve/merge | — |
| E15 | Base has a lockfile with a CVE + a Dockerfile running as root; PR only edits README | All checks green (old debt only in the summary). A PR adding a package with a new CVE → `security / dependencies` red, listing only the new CVE | `git worktree add` + Trivy scanning base on the runner |
| E16 | Edit 1 line in an old file that already has 20 ESLint errors and is unformatted | Only new errors block; Prettier warns "file was already unformatted" | ESLint/Prettier baseline in a worktree (symlinked node_modules) |
| E17 | pnpm monorepo: PR edits `packages/shared` and breaks types in `apps/web` (unchanged) | `stack / react (apps/web)` red with a tsc error "newly caused by the PR" | base runs its own `pnpm install` in the worktree (`baseNeedsOwnDeps`) |

For every "uncertain" point that turns out wrong: fix it, add a mock test based on the real response, then record it in the Log.

**Phase 2 acceptance:** E1–E12 and E14–E17 pass (E13 if Vercel is available). Record the PR link for each scenario in the Log.

## Phase 3 — GitHub App and secrets (⛔ STOP: the user must do this on the web)

Claude Code cannot create a GitHub App on the user's behalf. Guide them step by step and wait for confirmation:

1. **App "harness bot"**: Contents R/W, Pull requests R/W. Install on *All repositories*. Then store:
   ```bash
   gh variable set HARNESS_APP_CLIENT_ID --org <org> --body <client-id>
   gh secret set HARNESS_APP_PRIVATE_KEY --org <org> < key.pem
   ```
2. **App "org audit"**: can be the same App if you add Administration R, Deployments R, Workflows R/W, Issues R/W, and **Actions R** (weekly secret-scan result and Actions minutes per repo; without it those columns show ❔). Store `ORG_AUDIT_APP_CLIENT_ID` (variable) and `ORG_AUDIT_APP_PRIVATE_KEY` (secret) in the `.github` repo.
3. Set `AUDIT_REPORT_REPO` = a private repo, and `PLATFORM_OWNERS`.
4. If enabling AI: `gh secret set OPENAI_API_KEY --org <org>` (default `review.provider: openai`), or `gh secret set ANTHROPIC_API_KEY --org <org>` for `review.provider: anthropic`.
5. Without an App, enable Org settings → Actions → "Allow GitHub Actions to create and approve pull requests".

## Phase 4 — Rollout

1. Run `gh workflow run org-audit -R <org>/.github` (dry run), then read the report issue in `AUDIT_REPORT_REPO`. Summarize for the user: which repos are missing what, and whether any `.env` files are committed (critical).
2. ⛔ STOP: run `fix=true` with `only=<pilot repos>` first, and only then the whole org. Command: `gh workflow run org-audit -R <org>/.github -f fix=true -f only=a,b`.
3. Each `ci: adopt org harness (v1)` PR includes a `harness.yml` with `enforcement: observe`. After merge, the repo is in observe mode.
   - **New or small** repos: copy any missing starter files (ESLint/RuboCop), observe for a few days, then switch to `enforce`.
   - Repos **with lots of existing code**: follow **Phase 4b**.
4. Remind the user to enable **Allow auto-merge** in each repo, or run `gh api -X PATCH repos/<org>/<repo> -f allow_auto_merge=true` once the user agrees.
5. ⛔ STOP: `./scripts/apply-ruleset.sh <org> team active` (or `enterprise evaluate`) **only after** every repo has merged its callers. If enabled too early, PRs in the remaining repos will be stuck at "Expected — Waiting for status".
6. Suggest to the user: for the first 2 weeks set `merge.bot_approve.enabled: false` in `profiles/base.yml` to watch for false positives, then turn it on.

## Phase 4b — Onboard existing repos (one repo at a time, following `docs/onboarding-existing-repo.md`)

Work on each existing repo, one at a time, with that repo as cwd and `<org>/.github` cloned in a sibling directory.
1. `node ../.github/scripts/harness/debt.mjs`: debt report. Also run `stack.mjs` on the whole repo to gauge the size of the lint debt.
2. ⛔ STOP if any `.env*`/`.vercel/` files are committed or secrets are in history: list them for the user and wait for them to rotate. Never rewrite git history yourself.
3. Read the code and write an `ARCHITECTURE.md` describing the **actual** architecture. Write `harness.yml` from the `debt.mjs` scaffold: declare profiles explicitly, **do not disable or downgrade any rule yet**. Rules that `debt.mjs` flags "review" are evaluated after the observe period, based on real false positives.
4. ⛔ STOP: show the user the debt report, ARCHITECTURE.md and harness.yml before opening the PR.
5. Observe for 1–2 weeks, collect false positives and fix rules. ⛔ The user decides when to switch to `enforce`.

**Acceptance per repo:** an `ARCHITECTURE.md` approved by the user, a tuned `harness.yml`, and under ~10% of PRs "wrongly blocked" during the observe period.

## Phase 5 — Backlog (do when asked)

| Task | Notes |
|---|---|
| `go`, `python` profiles | Follow "Adding a new stack" in `CLAUDE.md` |
| Run the repo's test suite (rspec/vitest) | Each repo needs different DBs/services. Direction: `harness.yml` declares `test.command` + `services`, or let the repo's own CI be the third required check |
| Auto-merge for Dependabot/Renovate | Lockfiles and manifests currently always need a human. To let dependency bots auto-merge patch releases, a dedicated policy is needed: `authors` + semver patch only + `resolved` must not change to a different registry |
| Annotations are limited to 10 errors/step | The gate may miss details. Direction: each job writes `findings.json` as an artifact, the gate downloads it |
| Dependency caching (pnpm store, bundler) for the `js`/`rails` jobs | Currently every PR installs from scratch |
| tsc baseline for Yarn PnP | Currently skipped (errors outside changed files are treated as pre-existing) |
| `trivy image` after building Docker | The harness does not build images yet |
| Supabase deploy (`db push`) after a green gate on `main` | Needs `SUPABASE_ACCESS_TOKEN`, an environment with approval |
| AI cost | One call per head SHA, diff capped at 120k characters. Consider enabling only for labeled PRs, or using a smaller model for PRs < 50 lines |

## Known risks

- Architecture rules are regexes, so false positives are possible. `harness-disable-line <id>` is available, but that PR will need a human review. Track false positives during the first 2 weeks and tune `profiles/*.yml`.
- `@ts-expect-error` is in `suppression_markers`, so PRs using it always need a human review. If too noisy, discuss with the user.
- dependency-cruiser runs with `typescript@5` (the Go-based TS 7 has no stable JS API for depcruise yet).
- On the Team plan, callers live in child repos and can still be edited in a PR. The guardrails are CODEOWNERS + `require_code_owner_review` + org-audit. Only Enterprise locks this down fully.

---

## Log

<!-- Claude Code writes here: date · phase · work done · PR/run links · bugs found and how they were fixed -->
- 2026-10-06 · Phase 0 (HARNESS_PLAN.md) · `gh` logged in (admin:org, repo, workflow). Org plan Team. App `blended-asia-harness` installed on All repositories, permissions: administration R, contents RW, deployments R, issues RW, metadata R, pull_requests RW, workflows RW, no webhook; key verified via JWT → `GET /app` OK. Set org variable `HARNESS_APP_CLIENT_ID` + org secret `HARNESS_APP_PRIVATE_KEY` (visibility all). Remaining: `ORG_AUDIT_APP_*` in the `.github` repo (same App), `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` when enabling AI review, team `@Blended-Asia/platform`.
- 2026-10-06 · Phase 1 (HARNESS_PLAN.md) · `git init -b main` + 10 local commits (not pushed). All 8 changes done: OpenAI provider (`review.provider`, `DEFAULT_MODELS`), sample env regex `.env.<x>.example` (3 places), sensitive paths `**/db/migrate/**`…, `gate.branches` (verdict + pr-convention, read from base), 4 group rulesets + `apply-ruleset.sh` (REPOS/BRANCHES/DRY_RUN), org-audit per working branch (adoption PR into develop, starter with `gate.branches`), Ruby version (root `.ruby-version`/`.tool-versions`/Gemfile), `scripts/e2e-sandbox.sh`. Also: fixed `git grep -E '\b'` (missed matches on BSD/macOS) in the public-variable check; flaky org-audit test (logging broke node:test IPC). Result: 111 pass / 0 fail (3 integration skipped), actionlint + shellcheck clean. Integration tests on Mac: react + rails fail **exactly as on the original** (system Ruby 2.6, depcruise) → not caused by the changes; waiting for the self-test `integration` job on the runner (Phase 2). Still open: default OpenAI model (`DEFAULT_MODELS.openai = 'gpt-5'`, not yet verified against the org's OpenAI account).
- 2026-10-06 · Phase 2 · Created `Blended-Asia/.github` (public), pushed `main`, tagged `v1`; private repo `org-audit-reports`; repo vars `AUDIT_REPORT_REPO=org-audit-reports`, `ORG_AUDIT_APP_CLIENT_ID`, `PLATFORM_OWNERS=@Blended-Asia/platform`, secret `ORG_AUDIT_APP_PRIVATE_KEY`; team `platform`. self-test run 1: `integration` red (react) → 2 real bugs: depcruise via `npx -p typescript@5` had no TS transpiler when the repo already has typescript → scanned 0 files (fix: install into a separate directory + warn when 0 files are scanned); base worktree uses realpath (macOS). self-test run 2 (run 37443423669): `test` + `integration` green. **Remaining: move tag `v1` to `eedb3ac` (needs a force push; the user runs it).**
- 2026-10-06 · Phase 3 · Created private `Blended-Asia/harness-sandbox` (copy of jfoodhub-workspace `main` + `develop`, real remote removed; `ci.yml` dropped, `deploy-staging.yml` replaced by an echo-only fake; `web/` minimal Next.js; `.github/harness.yml` with `gate.branches: [develop, "e2e/*"]`, profiles rails@jfoodhub + react@web). Allow auto-merge on; ruleset `org-gitflow-solo` applied to the sandbox only. First push did not trigger workflows (new repo); manual dispatch failed before start: **Actions minutes exhausted** (jfoodhub-workspace used the 3,000 included minutes in October, mostly CI/deploy jobs hung for 6h with no `timeout-minutes`). Blocked until the org Actions budget is raised. Phase 5 TODO: add `timeout-minutes` to jfoodhub `ci.yml` / `deploy-staging.yml`. E7 (AI review) skipped this round. Note: `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.
- 2026-10-08 · Plan · Approved next-steps plan (W0–W7): secret layers (local lefthook+gitleaks hook, weekly full-history TruffleHog, org-audit hooks/depsUpdates/secretScan checks), runner readiness (`vars.HARNESS_RUNS_ON`, dependency cache, skip drafts, Actions minutes per repo in org-audit), then e2e, org inventory, jfoodhub onboarding. jfoodhub PR #8 (job timeouts) merged as 810fb6c; CI and Deploy to Staging remain disabled until the hanging spec is fixed. Actions budget: $20/month (set by the user).
- 2026-10-08 · W1+W2 · Local secret hook starter (`profiles/starter/hooks/`: lefthook + gitleaks with org rules; verified locally: a fake key is blocked, a clean commit passes); weekly full-history TruffleHog on schedule/dispatch (verified locally with the pinned image); org-audit checks `hooks`, `depsUpdates`, `secretScan` and Actions minutes (7 days) per repo, adoption PRs add the hook files; `vars.HARNESS_RUNS_ON` for every reusable job (this repo's own jobs stay GitHub-hosted); npm cache in the js job; draft PRs skip heavy checks and are not graded; e2e `draft` scenario. 119 tests pass. Pending: App permission Actions: Read (user), tag `v1` move (user), e2e once the Actions budget is set.
