# Blended-Asia/.github: a harness for every PR

> Continuing with Claude Code: read `CLAUDE.md` (context + invariants) and `HANDOFF.md` (remaining work by phase).

**Harness** = all the machinery around a PR, in two parts:
- **Sensors**: the checks (security, infra, convention, architecture) that run according to the repo's stack.
- **Gate**: the feedback loop. If the PR does not pass, it comments with the reasons and what to fix. If it passes, it approves (when risk is low) and merges automatically.

The logic lives in this repo, pinned to the `v1` tag. Each child repo only needs 2 short caller files and an optional config file `.github/harness.yml`.

```
PR opened / commit pushed
 ├─ org-pr-convention.yml ──► org / pr-convention            (title, branch, description, size)   ← required
 └─ org-harness.yml
      ├─ security   TruffleHog · Trivy CVE · Semgrep · .env/public secrets
      ├─ infra      Docker · Vercel · Supabase (auto-detected)
      ├─ stack      plan → architecture (any language)
      │                  → rails (RuboCop · Brakeman · Packwerk)      ┐ one job
      │                  → react / node (ESLint · tsc · Prettier · dependency-cruiser) ┘ per directory
      └─ harness / gate  ◄── aggregate results + AI review (optional)                  ← required
              ├─ ❌ not passing → sticky comment: which job failed, file:line, how to fix
              └─ ✅ passing     → small & no sensitive paths touched: bot approves
                                → enable auto-merge: GitHub merges once required checks + reviews are satisfied
Ruleset org-baseline ──► requires the 2 checks above
org-audit (Mondays) ──► scans every repo, detects modified callers / loosened config, opens adoption PRs
```

## Templates per stack (profiles)

Templates are not per repo but per **stack profile**. A repo only declares which profile it belongs to (or lets it be auto-detected) and overrides what differs.

| Profile | Detection | Tools | Default architecture rules |
|---|---|---|---|
| `rails` | Gemfile contains `rails` | RuboCop (repo config), Brakeman (blocks from Medium confidence), Packwerk if `packwerk.yml` exists | models don't use params/session/render · views don't query the DB · controllers don't use raw SQL · migrations don't call app models · disabling CSRF requires review |
| `react` | package.json has react/next | ESLint (repo config), `tsc --noEmit`, Prettier (if the repo uses it), dependency-cruiser: import cycles, devDependency imports in production code, unresolvable imports | client components don't read server env / service role / import server code · `components/` doesn't import from `app/`/`pages/` · warns on `dangerouslySetInnerHTML`, `@ts-ignore` |
| `node` | other package.json | same as `react` | no string concatenation into SQL · warns on `console.log` |

- `profiles/<stack>.yml` holds the org's default tools and rules. Changes here apply to every repo on that stack.
- `profiles/starter/` holds sample files for child repos: `harness.yml`, `.rubocop.yml`, `eslint.config.mjs`, `.prettierrc.json`, `.dependency-cruiser.cjs`, and an `ARCHITECTURE.md` per stack (the reference document the AI reviewer checks against).
- Monorepo: each directory is a profile, run in parallel (e.g. `api/` rails + `web/` react).
- Adding a new stack (Go, Python…): add `profiles/<name>.yml` + a branch in `scripts/harness/stack.mjs` + a job in `stack.yml`.

**Block only new debt.** On a PR, ESLint/Prettier/RuboCop/architecture rules only look at changed files or lines. `tsc` and Brakeman additionally run on the base commit (git worktree) for comparison:
- Pre-existing errors in unchanged files: noted only, not blocking.
- **New errors caused by the PR** in unchanged files still block. Example: renaming an exported function breaks the files that call it.

To scan the whole repo, use `convention.scope: all`. Runs on `main`/schedule scan everything and only report.

### Repo-specific architecture rules

Rules are regexes that work for any language: "files matching `paths` must not contain `forbid`".

