## Org conventions

Follow `AGENTS.md` at the repository root (section "Org conventions for AI agents"). In short:
- Branch `type/kebab-description`; Conventional Commits in English.
- PR title `type(scope): description`, at most 72 characters, no trailing period.
- PR description with `## Summary` and `## How to test`, both filled in (`N/A` if nothing applies).
- Before opening or editing a PR, run `node .github/scripts/pr-lint.mjs --title "<title>" --body-file <file>` and fix what it reports.
