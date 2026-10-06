#!/usr/bin/env bash
# Kiểm chứng harness trên repo sandbox thật (Phase 3). Mỗi kịch bản: tạo branch → push → mở PR → chờ check → assert.
#   ./scripts/e2e-sandbox.sh <owner/repo> [kịch bản...]        # mặc định chạy tất cả
#   ./scripts/e2e-sandbox.sh Blended-Asia/harness-sandbox e1 e12 skip-main
#
# Yêu cầu sandbox (xem HARNESS_PLAN.md Phase 3):
#   - nhánh develop + main, cả hai có .github/harness.yml với `gate.branches: [develop, "e2e/*"]`
#   - caller org-harness.yml / org-pr-convention.yml, ruleset gitflow chỉ áp cho sandbox, bật Allow auto-merge
#   - Rails app trong $RAILS_DIR (mặc định jfoodhub), Next.js trong $WEB_DIR (mặc định web)
#   - E7 cần org secret OPENAI_API_KEY; E12 cần GitHub App (HARNESS_APP_*) + một workflow chạy khi push develop
# Biến môi trường:
#   REMOTE   git remote (mặc định git@github-work:<owner/repo>.git)
#   BASE     nhánh làm việc (mặc định develop) · MAIN nhánh release (mặc định main)
#   TIMEOUT  giây chờ check mỗi PR (mặc định 1800) · CLEANUP=false giữ lại PR/branch để xem
# Kết quả: dòng PASS/FAIL cho từng assert + bảng link PR để dán vào Nhật ký của HANDOFF.md. Exit 1 nếu có FAIL.
set -euo pipefail

REPO=${1:?Thiếu <owner/repo>}
shift
SCENARIOS=${*:-e1 e2 e4 e7 e9 e12 e14 env-example skip-main}
REMOTE=${REMOTE:-git@github-work:$REPO.git}
BASE=${BASE:-develop}
MAIN=${MAIN:-main}
TIMEOUT=${TIMEOUT:-1800}
CLEANUP=${CLEANUP:-true}
RAILS_DIR=${RAILS_DIR:-jfoodhub}
WEB_DIR=${WEB_DIR:-web}
RUN_ID=$(date +%m%d%H%M%S)
GATE='harness / gate'
CONV='org / pr-convention'

WORK=$(mktemp -d "${TMPDIR:-/tmp}/e2e-sandbox.XXXXXX")
FAILS=0
RESULTS=()
OPENED=()
BRANCHES=()

log() { printf '\n== %s\n' "$*"; }
pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check "<mô tả>" <lệnh...>
  local desc=$1
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}

