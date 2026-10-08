# Onboarding an EXISTING repo into the harness

Existing repos always carry debt: CVEs in lockfiles, Dockerfiles running as root, code violating architecture rules, sometimes even committed `.env` files. The principle here is **don't force old debt to be paid off before work can continue, but don't allow any new debt**.

## What the harness already handles

| Check | On a PR | Old debt |
|---|---|---|
| ESLint, RuboCop | changed files, compared with the base version of the same file: only new errors block, including new errors on old lines | not blocking |
| Prettier | changed files; files that were already unformatted only warn | warning |
| Architecture rules | added/changed lines only | not blocking |
| `tsc`, Brakeman | changed files + **new errors caused by the PR** in other files (compared with base via git worktree) | not blocking |
| Trivy CVE, Trivy misconfig | only what is **new** compared with the base lockfile/config | listed in the summary, not blocking |
| Hadolint, compose policy | changed files, compared with the base version of the same file: only new errors block | not blocking |
| `vercel.json` | changed files only | not blocking |
| Semgrep | baseline from base | not blocking |
| Secrets (TruffleHog), public variables leaking secrets | diff only | not blocking |
| Supabase migration names | newly added migrations only | not blocking |
| Supabase Security Advisor | whole DB | **blocking**, except keys listed in `advisors_ignore` |
| Committed `.env*` / `.vercel/` files | whole repo | **blocks every PR**; must be fixed and secrets rotated |

Pushes to `main` and the weekly scheduled scan still scan everything. Those results only report debt; they never block anyone.

## Process (Claude Code does the work, a human approves at the ⛔ points)

Preparation: clone the repo to onboard and the `<org>/.github` repo side by side.
```
~/work/<repo>        # cwd
~/work/.github       # harness
```

### 1. Measure debt
```bash
node ../.github/scripts/harness/debt.mjs > /tmp/debt.md
```
The report includes:
- detected profiles
- the number of violations of each architecture rule across the **whole repo**, and the files with the most violations
- committed env files, migrations with non-standard names
- missing config
- a `harness.yml` scaffold

How to read the violation counts: on a PR, architecture rules only look at **new lines**, so old debt never blocks a PR.
- A rule with dozens of existing violations is a sign it may **not fit the actual architecture**: new code written following existing patterns would be blocked. `debt.mjs` flags these rules for "review", but **never proposes disabling or downgrading them**.
- Only downgrade or disable a rule after seeing false positives on real PRs during the observe period.
- Security rules (`security: true`) cannot be disabled or downgraded from `harness.yml`. For a genuine exception, use `harness-disable-line` on that line; the PR will then need a human review.

Also run each stack in full-scan mode to gauge the size of the linter debt. Without `BASE_SHA`, the results are report-only:
```bash
PROFILE_PATH=web PROFILE_NAME=react CHECKS='{"eslint":true,"typecheck":true,"prettier":true,"depcruise":true,"depcruise_dirs":["src","app","lib"]}' \
  HARNESS_DIR=../.github node ../.github/scripts/harness/stack.mjs js
```

### 2. Fix what is mandatory (⛔ tell the user first)
- Committed `.env*` or `.vercel/` files:
  1. `git rm --cached`, add to `.gitignore`.
  2. **Rotate every secret in the file**, because the secrets are already in git history.
  3. The user must rotate them in the dashboards (Supabase, Stripe…). Claude Code only lists the keys that need rotating.
- Real secrets found by TruffleHog in history (scheduled job): handle as above. Removing them from history (`git filter-repo`) rewrites history and **requires asking the user**.

### 3. Write `ARCHITECTURE.md` from the actual code
Read the directory structure, a few representative controllers/models/services/components, routing, DB access and auth. Describe **the architecture the code actually follows**, not an ideal one. Templates are in `profiles/starter/<stack>/ARCHITECTURE.md`.
- Only turn into rules what most of the current code already follows. Things that are merely aspirations go into a "Direction" section so the AI does not block wrongly.
- List known exceptions (e.g. "the `legacy/billing` module does not use service objects yet").
- Purpose: the AI review uses this file as its standard. If it is wrong, the AI will block wrongly or miss things.

