#!/usr/bin/env bash
# Create/update an org ruleset with the gh CLI (requires org owner permission).
#   ./scripts/apply-ruleset.sh <org> <ruleset> [active|evaluate|disabled]
# <ruleset>:
#   trunk-team | trunk-solo | gitflow-team | gitflow-solo   rulesets/org-<ruleset>.json (per repo group)
#                    trunk: gate default branch · gitflow: gate develop · solo: no approval/code owner required
#   team | enterprise                                       legacy org-baseline(-enterprise) ruleset covering ~ALL
#   <path to a .json file>                                  any file
# Environment variables:
#   REPOS=a,b     repos to apply to (overrides conditions.repository_name.include). Required for group rulesets.
#   BRANCHES=x,y  overrides conditions.ref_name.include (e.g. refs/heads/develop,refs/heads/release/*)
#   SOLO=true     drop the approval requirement (kept for backward compatibility)
#   DRY_RUN=true  only print the JSON that would be sent, don't call the API
#   ./scripts/apply-ruleset.sh Blended-Asia gitflow-team active    # with REPOS=jfoodhub-workspace
set -euo pipefail
ORG=${1:?Missing org name}
KIND=${2:-team}
ENFORCEMENT=${3:-}
cd "$(dirname "$0")/.."

case "$KIND" in
  team) file=rulesets/org-baseline.json ;;
  enterprise) file=rulesets/org-baseline-enterprise.json ;;
  trunk-team | trunk-solo | gitflow-team | gitflow-solo) file="rulesets/org-$KIND.json" ;;
  *.json) file=$KIND ;;
  *) echo "Invalid ruleset: $KIND" >&2; exit 2 ;;
esac
[ -f "$file" ] || { echo "Not found: $file" >&2; exit 2; }
body=$(cat "$file")
[ -n "$ENFORCEMENT" ] && body=$(jq --arg e "$ENFORCEMENT" '.enforcement = $e' <<<"$body")

csv_to_json() { jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))' <<<"$1"; }
if [ -n "${REPOS:-}" ]; then
  body=$(jq --argjson r "$(csv_to_json "$REPOS")" '.conditions.repository_name.include = $r' <<<"$body")
fi
if [ -n "${BRANCHES:-}" ]; then
  body=$(jq --argjson b "$(csv_to_json "$BRANCHES")" '.conditions.ref_name.include = $b' <<<"$body")
fi
if [ "$(jq '.conditions.repository_name.include | length' <<<"$body")" = "0" ]; then
  echo "Ruleset $(jq -r .name <<<"$body") has no repos: set REPOS=a,b" >&2
  exit 2
fi

if [ "$KIND" = "enterprise" ] && [ "${DRY_RUN:-false}" != "true" ]; then
  id=$(gh api "repos/$ORG/.github" --jq .id)
  body=$(jq --argjson id "$id" '(.rules[] | select(.type == "workflows") | .parameters.workflows[]).repository_id = $id' <<<"$body")
fi
if [ "${SOLO:-false}" = "true" ]; then
  body=$(jq '(.rules[] | select(.type == "pull_request") | .parameters) |= (.required_approving_review_count = 0 | .require_code_owner_review = false | .require_last_push_approval = false)' <<<"$body")
fi

if [ "${DRY_RUN:-false}" = "true" ]; then
  jq . <<<"$body"
  exit 0
fi

name=$(jq -r .name <<<"$body")
existing=$(gh api "orgs/$ORG/rulesets" --paginate --jq ".[] | select(.name == \"$name\") | .id" | head -1)
if [ -n "$existing" ]; then
  gh api -X PUT "orgs/$ORG/rulesets/$existing" --input - <<<"$body" --jq '"Updated ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
else
  gh api -X POST "orgs/$ORG/rulesets" --input - <<<"$body" --jq '"Created ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
fi