cleanup() {
  if [ "$CLEANUP" = "true" ]; then
    for pr in "${OPENED[@]+"${OPENED[@]}"}"; do
      [ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state 2>/dev/null)" = "OPEN" ] && gh pr close "$pr" -R "$REPO" --delete-branch >/dev/null 2>&1 || true
    done
    for b in "${BRANCHES[@]+"${BRANCHES[@]}"}"; do git -C "$WORK/repo" push -q origin --delete "$b" >/dev/null 2>&1 || true; done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

git clone -q "$REMOTE" "$WORK/repo"
cd "$WORK/repo"
git config user.name "${GIT_AUTHOR_NAME:-harness-e2e}"
git config user.email "${GIT_AUTHOR_EMAIL:-harness-e2e@users.noreply.github.com}"

# ---------- git / PR helpers ----------
branch_from() { # branch_from <base> <tên> → checkout branch mới từ origin/<base>
  git fetch -q origin "$1"
  git checkout -q -B "$2" "origin/$1"
}
write() { # write <path> <nội dung>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
push_branch() {
  git add -A
  git commit -q -m "$1"
  git push -q -u origin HEAD
  BRANCHES+=("$(git branch --show-current)")
}
# Base riêng cho kịch bản cần config khác (đọc từ base): e2e/base-<x> từ develop + sửa harness.yml, push thẳng.
# Gọi trực tiếp (không qua $(...)) để BRANCHES/OPENED được ghi lại cho cleanup; kết quả trả qua NEWBASE / PR.
make_base() { # make_base <tên> <ruby sửa hash c> → NEWBASE
  NEWBASE="e2e/base-$1-$RUN_ID"
  branch_from "$BASE" "$NEWBASE"
  ruby -ryaml -e 'f = ".github/harness.yml"; c = (File.exist?(f) && YAML.safe_load(File.read(f))) || {}; '"$2"'; File.write(f, c.to_yaml)'
  push_branch "chore: e2e base $1"
}
open_pr() { # open_pr <base> <title> → PR
  local url
  url=$(gh pr create -R "$REPO" --base "$1" --head "$(git branch --show-current)" --title "$2" \
    --body $'## Summary\nKịch bản e2e của harness (tự động).\n\n## How to test\nChạy scripts/e2e-sandbox.sh.')
  PR=${url##*/}
  OPENED+=("$PR")
}
wait_checks() { # chờ tới khi có check harness/gate và không còn check nào pending
  local pr=$1 start json
  start=$(date +%s)
  sleep 20
  while :; do
    json=$(gh pr checks "$pr" -R "$REPO" --json name,bucket 2>/dev/null || echo '[]')
    if jq -e --arg g "$GATE" 'any(.[]; .name == $g) and all(.[]; .bucket != "pending")' <<<"$json" >/dev/null; then
      echo "$json"
      return 0
    fi
    if [ $(($(date +%s) - start)) -gt "$TIMEOUT" ]; then
      echo "$json"
      return 1
    fi
    sleep 20
  done
}
bucket() { jq -r --arg n "$2" '[.[] | select(.name == $n)][0].bucket // "missing"' <<<"$1"; }
bucket_like() { jq -r --arg re "$2" '[.[] | select(.name | test($re))][0].bucket // "missing"' <<<"$1"; }
pr_json() { gh pr view "$1" -R "$REPO" --json state,mergedAt,mergeCommit,reviews,comments,autoMergeRequest,url; }
report_comment() { jq -r '[.comments[] | select(.body | contains("<!-- harness-report -->"))] | last | .body // ""' <<<"$1"; }
# e2e không có người duyệt → mọi APPROVE đều là của bot harness
approved() { jq -e '[.reviews[] | select(.state == "APPROVED")] | length > 0' <<<"$1" >/dev/null; }
not_approved() { ! approved "$1"; }
record() { RESULTS+=("| $1 | $2 | $3 |"); }

wait_merged() { # chờ auto-merge xong
  local pr=$1 start
  start=$(date +%s)
  while [ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" != "MERGED" ]; do
    [ $(($(date +%s) - start)) -gt "$TIMEOUT" ] && return 1
    sleep 15
  done
}

# ---------- Kịch bản ----------
e1() { # PR sạch → check đúng tên, bot approve, auto-merge, tự merge
  log "E1 PR sạch vào $BASE"
  branch_from "$BASE" "feat/e2e-clean-$RUN_ID"
  write "$WEB_DIR/app/e2e-$RUN_ID.ts" "export const e2e$RUN_ID = (a: number, b: number): number => a + b;"
  push_branch "feat: e2e clean"
  local pr checks j
  open_pr "$BASE" "feat: e2e PR sạch $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E1 hết thời gian chờ check"
  check "E1 có check '$GATE' xanh" test "$(bucket "$checks" "$GATE")" = pass
  check "E1 có check '$CONV' xanh" test "$(bucket "$checks" "$CONV")" = pass
  sleep 10
  j=$(pr_json "$pr")
  check "E1 bot đã APPROVE" approved "$j"
  check "E1 auto-merge đã bật hoặc đã merge" jq -e '.autoMergeRequest != null or .state == "MERGED"' <<<"$j"
  check "E1 PR tự merge" wait_merged "$pr"
  E1_PR=$pr
  record E1 "$(jq -r .url <<<"$j")" "PR sạch → approve + auto-merge"
}

e12() { # merge do App → workflow chạy khi push develop CÓ chạy
  log "E12 merge bằng App kích hoạt workflow push $BASE"
  [ -n "${E1_PR:-}" ] || e1
  local j sha runs
  j=$(pr_json "$E1_PR")
  sha=$(jq -r '.mergeCommit.oid // ""' <<<"$j")
  check "E12 có merge commit" test -n "$sha"
  check "E12 người approve là App (không phải github-actions)" jq -e '[.reviews[] | select(.state == "APPROVED")] | any(.author.login != "github-actions" and .author.login != "github-actions[bot]")' <<<"$j"
  sleep 30
  runs=$(gh run list -R "$REPO" --branch "$BASE" --event push --commit "$sha" --json workflowName,status --limit 20)
  check "E12 có workflow chạy do push $BASE sau merge ($(jq -r 'map(.workflowName) | join(", ")' <<<"$runs"))" jq -e 'length > 0' <<<"$runs"
  record E12 "$(jq -r .url <<<"$j")" "merge do App → workflow push $BASE chạy"
}

e2() { # lỗi tsc + rule client-no-server-code → gate đỏ, sticky comment có file:dòng
  log "E2 lỗi tsc + rule kiến trúc"
  branch_from "$BASE" "feat/e2e-tsc-$RUN_ID"
  write "$WEB_DIR/app/e2e-bad-$RUN_ID.tsx" "'use client';
const x: number = 'a';
export const leak = process.env.SECRET ?? String(x);"
  push_branch "feat: e2e tsc error"
  local pr checks j body
  open_pr "$BASE" "feat: e2e lỗi tsc $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E2 hết thời gian chờ check"
  check "E2 '$GATE' đỏ" test "$(bucket "$checks" "$GATE")" = fail
  j=$(pr_json "$pr")
  body=$(report_comment "$j")
  check "E2 sticky comment có TS2322" grep -q 'TS2322' <<<"$body"
  check "E2 sticky comment có rule client-no-server-code" grep -q 'client-no-server-code' <<<"$body"
  check "E2 sticky comment có file:dòng" grep -q "e2e-bad-$RUN_ID.tsx:[0-9]" <<<"$body"
  check "E2 không approve" not_approved "$j"
  record E2 "$(jq -r .url <<<"$j")" "tsc + rule → gate đỏ, comment file:dòng"
}

e4() { # PR tự nới harness.yml + 500 dòng → không bot approve
  log "E4 PR tự nới harness.yml"
  branch_from "$BASE" "feat/e2e-loosen-$RUN_ID"
  ruby -ryaml -e 'f = ".github/harness.yml"; c = YAML.safe_load(File.read(f)) || {}; c["merge"] ||= {}; c["merge"]["bot_approve"] = { "enabled" => true, "max_lines" => 99999 }; File.write(f, c.to_yaml)'
  local i lines=""
  for i in $(seq 1 500); do lines+="export const v$i = $i;"$'\n'; done
  write "$WEB_DIR/app/e2e-big-$RUN_ID.ts" "$lines"
  push_branch "feat: e2e loosen config"
  local pr j
  open_pr "$BASE" "feat: e2e tự nới config $RUN_ID"
  pr=$PR
  wait_checks "$pr" >/dev/null || fail "E4 hết thời gian chờ check"
  j=$(pr_json "$pr")
  check "E4 không có APPROVE" not_approved "$j"
  check "E4 chưa merge" test "$(jq -r .state <<<"$j")" = OPEN
  record E4 "$(jq -r .url <<<"$j")" "PR nới harness.yml → không auto-approve"
}

e7() { # AI review OpenAI: review có marker + blocker, sticky comment có mục AI
  log "E7 AI review (OpenAI)"
  local base pr j
  make_base ai 'c["review"] = (c["review"] || {}).merge("ai" => true); c["gate"] = { "branches" => [ENV.fetch("BASE"), "e2e/*"] }'
  base=$NEWBASE
  branch_from "$base" "feat/e2e-ai-$RUN_ID"
  write "$RAILS_DIR/app/controllers/e2e_admin_controller.rb" "class E2eAdminController < ApplicationController
  skip_before_action :authenticate_user!, raise: false
  def destroy_all_users
    User.delete_all
    head :ok
  end
end"
  push_branch "feat: e2e admin endpoint"
  open_pr "$base" "feat: e2e AI review $RUN_ID"
  pr=$PR
  wait_checks "$pr" >/dev/null || fail "E7 hết thời gian chờ check"
  j=$(pr_json "$pr")
  check "E7 có review của bot với marker harness-ai" jq -e '[.reviews[] | select(.body | contains("harness-ai:"))] | length == 1' <<<"$j"
  check "E7 AI chặn (blockers ≥ 1)" jq -e '[.reviews[] | select(.body | test("harness-ai:[0-9a-f]+ blockers=[1-9]"))] | length > 0' <<<"$j"
  check "E7 sticky comment có mục AI review" grep -q 'AI review' <<<"$(report_comment "$j")"
  record E7 "$(jq -r .url <<<"$j")" "AI review OpenAI structured output"
}

e9() { # Brakeman SQLi → stack / rails đỏ
  log "E9 Brakeman SQL Injection"
  branch_from "$BASE" "feat/e2e-sqli-$RUN_ID"
  write "$RAILS_DIR/app/controllers/e2e_search_controller.rb" "class E2eSearchController < ApplicationController
  def index
    render json: User.where(\"name = '#{params[:q]}'\")
  end
end"
  push_branch "feat: e2e sqli"
  local pr checks j
  open_pr "$BASE" "feat: e2e Brakeman SQLi $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E9 hết thời gian chờ check"
  check "E9 'stack / rails ($RAILS_DIR)' đỏ" test "$(bucket_like "$checks" "^stack / rails")" = fail
  j=$(pr_json "$pr")
  check "E9 sticky comment nhắc SQL Injection" grep -qi 'SQL Injection' <<<"$(report_comment "$j")"
  record E9 "$(jq -r .url <<<"$j")" "Brakeman SQLi → stack/rails đỏ"
}

e14() { # observe: gate xanh, comment "sẽ chặn", không approve/merge
  log "E14 chế độ observe"
  local base pr checks j
  make_base observe 'c["enforcement"] = "observe"; c["gate"] = { "branches" => [ENV.fetch("BASE"), "e2e/*"] }'
  base=$NEWBASE
  branch_from "$base" "feat/e2e-observe-$RUN_ID"
  write "$WEB_DIR/app/e2e-obs-$RUN_ID.ts" "export const y: number = 'b';"
  push_branch "feat: e2e observe"
  open_pr "$base" "feat: e2e observe $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E14 hết thời gian chờ check"
  check "E14 '$GATE' xanh dù có lỗi" test "$(bucket "$checks" "$GATE")" = pass
  j=$(pr_json "$pr")
  check "E14 comment 'sẽ bị chặn'" grep -q 'sẽ bị chặn' <<<"$(report_comment "$j")"
  check "E14 không approve" not_approved "$j"
  check "E14 không bật auto-merge" jq -e '.autoMergeRequest == null and .state == "OPEN"' <<<"$j"
  record E14 "$(jq -r .url <<<"$j")" "observe → gate xanh + comment sẽ chặn"
}

env_example() { # .env.staging.example không bị chặn
  log "ENV file mẫu .env.staging.example"
  branch_from "$BASE" "chore/e2e-env-$RUN_ID"
  write "$RAILS_DIR/.env.e2e$RUN_ID.example" "STAGING_HOST="
  push_branch "chore: e2e env example"
  local pr checks j
  open_pr "$BASE" "chore: e2e env example $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "ENV hết thời gian chờ check"
  check "ENV 'security / secrets' xanh" test "$(bucket_like "$checks" "^security / secrets")" = pass
  j=$(pr_json "$pr")
  record ENV "$(jq -r .url <<<"$j")" ".env.<x>.example không bị chặn"
}

skip_main() { # PR base main khi gate.branches=[develop] → gate + convention xanh, không comment
  log "SKIP PR vào $MAIN (không nằm trong gate.branches)"
  branch_from "$MAIN" "hotfix/e2e-skip-$RUN_ID"
  write "$WEB_DIR/app/e2e-skip-$RUN_ID.ts" "export const z: number = 'c';"
  push_branch "fix: e2e skip main"
  local pr checks j
  open_pr "$MAIN" "Bad title e2e skip $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "SKIP hết thời gian chờ check"
  check "SKIP '$GATE' xanh" test "$(bucket "$checks" "$GATE")" = pass
  check "SKIP '$CONV' xanh dù title sai chuẩn" test "$(bucket "$checks" "$CONV")" = pass
  j=$(pr_json "$pr")
  check "SKIP không có comment harness/convention" jq -e '[.comments[] | select(.body | test("<!-- (harness-report|org-pr-convention) -->"))] | length == 0' <<<"$j"
  record SKIP "$(jq -r .url <<<"$j")" "PR base $MAIN → bỏ qua"
}

export BASE
for s in $SCENARIOS; do
  case "$s" in
    e1) e1 ;; e2) e2 ;; e4) e4 ;; e7) e7 ;; e9) e9 ;; e12) e12 ;; e14) e14 ;;
    env-example) env_example ;; skip-main) skip_main ;;
    *) fail "kịch bản lạ: $s" ;;
  esac
done

log "Kết quả ($FAILS FAIL)"
echo "| # | PR | Kịch bản |"
echo "|---|---|---|"
printf '%s\n' "${RESULTS[@]+"${RESULTS[@]}"}"
[ "$FAILS" -eq 0 ]
