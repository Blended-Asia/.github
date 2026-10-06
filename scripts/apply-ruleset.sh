#!/usr/bin/env bash
# Tạo/cập nhật org ruleset bằng gh CLI (cần quyền owner của org).
#   ./scripts/apply-ruleset.sh <org> [team|enterprise] [active|evaluate|disabled]
#   SOLO=true ./scripts/apply-ruleset.sh my-org team active   # repo 1 người: không bắt approve
set -euo pipefail
ORG=${1:?Thiếu tên org}
PLAN=${2:-team}
ENFORCEMENT=${3:-}
cd "$(dirname "$0")/.."

file=rulesets/org-baseline.json
[ "$PLAN" = "enterprise" ] && file=rulesets/org-baseline-enterprise.json
body=$(cat "$file")
[ -n "$ENFORCEMENT" ] && body=$(jq --arg e "$ENFORCEMENT" '.enforcement = $e' <<<"$body")

if [ "$PLAN" = "enterprise" ]; then
  id=$(gh api "repos/$ORG/.github" --jq .id)
  body=$(jq --argjson id "$id" '(.rules[] | select(.type == "workflows") | .parameters.workflows[]).repository_id = $id' <<<"$body")
fi
if [ "${SOLO:-false}" = "true" ]; then
  body=$(jq '(.rules[] | select(.type == "pull_request") | .parameters) |= (.required_approving_review_count = 0 | .require_code_owner_review = false | .require_last_push_approval = false)' <<<"$body")
fi

name=$(jq -r .name <<<"$body")
existing=$(gh api "orgs/$ORG/rulesets" --paginate --jq ".[] | select(.name == \"$name\") | .id" | head -1)
if [ -n "$existing" ]; then
  gh api -X PUT "orgs/$ORG/rulesets/$existing" --input - <<<"$body" --jq '"Đã cập nhật ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
else
  gh api -X POST "orgs/$ORG/rulesets" --input - <<<"$body" --jq '"Đã tạo ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
fi
