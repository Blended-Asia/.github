#!/usr/bin/env bash
# Verify the harness on a real sandbox repo (Phase 3). Each scenario: create branch → push → open PR → wait for checks → assert.
#   ./scripts/e2e-sandbox.sh <owner/repo> [scenario...]        # default: run all
#   ./scripts/e2e-sandbox.sh Blended-Asia/harness-sandbox e1 e12 skip-main
#
# Sandbox requirements (see HARNESS_PLAN.md Phase 3):
#   - branches develop + main, both with .github/harness.yml containing `gate.branches: [develop, "e2e/*"]`
#   - callers org-harness.yml / org-pr-convention.yml, a gitflow ruleset scoped to the sandbox only, Allow auto-merge on
#   - Rails app in $RAILS_DIR (default jfoodhub), Next.js in $WEB_DIR (default web)
#   - E7 needs the AI provider secret (OPENAI_API_KEY by default); E12 needs the GitHub App (HARNESS_APP_*) + a workflow that runs on push to develop
# Environment variables:
#   REMOTE   git remote (default git@github-work:<owner/repo>.git)
#   BASE     working branch (default develop) · MAIN release branch (default main)
#   TIMEOUT  seconds to wait for checks per PR (default 1800) · CLEANUP=false keeps PRs/branches for inspection
# Output: a PASS/FAIL line per assertion + a table of PR links to paste into the HANDOFF.md log. Exits 1 on any FAIL.
set -euo pipefail

