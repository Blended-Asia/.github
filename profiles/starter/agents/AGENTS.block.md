## Org conventions for AI agents (Blended-Asia)

These rules are checked on every pull request by the org harness (`org / pr-convention`, `harness / gate`). A PR that breaks them cannot be merged, so follow them up front.

### Branches
- Name: `<type>/<short-kebab-description>`, type one of `feat`, `feature`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `hotfix`, `release`, `revert`. Lowercase letters, digits, `.`, `_`, `-` only. Example: `feat/cost-connectors`.
- Branch from the gated branch (the default branch, or `develop` in git-flow repos) and open the PR into it. Never push to it directly.

### Commits
- English, [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.

### Pull requests
- **Title**: `type(scope): description` with type one of `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`, `style`; **at most 72 characters**; no trailing period. Count the characters before you submit.
- **Description**: must contain these headings, each with content (write `N/A` if nothing applies):
  - `## Summary` — what changed and why.
  - `## How to test` — steps a reviewer can follow.
  Start from `.github/pull_request_template.md`.
- **Before creating or editing a PR, run the checker** and fix everything it reports:
  ```bash
  node .github/scripts/pr-lint.mjs --title "<title>" --body-file <file> [--branch <branch>]
  ```
  Create the PR with explicit values (`gh pr create --title "<title>" --body-file <file>`), never `--fill`.
- Repo-specific overrides (ticket IDs, required scopes…) live in `.github/workflows/org-pr-convention.yml` under `with:`; the checker reads them.

### Never
- Never bypass or weaken checks: no `--no-verify`, no "merge without waiting for requirements", no editing `.github/workflows/org-*.yml`, `.github/harness.yml` or `CODEOWNERS` to make a check pass. Fix the code instead.
- Never commit secrets or `.env*` files.
- Never approve or merge your own PR.
