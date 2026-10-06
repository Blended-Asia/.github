#!/usr/bin/env bash
# Tạo/cập nhật org ruleset bằng gh CLI (cần quyền owner của org).
#   ./scripts/apply-ruleset.sh <org> <ruleset> [active|evaluate|disabled]
# <ruleset>:
#   trunk-team | trunk-solo | gitflow-team | gitflow-solo   rulesets/org-<ruleset>.json (theo nhóm repo)
#                    trunk: gate default branch · gitflow: gate develop · solo: không bắt approve/code owner
#   team | enterprise                                       ruleset cũ org-baseline(-enterprise) phủ ~ALL
#   <đường dẫn file .json>                                  file tuỳ ý
# Biến môi trường:
#   REPOS=a,b     danh sách repo áp dụng (ghi đè conditions.repository_name.include). Ruleset nhóm bắt buộc có.
#   BRANCHES=x,y  ghi đè conditions.ref_name.include (vd refs/heads/develop,refs/heads/release/*)
#   SOLO=true     bỏ yêu cầu approve (giữ tương thích với cách gọi cũ)
#   DRY_RUN=true  chỉ in JSON sẽ gửi, không gọi API
#   ./scripts/apply-ruleset.sh Blended-Asia gitflow-team active    # với REPOS=jfoodhub-workspace
set -euo pipefail
ORG=${1:?Thiếu tên org}
KIND=${2:-team}
ENFORCEMENT=${3:-}
cd "$(dirname "$0")/.."

case "$KIND" in
  team) file=rulesets/org-baseline.json ;;
  enterprise) file=rulesets/org-baseline-enterprise.json ;;
  trunk-team | trunk-solo | gitflow-team | gitflow-solo) file="rulesets/org-$KIND.json" ;;
  *.json) file=$KIND ;;
  *) echo "Ruleset không hợp lệ: $KIND" >&2; exit 2 ;;
esac
[ -f "$file" ] || { echo "Không thấy $file" >&2; exit 2; }
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
  echo "Ruleset $(jq -r .name <<<"$body") chưa có repo nào: đặt REPOS=a,b" >&2
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
  gh api -X PUT "orgs/$ORG/rulesets/$existing" --input - <<<"$body" --jq '"Đã cập nhật ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
else
  gh api -X POST "orgs/$ORG/rulesets" --input - <<<"$body" --jq '"Đã tạo ruleset \(.name) (#\(.id)), enforcement=\(.enforcement)"'
fi
