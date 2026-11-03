## Org conventions

@AGENTS.md

Branch, commit and pull-request rules for this org are in `AGENTS.md` (section "Org conventions for AI agents"). A hook in `.claude/settings.json` runs `.github/scripts/pr-lint.mjs` before every `gh pr create` / `gh pr edit` and blocks the command if the title, branch or description breaks the convention: fix what it reports and retry.