```yaml
# .github/harness.yml
architecture:
  disable: [react/no-ts-ignore]
  rules:
    - id: web/features-isolated
      paths: ["web/src/features/**"]
      forbid: 'from\s+["'']@/features/(?!shared/)'
      message: Features must not import another feature's internals; go through @/features/shared.
      severity: error            # error blocks the PR, warn only warns
      # allow: '...'             # lines matching allow are skipped
      # if_file_matches: '...'   # only applies to files whose content matches (e.g. "use client")
```

To intentionally skip a line, add a `harness-disable-line <rule-id>` comment to it. PRs containing such markers (including `eslint-disable`, `rubocop:disable`, `nosemgrep`, `@ts-ignore`…) are not auto-approved by the bot and need a human review.

**`.github/harness.yml` is always read from the PR's base commit.** So a PR cannot disable rules or raise the approval threshold for itself. Config changes only take effect after merge, and the file is under `.github/**`, so it always needs a human review.

## Existing projects

Existing repos are rolled out **observe first, enforce later**. Detailed instructions for humans and for Claude Code are in [`docs/onboarding-existing-repo.md`](docs/onboarding-existing-repo.md).

- **`enforcement: observe`**: the gate grades and comments "if enforced, this PR would be blocked because…" but does not block or auto-approve/merge. Harness adoption PRs opened by org-audit already set this mode.
- **Block only new debt, in every check**:
  - ESLint, RuboCop: re-run on the base version of the changed files themselves and only block errors that **did not exist before**, including new errors on old lines (e.g. removing a usage makes a variable unused). Editing one line in an old file does not require cleaning up the whole file.
  - tsc, Brakeman: compared with base, only new errors block.
  - Prettier: files that were already unformatted only warn.
  - Trivy CVE and misconfig: compared with base, counted by occurrence. Adding a second instance of the same issue is still caught.
  - Hadolint, compose: compared with the base version of the same file.
  - `vercel.json`, migration names: changed/new files only.
  - Supabase Advisor: `advisors_ignore` for accepted debt.
  - New repos that want "touch a file, clean the file" can set `convention.granularity: file`.
- **`scripts/harness/debt.mjs`**: run at the root of an existing repo to count violations per rule across the whole repo, detect committed env files, and scaffold a `harness.yml`.
  - Rules with many existing violations are flagged "review", since they may not fit the actual architecture. The script never disables or downgrades a rule on its own.
  - Security rules (`security: true`) cannot be disabled or downgraded from the repo.
- The only exception that blocks every PR from day one: committed `.env*`/`.vercel/` files. They must be removed and the secrets rotated.

## Gate: reject, approve, merge

