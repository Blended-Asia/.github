# Managing the harness from ops-dashboard

Spec for the ops-dashboard (`Blended-Asia/ops-dashboard`) feature that shows and changes the org harness per product repo: status, request adoption ("init"), and settings (enforce/observe, bot auto-merge, AI review…).

## Principles (do not break)

1. **GitHub stays the source of truth.** The dashboard never stores harness settings as its own data. It reads them from GitHub and caches a snapshot for display.
2. **Every change is a pull request.** The dashboard proposes changes; a human merges them. Harness config is read from the PR's base commit, and `.github/**` is owned by `@Blended-Asia/platform` (CODEOWNERS), so settings changes take effect only after platform review and merge. Never write to a default/working branch directly.
3. **No admin credentials in the dashboard.** Use only the existing harness App (`blended-asia-harness`, already planned in `docs/04-github-sync.md`). Never use or store the admin App (`blended-asia-harness-admin`); its key lives only in the `admin` environment of `gh-harness`. Runner groups, rulesets and repo settings are applied by the `reconcile` workflow there.
4. **Validate everything server-side.** Repo names `^[A-Za-z0-9._-]+$`, enum values only, an allow-list of editable keys. Only staff with the platform/admin role can create PRs.

## Where things live

| What | Where | Format |
|---|---|---|
| Registry (which repos are adopted) | `Blended-Asia/gh-harness`, `repos/<repo>.yml` on `main` | see below |
| Pending adoption requests | open PRs in `gh-harness` with head `adopt/<repo>` | |
| Per-repo settings | `<repo>/.github/harness.yml` on the gated branch | keys and defaults: `profiles/base.yml` in `Blended-Asia/.github` |
| Adoption PR in the product repo | head branch `ci/org-harness-v1`, title `ci: adopt org harness (v1)` | |
| Branch protection | org rulesets `org-{trunk,gitflow}-{solo,team}` (`conditions.repository_name.include`) | |
| Gate result | check run `harness / gate` on the PR head / gated branch head; bot comment marked `<!-- harness-report -->` | |
| Org report | issue labelled `org-audit` in `Blended-Asia/org-audit-reports` (Markdown table) | |

Registry entry (`repos/<repo>.yml`), exactly as produced by `entryYaml()` in `scripts/adopt.mjs`. `reconcile` validates it with `validateEntry()`: the file name must equal `repo`, and `kind`, `team` and `flow` must be one of the listed values.
```yaml
repo: ops-dashboard
kind: new        # new | existing
team: solo       # solo | team
flow: trunk      # trunk | gitflow
requested_by: <github login>
```

## Adoption lifecycle (state machine to display)

`not_requested` → `requested` (open `adopt/<repo>` PR in gh-harness) → `registered` (file on gh-harness `main`) → `adoption_pr_open` (`ci/org-harness-v1` PR open in the repo) → `adopted` (the repo has `.github/workflows/org-harness.yml` and `org-pr-convention.yml` on its gated branch) → `protected` (the gated branch has a `pull_request` rule: `GET /repos/{repo}/rules/branches/{branch}`).

Same logic as `gh harness status` (`gh-harness/gh-harness`, `cmd_status`). Mode: `enforcement` from `.github/harness.yml` (`enforce` | `observe`); a missing file means org defaults.

## Features

### 1. Status (read-only)
Per product repo: lifecycle state with links (registry PR, adoption PR), `enforcement`, `kind`, `team`, `flow`, gated branch, AI review on/off and auth mode, latest `harness / gate` conclusion on the gated branch, open harness-settings PRs. Refresh in the existing hourly GitHub sync, and on webhooks for `push`/`pull_request` in `gh-harness` and in product repos.

### 2. Request adoption ("init")
For repos in `not_requested`. The user picks `kind` (new: enforce from day one · existing: observe first) and `team` (solo · team). The server detects `flow`: `gitflow` if the registry entry says so or a `develop` branch exists, else `trunk`. Then it opens the registry PR in `gh-harness` with the harness App, mirroring `request()` in `scripts/adopt.mjs`:
1. Branch `adopt/<repo>` from `main` (reset it if it exists and no PR is open).
2. `PUT contents/repos/<repo>.yml` with the YAML above.
3. Open the PR `feat: adopt org harness in <repo>`. Its body must contain `## Summary` and `## How to test`.
4. If a PR for that head is already open, update it and return its URL.

After platform merges it, `reconcile` does the rest (runners, auto-merge, adoption PR, ruleset). The dashboard only shows progress.

### 3. Settings (proposes a PR)
Allow-listed keys, edited in `<repo>/.github/harness.yml` on the gated branch:

| UI control | Key | Values |
|---|---|---|
| Mode | `enforcement` | `enforce` · `observe` |
| Bot approves low-risk PRs | `merge.bot_approve.enabled` | bool |
| Bot approve size limit | `merge.bot_approve.max_lines` | int 1–1000 |
| Auto-merge when the harness passes | `merge.auto` | bool |
| AI review | `review.ai` | bool |
| AI credentials | `review.auth` | `auto` · `token` · `api_key` |
| AI blocks on | `review.block_on` | subset of `critical, major, minor` |
| Lint strictness | `convention.granularity` | `line` · `file` |
| Gated branches | `gate.branches` | list of branch names/globs |

Flow:
1. Read the file. If it is missing, start from an empty document.
2. Apply the change with a comment-preserving YAML editor (`yaml` package, `parseDocument` + `setIn`).
3. Show a diff preview to the user.
4. Open a PR in the product repo: branch `harness/settings-<timestamp>`, title `ci(harness): <short change>`, body listing old → new values plus `## Summary` and `## How to test`. Never merge it from the dashboard.

Turning a repo's harness off entirely, editing rules (`architecture.*`, `human_required_paths`) and anything about secrets are **out of scope**: link to the repo instead. Security rules cannot be disabled from `harness.yml` anyway.

### 4. Secrets for AI review
The dashboard does not read or write secrets. It shows which auth the last AI review used, parsed from the gate comment line `AI review via …`. Setting `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` stays a platform task (`gh secret set`).

## Data model suggestion
`harness_snapshots` (one row per product repo, server-written, same access rules as `repo_snapshots`): `lifecycle_state`, `registry_entry jsonb`, `registry_pr_url`, `adoption_pr_url`, `adoption_pr_state`, `config jsonb` (parsed `harness.yml`), `enforcement`, `ai_enabled`, `ai_auth`, `protected bool`, `gate_conclusion`, `open_settings_pr_urls text[]`, `synced_at`. Record every PR the dashboard opens in the existing audit/`sync_runs` log, with the user who requested it.

## App permissions
The harness App already has Contents R/W, Pull requests R/W, Issues R/W, Workflows R/W, Administration R and Actions R on all repos (including `gh-harness`). That covers everything above, and no new permission is needed. Rulesets: read them through `GET /repos/{repo}/rules/branches/{branch}`, which works with repo-level access.

## References
- `Blended-Asia/.github`: `scripts/adopt.mjs` (`request`, `entryYaml`, `validateEntry`, `rulesetName`), `profiles/base.yml` (all keys and defaults), `README.md` ("Gate: reject, approve, merge", "Runners and Actions minutes").
- `Blended-Asia/gh-harness`: `README.md`, `gh-harness` (`cmd_status`), `.github/workflows/{request,reconcile}.yml`.