REPO=${1:?Missing <owner/repo>}
shift
SCENARIOS=${*:-e1 e2 e4 e7 e9 e12 e14 skip-main draft}  # env-example: run manually (needs a sample env file committed)
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
check() { # check "<description>" <command...>
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
branch_from() { # branch_from <base> <name> → check out a new branch from origin/<base>
  git fetch -q origin "$1"
  git checkout -q -B "$2" "origin/$1"
}
write() { # write <path> <content>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
push_branch() {
  git add -A
  git commit -q -m "$1"
  git push -q -u origin HEAD
  BRANCHES+=("$(git branch --show-current)")
}
# Separate base for scenarios that need different config (config is read from the base): e2e/base-<x> from develop + edited harness.yml, pushed directly.
# Call directly (not via $(...)) so BRANCHES/OPENED are recorded for cleanup; results come back via NEWBASE / PR.
make_base() { # make_base <name> <ruby code editing hash c> → NEWBASE
  NEWBASE="e2e/base-$1-$RUN_ID"
  branch_from "$BASE" "$NEWBASE"
  ruby -ryaml -e 'f = ".github/harness.yml"; c = (File.exist?(f) && YAML.safe_load(File.read(f))) || {}; '"$2"'; File.write(f, c.to_yaml)'
  push_branch "chore: e2e base $1"
}
open_pr() { # open_pr <base> <title> → PR
  local url
  url=$(gh pr create -R "$REPO" --base "$1" --head "$(git branch --show-current)" --title "$2" \
    --body $'## Summary\nAutomated harness e2e scenario.\n\n## How to test\nRun scripts/e2e-sandbox.sh.')
  PR=${url##*/}
  OPENED+=("$PR")
}
wait_checks() { # wait until the harness / gate check exists and no check is pending
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
# no human reviewers in e2e → every APPROVE comes from the harness bot
approved() { jq -e '[.reviews[] | select(.state == "APPROVED")] | length > 0' <<<"$1" >/dev/null; }
not_approved() { ! approved "$1"; }
record() { RESULTS+=("| $1 | $2 | $3 |"); }

wait_merged() { # wait for auto-merge to finish
  local pr=$1 start
  start=$(date +%s)
  while [ "$(gh pr view "$pr" -R "$REPO" --json state --jq .state)" != "MERGED" ]; do
    [ $(($(date +%s) - start)) -gt "$TIMEOUT" ] && return 1
    sleep 15
  done
}

# ---------- Scenarios ----------
e1() { # clean PR → correct check names, bot approve, auto-merge, merged
  log "E1 clean PR into $BASE"
  branch_from "$BASE" "feat/e2e-clean-$RUN_ID"
  write "$WEB_DIR/app/e2e-$RUN_ID.ts" "export const e2e$RUN_ID = (a: number, b: number): number => a + b;"
  push_branch "feat: e2e clean"
  local pr checks j
  open_pr "$BASE" "feat: e2e clean PR $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E1 timed out waiting for checks"
  check "E1 check '$GATE' is green" test "$(bucket "$checks" "$GATE")" = pass
  check "E1 check '$CONV' is green" test "$(bucket "$checks" "$CONV")" = pass
  sleep 10
  j=$(pr_json "$pr")
  check "E1 bot APPROVED" approved "$j"
  check "E1 auto-merge enabled or already merged" jq -e '.autoMergeRequest != null or .state == "MERGED"' <<<"$j"
  check "E1 PR merged automatically" wait_merged "$pr"
  E1_PR=$pr
  record E1 "$(jq -r .url <<<"$j")" "clean PR → approve + auto-merge"
}

e12() { # merge by the App → workflows on push to develop DO run
  log "E12 App merge triggers push workflows on $BASE"
  [ -n "${E1_PR:-}" ] || e1
  local j sha runs
  j=$(pr_json "$E1_PR")
  sha=$(jq -r '.mergeCommit.oid // ""' <<<"$j")
  check "E12 has a merge commit" test -n "$sha"
  check "E12 approver is the App (not github-actions)" jq -e '[.reviews[] | select(.state == "APPROVED")] | any(.author.login != "github-actions" and .author.login != "github-actions[bot]")' <<<"$j"
  sleep 30
  runs=$(gh run list -R "$REPO" --branch "$BASE" --event push --commit "$sha" --json workflowName,status --limit 20)
  check "E12 workflows ran on push to $BASE after merge ($(jq -r 'map(.workflowName) | join(", ")' <<<"$runs"))" jq -e 'length > 0' <<<"$runs"
  record E12 "$(jq -r .url <<<"$j")" "App merge → push workflows on $BASE run"
}

e2() { # tsc error + client-no-server-code rule → gate red, sticky comment with file:line
  log "E2 tsc error + architecture rule"
  branch_from "$BASE" "feat/e2e-tsc-$RUN_ID"
  write "$WEB_DIR/app/e2e-bad-$RUN_ID.tsx" "'use client';
const x: number = 'a';
export const leak = process.env.SECRET ?? String(x);"
  push_branch "feat: e2e tsc error"
  local pr checks j body
  open_pr "$BASE" "feat: e2e tsc error $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E2 timed out waiting for checks"
  check "E2 '$GATE' is red" test "$(bucket "$checks" "$GATE")" = fail
  j=$(pr_json "$pr")
  body=$(report_comment "$j")
  check "E2 sticky comment mentions TS2322" grep -q 'TS2322' <<<"$body"
  check "E2 sticky comment mentions rule client-no-server-code" grep -q 'client-no-server-code' <<<"$body"
  check "E2 sticky comment has file:line" grep -q "e2e-bad-$RUN_ID.tsx:[0-9]" <<<"$body"
  check "E2 not approved" not_approved "$j"
  record E2 "$(jq -r .url <<<"$j")" "tsc + rule → gate red, comment with file:line"
}

e4() { # PR loosens its own harness.yml + 500 lines → no bot approval
  log "E4 PR loosens its own harness.yml"
  branch_from "$BASE" "feat/e2e-loosen-$RUN_ID"
  ruby -ryaml -e 'f = ".github/harness.yml"; c = YAML.safe_load(File.read(f)) || {}; c["merge"] ||= {}; c["merge"]["bot_approve"] = { "enabled" => true, "max_lines" => 99999 }; File.write(f, c.to_yaml)'
  local i lines=""
  for i in $(seq 1 500); do lines+="export const v$i = $i;"$'\n'; done
  write "$WEB_DIR/app/e2e-big-$RUN_ID.ts" "$lines"
  push_branch "feat: e2e loosen config"
  local pr j
  open_pr "$BASE" "feat: e2e loosen own config $RUN_ID"
  pr=$PR
  wait_checks "$pr" >/dev/null || fail "E4 timed out waiting for checks"
  j=$(pr_json "$pr")
  check "E4 has no APPROVE" not_approved "$j"
  check "E4 not merged" test "$(jq -r .state <<<"$j")" = OPEN
  record E4 "$(jq -r .url <<<"$j")" "PR loosening harness.yml → no auto-approve"
}

e7() { # AI review: review with marker + blocker, sticky comment has an AI section
  log "E7 AI review"
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
  wait_checks "$pr" >/dev/null || fail "E7 timed out waiting for checks"
  j=$(pr_json "$pr")
  check "E7 bot review with harness-ai marker" jq -e '[.reviews[] | select(.body | contains("harness-ai:"))] | length == 1' <<<"$j"
  check "E7 AI blocks (blockers ≥ 1)" jq -e '[.reviews[] | select(.body | test("harness-ai:[0-9a-f]+ blockers=[1-9]"))] | length > 0' <<<"$j"
  check "E7 sticky comment has an AI review section" grep -q 'AI review' <<<"$(report_comment "$j")"
  record E7 "$(jq -r .url <<<"$j")" "AI review structured output"
}

e9() { # Brakeman SQLi → stack / rails red
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
  checks=$(wait_checks "$pr") || fail "E9 timed out waiting for checks"
  check "E9 'stack / rails ($RAILS_DIR)' is red" test "$(bucket_like "$checks" "^stack / rails")" = fail
  j=$(pr_json "$pr")
  check "E9 sticky comment mentions SQL Injection" grep -qi 'SQL Injection' <<<"$(report_comment "$j")"
  record E9 "$(jq -r .url <<<"$j")" "Brakeman SQLi → stack/rails red"
}

e14() { # observe: gate green, comment "would be blocked", no approve/merge
  log "E14 observe mode"
  local base pr checks j
  make_base observe 'c["enforcement"] = "observe"; c["gate"] = { "branches" => [ENV.fetch("BASE"), "e2e/*"] }'
  base=$NEWBASE
  branch_from "$base" "feat/e2e-observe-$RUN_ID"
  write "$WEB_DIR/app/e2e-obs-$RUN_ID.ts" "export const y: number = 'b';"
  push_branch "feat: e2e observe"
  open_pr "$base" "feat: e2e observe $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "E14 timed out waiting for checks"
  check "E14 '$GATE' is green despite errors" test "$(bucket "$checks" "$GATE")" = pass
  j=$(pr_json "$pr")
  check "E14 comment says 'would be blocked'" grep -q 'would be blocked' <<<"$(report_comment "$j")"
  check "E14 not approved" not_approved "$j"
  check "E14 auto-merge not enabled" jq -e '.autoMergeRequest == null and .state == "OPEN"' <<<"$j"
  record E14 "$(jq -r .url <<<"$j")" "observe → gate green + would-be-blocked comment"
}

env_example() { # .env.staging.example is not blocked
  log "ENV sample file .env.<x>.example"
  branch_from "$BASE" "chore/e2e-env-$RUN_ID"
  write "$RAILS_DIR/.env.e2e$RUN_ID.example" "STAGING_HOST="
  push_branch "chore: e2e env example"
  local pr checks j
  open_pr "$BASE" "chore: e2e env example $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "ENV timed out waiting for checks"
  check "ENV 'security / secrets' is green" test "$(bucket_like "$checks" "^security / secrets")" = pass
  j=$(pr_json "$pr")
  record ENV "$(jq -r .url <<<"$j")" ".env.<x>.example is not blocked"
}

skip_main() { # PR into main with gate.branches=[develop] → gate + convention green, no comments
  log "SKIP PR into $MAIN (not in gate.branches)"
  branch_from "$MAIN" "hotfix/e2e-skip-$RUN_ID"
  write "$WEB_DIR/app/e2e-skip-$RUN_ID.ts" "export const z: number = 'c';"
  push_branch "fix: e2e skip main"
  local pr checks j
  open_pr "$MAIN" "Bad title e2e skip $RUN_ID"
  pr=$PR
  checks=$(wait_checks "$pr") || fail "SKIP timed out waiting for checks"
  check "SKIP '$GATE' is green" test "$(bucket "$checks" "$GATE")" = pass
  check "SKIP '$CONV' is green despite a non-conforming title" test "$(bucket "$checks" "$CONV")" = pass
  j=$(pr_json "$pr")
  check "SKIP no harness/convention comments" jq -e '[.comments[] | select(.body | test("<!-- (harness-report|org-pr-convention) -->"))] | length == 0' <<<"$j"
  record SKIP "$(jq -r .url <<<"$j")" "PR into $MAIN → skipped"
}

draft() { # draft PR → heavy jobs skipped, gate green, nothing posted; ready for review → full run, gate red
  log "DRAFT PR skips heavy checks until ready"
  branch_from "$BASE" "feat/e2e-draft-$RUN_ID"
  write "$WEB_DIR/app/e2e-draft-$RUN_ID.ts" "export const d: number = 'draft';"
  push_branch "feat: e2e draft"
  local url pr checks j
  url=$(gh pr create -R "$REPO" --draft --base "$BASE" --head "$(git branch --show-current)" --title "feat: e2e draft $RUN_ID" \
    --body $'## Summary\nAutomated harness e2e scenario.\n\n## How to test\nRun scripts/e2e-sandbox.sh.')
  pr=${url##*/}
  OPENED+=("$pr")
  checks=$(wait_checks "$pr") || fail "DRAFT timed out waiting for checks"
  check "DRAFT '$GATE' is green while draft" test "$(bucket "$checks" "$GATE")" = pass
  # A skipped matrix job is reported with its unexpanded name, e.g. "stack / ${{ matrix.name }} (${{ matrix.path }})"
  check "DRAFT JS job skipped" test "$(bucket_like "$checks" '^stack / (react|[$][{][{] matrix[.]name)')" = skipping
  j=$(pr_json "$pr")
  check "DRAFT no harness report comment" test -z "$(report_comment "$j")"
  gh pr ready "$pr" -R "$REPO" >/dev/null
  sleep 30
  checks=$(wait_checks "$pr") || fail "DRAFT timed out waiting for checks after ready"
  check "DRAFT '$GATE' is red once ready (tsc error)" test "$(bucket "$checks" "$GATE")" = fail
  record DRAFT "$url" "draft skips heavy checks; ready runs everything"
}

export BASE
for s in $SCENARIOS; do
  case "$s" in
    e1) e1 ;; e2) e2 ;; e4) e4 ;; e7) e7 ;; e9) e9 ;; e12) e12 ;; e14) e14 ;;
    env-example) env_example ;; skip-main) skip_main ;; draft) draft ;;
    *) fail "unknown scenario: $s" ;;
  esac
done

log "Results ($FAILS FAIL)"
echo "| # | PR | Scenario |"
echo "|---|---|---|"
printf '%s\n' "${RESULTS[@]+"${RESULTS[@]}"}"
[ "$FAILS" -eq 0 ]