### 4. Write `.github/harness.yml`
Start from the `debt.mjs` scaffold, then:
- `enforcement: observe`
- Declare `profiles` explicitly if it is a monorepo or detection is wrong.
- **Do not disable or downgrade any rule yet.** Note the rules that need "review" for evaluation after the observe period.
- If `ARCHITECTURE.md` shows a default rule is plainly wrong for the repo's architecture (e.g. the repo uses `src/ui/` instead of `components/`): add a custom rule with the correct path, and only disable the default rule once the replacement exists.
- Add custom rules if `ARCHITECTURE.md` has rules that can be checked with a regex (e.g. no cross-feature imports).
- `merge.bot_approve.enabled: false` in the initial phase.

### 5. Keep the repo's existing CI
- The repo's test suite (rspec, vitest…) stays **as is** and serves as the third required check. The harness does not run tests.
- Lint jobs that duplicate the harness (e.g. running `eslint .`) can be removed once the harness runs reliably. Do not remove them in the onboarding PR.
- Old branch protection: org-audit reports any missing required checks.

### 6. Open the onboarding PR (⛔ user approves)
One PR `ci: adopt org harness (observe)` containing:
- `.github/workflows/org-harness.yml` and `.github/workflows/org-pr-convention.yml` (copied from `workflow-templates/`, replacing `$default-branch`)
- `.github/harness.yml`, `ARCHITECTURE.md`
- missing linter config (`.rubocop.yml`, `eslint.config.mjs`…) **only if** the team agrees. Adding linter config to an existing repo forces every touched file to be restyled.
- `.github/CODEOWNERS` covering `/.github/`
- `lefthook.yml` + `.gitleaks.toml` from `profiles/starter/hooks/` (local secret check; see "Local secret hook" in the README). Each developer runs `lefthook install` once.

Note: this PR itself runs the harness with the **default** config (enforce), because `harness.yml` is read from base, and base does not have the file yet.
- Thanks to "block only new errors", the gate is usually green: the PR only adds config files. If it adds new linter config, old lint errors do not count as new errors either.
- If the org ruleset **already** covers this repo (e.g. `~ALL`) and the gate is red, an admin bypass is needed, or temporarily exclude the repo from the ruleset. Better to finish onboarding repos **before** enabling rulesets, following the order in HANDOFF.
- **Enterprise** ("require workflows" ruleset): in observe mode, sensor jobs can still be red, and this type of ruleset usually requires the whole workflow to be green. During the observe period, exclude the repo from the ruleset (`conditions.repository_name.exclude`).

Right after merge, the repo enters observe mode.

Supabase: the first time, the `infra / supabase` job lists the `cacheKey`s of RLS/Advisor debt. Add them to `advisors_ignore` in the caller and open an issue to fix each one:
```yaml
  infra:
    uses: <org>/.github/.github/workflows/infra.yml@v1
    with:
      advisors_ignore: |
        rls_disabled_in_public_public_legacy_logs
```

### 7. Observe for 1–2 weeks
- The gate comments "if enforced, would block because…" on every PR. Collect **false positives**, fix `harness.yml` or the rules, or report to the `.github` repo if a default rule is wrong for the whole org.
- Count how many PRs would be blocked and why. The goal before enforcing is fewer than ~10% of PRs wrongly blocked.
- Lint/tsc errors are compared with base by **counting `file|rule|message` keys** (not by line number). Intended consequence: within the same file, fixing an old error and adding an identical one elsewhere does not block (the total does not increase). A new error of a different kind always blocks.

### 8. Enforce for real (⛔ user decides)
Three steps, one PR each:
1. `enforcement: enforce` (a PR editing `.github/harness.yml` needs a human review; takes effect after merge).
2. Add the repo to the org ruleset (or, if the ruleset already covers `~ALL`, the repo is included automatically).
3. Once things run smoothly: `merge.bot_approve.enabled: true`, and optionally `review.ai: true` (set `review.provider` — `openai` by default or `anthropic` — and the matching `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` secret).

### 9. Pay down debt gradually
- The weekly org-audit report + the summary of runs on `main` show the remaining debt.
- Each time a group is paid off: raise rules from `warn` to `error`, remove keys from `advisors_ignore`. The Advisor job summary already prints which keys have been fixed.

## Prompt for Claude Code

```
Onboard the current repo into the org harness following ../.github/docs/onboarding-existing-repo.md.
Read ../.github/CLAUDE.md first. Do steps 1–5, then stop and show me:
the debt report (debt.mjs), the ARCHITECTURE.md you wrote from the code, the proposed harness.yml, and the list of step 2 tasks, if any.
Do not open a PR, do not remove any files from git, and do not touch secrets until I agree.
```