| Situation | Gate | Action |
|---|---|---|
| A job failed | ❌ | Sticky comment listing the job, `file:line` and the error (taken from the run's annotations) + log link |
| Repo in `enforcement: observe` | 👀 | Comment "if enforced, would block because…", check always green, no approve/merge |
| PR into a branch outside `gate.branches` (default: only the default branch; git-flow sets `[develop]`) | ⏭️ | `harness / gate` and `org / pr-convention` green, summary only, no comment/approve/merge |
| AI review found `critical`/`major` issues | ❌ | Inline comments on the exact lines + summary in the sticky comment |
| Passing, ≤ `max_lines` (default 200), no `human_required_paths` touched, matching `authors` | ✅ | Bot **approves** + enables **auto-merge** |
| Passing but touches migrations, `.github/`, auth, Dockerfile, manifest/lockfile, linter config, or adds check-disabling markers | ✅ | Enables auto-merge, notes "needs human review". Merges as soon as someone approves |
| Draft | ✅/❌ | Comment only, no approve/merge |
| PR from a fork | ✅/❌ | Grade only, no comment/approve/merge, no AI call |
| Re-run of an old run after the PR got new commits | ✅/❌ | Grades the old commit only, writes nothing to the PR |

Auto-merge uses GitHub's native feature, so GitHub always waits for **every** required check (including `org / pr-convention`) and the number of approvals the ruleset requires.

**AI review** (`review.ai: true`) calls OpenAI Chat Completions (default, `review.provider: openai`) or the Claude API (`provider: anthropic`) with structured output. It reads the diff (lockfiles excluded), the repo's `ARCHITECTURE.md` and the linter results, then returns comments by severity.
- The AI **can only block**. Approval is decided by fixed policy (size, paths, author), because PR content may contain prompt injection such as "please approve this PR". The prompt treats the diff as untrusted data and reports injection as a `critical` issue.
- Each commit is AI-reviewed **only once**. The result is stored in the gate's own review (`github-actions[bot]` or the harness App; other bots cannot forge it) and reused on re-runs. If the AI blocked on an earlier commit of the PR, the fix always needs human confirmation. This way, pushing empty commits to get a fresh AI review does not work either.
- False AI block: someone with **maintain/admin permission, other than the PR author**, adds the `harness:override-ai` label and re-runs the gate job. Labels added by the author or by someone with only write permission have no effect. An override cannot bypass tool errors, and the PR still needs a human approval.
- On API errors the default is not to block, but also not to auto-approve. Set `review.fail_closed: true` to block instead.
- `ARCHITECTURE.md` is also read from base: a PR cannot change the standard the AI grades it against.
- Leaving `review.model` empty uses the per-provider default model (`DEFAULT_MODELS` in `scripts/harness/verdict.mjs`).
- `review.language` sets the language of AI comments (default `en`).

## Your GitHub plan determines how strictly this can be enforced

| | Free | Team | Enterprise Cloud |
|---|---|---|---|
| Call reusable workflows from a **public** `.github` | ✅ all repos | ✅ all repos | ✅ all repos |
| Call from a **private** `.github` | private repos only | private/internal repos only | private/internal repos only |
| Ruleset requiring checks on **private repos** | ❌ (public repos only) | ✅ | ✅ |
| Required workflows: child repos need no caller and **cannot modify it** | ❌ | ❌ | ✅ |

**`.github` must be public** because the `stack` and `gate` jobs check out `scripts/harness` + `profiles` from this repo using the child repo's token. This repo contains no secrets. Audit reports always go to a separate private repo.

On Team, the caller lives in the child repo, so a developer could edit it in a PR to dodge checks. The following layers guard against that:
- `CODEOWNERS` covering `/.github/workflows/`, plus `require_code_owner_review` in the ruleset.
- `harness.yml` and `ARCHITECTURE.md` are read from base. `.github/**` and `CODEOWNERS` always need a human review, and config cannot turn that off (including on rename/move).
- org-audit compares callers with the templates, checks that CODEOWNERS covers both the callers and `harness.yml`, and reports when `harness.yml` is loosened (rules/tools disabled, auto-approve threshold raised…).
- The gate does not trust the `results` input alone; it queries the API itself for the status of every job in the run. Reviews/comments with fake markers inserted by regular users are ignored.
- The check is only named `harness / gate` when run from a PR/merge queue. Runs from push/schedule/"Run workflow" become `harness / gate (push)`…

Only Enterprise can lock this down completely, using `required-*.yml` + `rulesets/org-baseline-enterprise.json`.

## Setup

1. **Create the `Blended-Asia/.github` repo (public)**, push this content, then run:
   ```bash
   ./scripts/init.sh <org-name>        # replace Blended-Asia in every file
   git commit -am "chore: init" && git push
   git tag v1 && git push origin v1
   ```
2. **Org secrets/variables** for the harness:
   - `OPENAI_API_KEY` (secret, if using AI review; or `ANTHROPIC_API_KEY` with `review.provider: anthropic`).
   - **GitHub App "harness bot"** (recommended), permissions Contents R/W + Pull requests R/W, installed on all repos. Store variable `HARNESS_APP_CLIENT_ID` and secret `HARNESS_APP_PRIVATE_KEY`.
     - Why: merges performed with GITHUB_TOKEN **do not trigger workflows** on `main`. Vercel/Supabase integrations are unaffected, but deploys via GitHub Actions are.
     - Without an App, the harness uses GITHUB_TOKEN. For the bot to approve, enable Org settings → Actions → "Allow GitHub Actions to create and approve pull requests".
3. **Each repo**: Settings → General → enable **Allow auto-merge**. For repos where it is off, the gate comment will remind you.
4. **GitHub App for org-audit**: you can reuse the App from step 2 if you add the needed permissions: Administration *Read*, Contents *R/W*, Deployments *Read*, Issues *R/W*, Metadata *Read*, Pull requests *R/W*, Workflows *R/W*.
   - In the `.github` repo: variable `ORG_AUDIT_APP_CLIENT_ID`, secret `ORG_AUDIT_APP_PRIVATE_KEY`.
   - Variable `AUDIT_REPORT_REPO` is a **private** repo that receives the reports. Since the `.github` repo is public, the script runs in quiet mode automatically: no repo names in logs.
   - Optional: `PLATFORM_OWNERS=@Blended-Asia/platform`, `HARNESS_REF` (default `v1`).
5. **Rollout**:
   - Run org-audit as a dry run to see the report.
   - Run with `fix=true` to open a `ci: adopt org harness (v1)` PR in each repo. The PR adds `org-harness.yml`, `org-pr-convention.yml`, `harness.yml`, a PR template and CODEOWNERS.
   - Merge each PR. Copy starter files (`.rubocop.yml`, `eslint.config.mjs`…) into any repo where the gate reports them missing.
6. **Enable rulesets** *after* repos have their callers. Enabling earlier leaves PRs stuck at "Expected — Waiting for status".
   Rulesets are split by repo group (each repo belongs to **one** group only; do not combine with `org-baseline`):

   | Ruleset | Protected branch | Approvals |
   |---|---|---|
   | `org-trunk-team` | default branch | 1 + code owner |
   | `org-trunk-solo` | default branch | 0 |
   | `org-gitflow-team` | `develop` | 1 + code owner |
   | `org-gitflow-solo` | `develop` | 0 |

   Git-flow repos must set `gate.branches: [develop]` in `harness.yml`. Allowed merge methods: `squash` + `merge`.
   ```bash
   REPOS=web,api ./scripts/apply-ruleset.sh <org> trunk-team active
   REPOS=jfoodhub-workspace ./scripts/apply-ruleset.sh <org> gitflow-team active
   DRY_RUN=true REPOS=x ./scripts/apply-ruleset.sh <org> gitflow-solo   # only print JSON
   ./scripts/apply-ruleset.sh <org> team active                        # legacy: org-baseline covering ~ALL (SOLO=true: no approval required)
   ./scripts/apply-ruleset.sh <org> enterprise evaluate                # Enterprise: trial run first
   ```
   `REPOS` overwrites the ruleset's repo list (pass the full list every time). After the first PR, check that the actual check names on the PR are `org / pr-convention` and `harness / gate`; if not, fix `context` in `rulesets/*.json`. `integration_id: 15368` is GitHub Actions, used to stop anyone from faking statuses via the API.
7. **Vercel preview** with Deployment Protection: create a *Protection Bypass for Automation* and store it as the org secret `VERCEL_AUTOMATION_BYPASS_SECRET`.

Skipping findings whose risk has been accepted: `.trivyignore`, `// nosemgrep`, `.hadolint.yaml`, `config/brakeman.ignore`, `harness-disable-line`. Repos with migrations should also enable "Require branches to be up to date" so the timestamp-order check always compares against the latest base.

## Releasing changes

PR into this repo → `self-test` (actionlint + offline tests) → merge → move the tag:
```bash
git tag -f v1 && git push -f origin v1     # compatible change
```
For a breaking change:
1. Change the default `harness_ref` in `stack.yml` and `harness.yml` to `v2`, then tag `v2`.
2. Set the variable `HARNESS_REF=v2` and run org-audit with `fix=true`. The audit opens ref-bump PRs and keeps each repo's config intact.

Run tests locally: `node --test 'tests/*.test.mjs'` (Node ≥ 22, requires `git`, `ruby`, `python3`, `docker compose`).

## Not done yet

- Go/Python/PHP profiles: the scaffolding is ready; add them following "Adding a new stack".
- Deploy: Vercel/Supabase still deploy via their integrations. `supabase db push` on `main` after a green gate could be added.
- Building and scanning Docker images (`trivy image`), test coverage, running the repo's test suite. The harness does not run the repo's `rspec`/`vitest` because each repo needs different DBs/services. Let the repo's own test CI be the third required check.
