# CLAUDE.md — the org's `.github` repo (harness for every PR)

Read this file first, then read `HANDOFF.md` to see what is in progress and in what order to work.

## What this repo is

This is the `<org>/.github` repo (**must be public**). Every repo in the org calls workflows from this repo, pinned to the `v1` tag. A child repo only has:
- `.github/workflows/org-harness.yml`
- `.github/workflows/org-pr-convention.yml`
- `.github/harness.yml` (optional)

The harness has two parts:
- **Sensors** (checks): `security.yml`, `infra.yml`, `stack.yml` (per rails/react/node profile + architecture rules), `pr-convention.yml`.
- **Gate** (`harness.yml` → `scripts/harness/verdict.mjs`): aggregates the results of every job in the run.
  - Not passing: sticky comment + red `harness / gate` check.
  - Passing: the bot approves if risk is low, then enables native auto-merge.
  - AI review (OpenAI or Claude, per `review.provider`) is optional and **can only block**.

Language: everything in this repo is **English** — code, comments, docs, commit messages, and the text the bot posts on PRs. The AI review language is configurable via `review.language` (default `en`).

Commit messages: English, [Conventional Commits](https://www.conventionalcommits.org/), no `Co-Authored-By` trailers.

## Map

```
.github/workflows/
  pr-convention.yml security.yml infra.yml stack.yml harness.yml   # reusable (workflow_call)
  vercel-preview.yml codeql.yml                                    # reusable, opt-in
  org-audit.yml                                                    # runs in this repo: scans the whole org
  required-convention.yml required-harness.yml                     # only for the Enterprise "require workflows" ruleset
  self-test.yml                                                    # CI for this repo
workflow-templates/   callers that child repos copy (Blended-Asia, $default-branch is a placeholder)
profiles/             base.yml (shared policy) · rails.yml react.yml node.yml (tools + rules) · starter/ (sample files for child repos)
scripts/harness/      lib (glob, git, YAML via ruby, annotations) · config (resolve + detect) · rules (architecture)
                      · stack (run tools, compare to baseline) · verdict (gate) · debt (measure debt of an existing repo before onboarding)
docs/onboarding-existing-repo.md   process for bringing an EXISTING repo into the harness (observe → enforce)
scripts/org-audit.mjs scans the org: caller drift, CODEOWNERS, rulesets; FIX=true opens PRs
rulesets/             org-{trunk,gitflow}-{team,solo}.json (per repo group) · org-baseline.json (Team, ~ALL) · org-baseline-enterprise.json
tests/                node:test, runs offline; integration.test.mjs runs real tools when HARNESS_INTEGRATION=1
```

## Commands

```bash
node --test 'tests/*.test.mjs'                                  # 97 tests, ~10s. Needs git, ruby, python3, docker compose (CLI, no daemon needed)
HARNESS_INTEGRATION=1 node --test tests/integration.test.mjs    # ~2 min: npm install Next/ESLint/TS, bundle RuboCop, gem Brakeman
actionlint .github/workflows/*.yml workflow-templates/*.yml     # must be clean, including shellcheck
./scripts/init.sh <org>                                         # replace Blended-Asia across the repo
./scripts/e2e-sandbox.sh <org>/harness-sandbox [e1 e2 …]       # verify on a real sandbox (gh + git), prints a table of PR links
REPOS=a,b ./scripts/apply-ruleset.sh <org> trunk-team|trunk-solo|gitflow-team|gitflow-solo|team|enterprise [active|evaluate|disabled]   # DRY_RUN=true: only print JSON
```

Before committing: run both the tests and actionlint. If you change `stack.mjs`, `profiles/*` or the starter `eslint.config.mjs`, also run the integration tests.

## Code conventions

- Scripts use **Node built-ins only**, no `npm install`. YAML is read via `ruby -ryaml` (`lib.loadYaml`) because runners always have Ruby.
- Every action is **pinned to a commit SHA** with a version comment (`@<sha> # vX.Y.Z`). Tools are version-pinned too: Trivy, Hadolint, Semgrep, dependency-cruiser, Brakeman, Supabase CLI.
- **Never use `${{ }}` inside a `run:` or `script:` body.** Pass values via `env:` to avoid script injection. `tests/workflows.test.mjs` fails on violations (and on actions not pinned to a SHA).
- Long logic lives in `scripts/`, not inline in YAML. Current exceptions: `pr-convention.yml` and `vercel-preview.yml` use inline github-script, marked with `// ---- x:begin/end ----` so tests can extract and run it.
- Findings are normalized to `{severity: 'error'|'warn', file (path from repo root), line, title, message}` and printed with `lib.report()`. The gate reads them back via the annotations API, so do not print errors any other way.
- Tests for new logic use `node:test`. Mock `fetch` for GitHub/OpenAI/Anthropic APIs; routers already exist in `tests/verdict.test.mjs` and `tests/org-audit.test.mjs`.

## Security invariants — DO NOT break (all have tests, all were once real vulnerabilities)

1. **Config is read from the PR's BASE commit.** Applies to `.github/harness.yml` (plan, architecture, gate) and `ARCHITECTURE.md` (AI prompt). A PR must not be able to loosen the rules used to grade itself (`resolveConfig({configRef})`, `loadPolicy({configRef})`).
2. **AI can only block, never approve.** Approval is decided only by fixed policy: total lines ≤ `max_lines`, no `human_required_paths` touched, no `suppression_markers`, matching `authors`, not a draft or fork.
3. `ALWAYS_HUMAN = ['.github/**', 'CODEOWNERS', '**/CODEOWNERS']` is hard-coded. The sensitive-path check also considers `previous_filename` (catches renames). Lockfiles, `.npmrc` and linter configs are all in the human paths.
4. The gate **only trusts its own reviews/comments** (`HARNESS_BOT_LOGIN` = `github-actions[bot]` or `<app-slug>[bot]`). Never trust `user.type === 'Bot'` in general.
5. AI review runs **exactly once per head SHA**. The result is stored in the review body `<!-- harness-ai:<sha> blockers=N verdict=X -->` and reused on re-runs. If the AI blocked on an earlier commit → no bot approval (prevents pushing empty commits to "reroll").
6. The `harness:override-ai` label only takes effect when the person who applied it has **maintain/admin permission and is not the PR author**. An override cannot bypass tool errors, and the PR still needs a human approval.
7. **Stale run** (`event.pull_request.head.sha` ≠ current head) → grade only, write nothing to the PR. The convention check always re-fetches the PR with `pulls.get` instead of using the old payload.
8. The required check `harness / gate` has exactly this name only for `pull_request` and `merge_group`. Push, schedule and dispatch run as `gate (<event>)`. The dynamic name lives on the job **inside** the reusable workflow; the caller job keeps the static name `harness`.
9. The gate does not trust the `results` input alone: it always re-queries `runs/{id}/jobs?filter=latest`.
10. After checkout, the harness code must be moved to `$RUNNER_TEMP/harness` so the child repo's ESLint/Prettier does not scan it by mistake.
11. **Block only new debt, in every check.** Default `convention.granularity: line`.
    - ESLint, RuboCop: re-run on the base version of the changed files and compare `file|rule|message` keys. If the base cannot be built, fall back to filtering by added lines.
    - `tsc`, Brakeman: compare keys/fingerprints with the base via `git worktree`. New errors caused by the PR in unchanged files **still block**.
    - Prettier: files that were already unformatted at base only warn.
    - Trivy CVE/misconfig: compared with base as a **multiset** (counted); misconfig keys include `Resource`. `--config` points to an empty file so the PR's `trivy.yaml` cannot disable the scan.
    - Hadolint, compose: compared with the base version of the same file.
    - vercel.json, migration names: changed/new files only.
    - tsc at base: if the PR changes dependencies or another package in the workspace, the base **must install its own deps** (never borrow the PR's node_modules). If the base cannot be built → **block**, do not skip.
    - Rules with `security: true` cannot be disabled or downgraded from `harness.yml`.
    - Advisor: `advisors_ignore`.
    - Intentional exception: committed `.env*`/`.vercel/` files always block.
12. `enforcement: observe` **never** approves or enables auto-merge, and the gate always exits 0. Since config is read from base, a PR cannot switch itself between observe and enforce.
13. org-audit: the `.github` repo is public → quiet mode (no repo names in logs); reports go to the private repo `AUDIT_REPORT_REPO`. Modified callers are only reported, never overwritten automatically.

Any change touching the points above must include tests proving the invariant still holds, and must say so explicitly in the PR description.

## Adding a new stack (e.g. Go, Python)

1. Create `profiles/<name>.yml`: `checks` + `architecture.rules`.
2. Add `<name>` to `PROFILES` and a detection branch in `config.mjs/detectProfiles`.
3. Add `runGo(ctx)` (or similar) to `stack.mjs`: the parser returns normalized findings, filters by `ctx.changed`, and has a baseline if the tool reports cross-file errors.
4. Add a job in `stack.yml` (toolchain setup + `stack.mjs <name>`), with the matching `plan` output.
5. Write unit tests for the parser and for detection. Add a case to `integration.test.mjs`.

## Releasing

Merge into `main` → move the `v1` tag (`git tag -f v1 && git push -f origin v1`). For a breaking change:
1. Change the default `harness_ref` in `stack.yml` and `harness.yml` to `v2`, then tag `v2`.
2. Set the variable `HARNESS_REF=v2` and run org-audit with `fix=true` to open ref-bump PRs in every repo.
