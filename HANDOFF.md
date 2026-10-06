# HANDOFF — đưa harness lên org thật

Người nhận: Claude Code, chạy trên máy có `gh` đã đăng nhập vào org. Đọc `CLAUDE.md` trước.

## Trạng thái hiện tại (2026-10-03)

**Xong và đã kiểm chứng offline:**
- Toàn bộ workflow, script, profile và starter (xem `README.md`).
- 97 unit test pass; actionlint và shellcheck sạch. Ba vòng review độc lập, mọi lỗi tìm được đã sửa và có test.
- Repo **có sẵn** được hỗ trợ:
  - chế độ `enforcement: observe`
  - mọi check chỉ chặn nợ mới (lint theo dòng, tsc/Brakeman/Trivy so với base, Prettier phân biệt file vốn chưa format)
  - `debt.mjs` đo nợ trước khi onboard
  - playbook `docs/onboarding-existing-repo.md`
- Integration test chạy tool thật (3 kịch bản: Next.js, Rails, monorepo workspace): ESLint 9 + eslint-config-next 16, tsc 5.9, Prettier 3, dependency-cruiser 18.5, RuboCop 1.91 (rails-omakase), Brakeman 8.1.
- Trivy 0.75, Hadolint 2.15.1, Semgrep 1.179 và Supabase CLI 2.119 (`db advisors` bắt bảng thiếu RLS) đã chạy tay qua shim.
- Hai vòng review độc lập; các lỗ hổng tìm được đã sửa và có test. Danh sách bất biến ở `CLAUDE.md`.

**Chưa từng chạy trên GitHub thật.** Mọi lời gọi GitHub/Anthropic API mới chỉ test bằng mock. Đây là rủi ro lớn nhất, nên Phase 2 là bắt buộc trước khi rollout.

## Quy tắc làm việc

- Dừng lại hỏi người dùng ở mọi bước có đánh dấu **⛔ STOP**: thay đổi phạm vi cả org, tạo GitHub App, bật ruleset, mở PR hàng loạt. Những việc này khó hoàn tác hoặc ảnh hưởng người khác.
- Mỗi lỗi phát hiện khi chạy thật: sửa code, thêm test tái hiện (mock theo response thật quan sát được), chạy lại toàn bộ test + actionlint, rồi dời tag `v1`.
- Ghi tiến độ vào cuối file này (mục "Nhật ký") để phiên sau đọc tiếp được.

---

## Phase 0 — Hỏi người dùng (⛔ STOP: chưa có thì không làm tiếp)

| Cần biết | Vì sao |
|---|---|
| Tên org GitHub | `./scripts/init.sh <org>` |
| Plan: Free / Team / Enterprise Cloud | Quyết định cách ép buộc (`README.md` → "Plan GitHub") |
| Org có repo public không | Repo `.github` phải public, report audit phải vào repo private |
| Repo nào làm thử (pilot) | Nên chọn 1 repo Next.js + 1 repo Rails ít người dùng |
| Repo 1 người hay có team review | `SOLO=true` khi apply ruleset |
| Có bật AI review không, đã có `ANTHROPIC_API_KEY` chưa | `review.ai` |
| Ai/team là platform owner | `PLATFORM_OWNERS`, CODEOWNERS |

## Phase 1 — Khởi tạo repo `.github`

1. `git init -b main` trong thư mục này, rồi chạy `./scripts/init.sh <org>`.
2. `node --test 'tests/*.test.mjs'` và actionlint đều phải sạch.
3. ⛔ STOP: xác nhận với người dùng rồi mới `gh repo create <org>/.github --public`. Nếu repo đã tồn tại (thường có `profile/README.md`), merge vào chứ không ghi đè.
4. Commit, push `main`, tag `v1`.
5. Kiểm tra `self-test` trên GitHub xanh, gồm cả job `integration`.

**Nghiệm thu:** `gh run list -R <org>/.github` có self-test thành công. `git ls-remote --tags` có `v1`.

## Phase 2 — Kiểm chứng trên repo sandbox (bắt buộc)

Tạo repo private `<org>/harness-sandbox`, có thể dùng chính fixture trong `tests/integration.test.mjs`:
- `web/`: Next.js
- `api/`: Rails tối thiểu
- `supabase/`: 1 migration

Thêm `org-harness.yml` + `org-pr-convention.yml` (từ `workflow-templates/`, thay `$default-branch`), bật **Allow auto-merge**, bật ruleset **chỉ cho repo sandbox** (sửa `conditions.repository_name.include` thành `["harness-sandbox"]`).

Tốt nhất là viết `scripts/e2e-sandbox.sh` dùng `gh` để tự động hoá các kịch bản dưới. Mỗi kịch bản: tạo branch, push, `gh pr create`, chờ check, rồi assert bằng `gh pr checks`, `gh pr view --json reviews,comments,autoMergeRequest`.

| # | Kịch bản | Kỳ vọng | Điểm chưa chắc cần xác nhận |
|---|---|---|---|
| E1 | PR sạch, 20 dòng ở `web/app/` | Check tên đúng `harness / gate` + `org / pr-convention`; bot APPROVE; auto-merge bật; PR tự merge | Tên check của reusable (`<caller job> / <job name>`); dynamic `name:` của job `gate`; `enablePullRequestAutoMerge` bằng GITHUB_TOKEN |
| E2 | Thêm `const x: number = 'a'` + `'use client'` đọc `process.env.SECRET` | Gate đỏ; sticky comment liệt kê `tsc TS2322` và `react/client-no-server-code` kèm `file:dòng` | Gate đọc được annotation của job lồng trong reusable (`check-runs/{job.id}/annotations`; job id có = check run id không) |
| E3 | Sửa `supabase/migrations/<cũ>.sql` | `infra / supabase` đỏ, không approve | `supabase db start` + `db advisors --local` trên runner |
| E4 | PR sửa `.github/harness.yml` để `max_lines: 99999` kèm 500 dòng code | Không bot approve (config đọc từ base + `.github/**` cần người) | `fetch-depth: 0` đủ để `git show <base>:...` |
| E5 | "Run workflow" `org-harness` trên branch của PR đỏ | Run mới tên `harness / gate (workflow_dispatch)`; check `harness / gate` của PR vẫn đỏ | Dynamic name trong reusable |
| E6 | Re-run run cũ sau khi đã push commit mới | Gate chỉ ghi summary "commit cũ", không comment/approve | — |
| E7 | Bật `review.ai: true` (merge vào base trước), PR có lỗi phân quyền rõ ràng | Review COMMENT inline có marker `harness-ai:<sha> blockers=N`; gate đỏ; re-run không gọi lại API | Structured output (`output_config.format`) với model `claude-sonnet-5-5`; inline comment `line`/`side` |
| E8 | Tác giả tự gắn `harness:override-ai`, rồi một maintainer khác gắn | Lần 1 không có hiệu lực; lần 2 gate xanh nhưng không bot approve | `issues/{n}/events` + `collaborators/{u}/permission` với GITHUB_TOKEN (`issues: read`) |
| E9 | Rails: `User.where("name = '#{params[:q]}'")` trong controller | `stack / rails (api)` đỏ vì `brakeman SQL Injection` | `ruby/setup-ruby` `bundler-cache` trong thư mục con; `Gem.bindir` |
| E10 | pnpm workspace (chuyển `web/` sang pnpm) | Cài được, ESLint/tsc chạy | corepack trên Node 24 runner; `resolveBin` tìm binary hoist |
| E11 | Không có GitHub App, chưa bật "Allow GitHub Actions to create and approve PRs" | Comment ghi chú hướng dẫn bật, không crash | Thông điệp lỗi 422 thật |
| E12 | Có `HARNESS_APP_*` | Approve/merge do App thực hiện; push lên `main` sau merge **có** chạy workflow | `app-slug` → `HARNESS_BOT_LOGIN` |
| E13 | Vercel preview (nếu sandbox nối Vercel) | `org-vercel-preview` chạy sau `deployment_status`, kiểm header | `environment_url`, bypass header |
| E14 | Base có `enforcement: observe`; PR có lỗi tsc | Check `harness / gate` **xanh**, comment "👀 … nếu bật enforce, PR này sẽ bị chặn"; không approve/merge | — |
| E15 | Base có lockfile dính CVE + Dockerfile chạy root; PR chỉ sửa README | Mọi check xanh (nợ cũ chỉ ở summary). PR thêm package có CVE mới → `security / dependencies` đỏ, chỉ liệt kê CVE mới | `git worktree add` + Trivy quét base trên runner |
| E16 | Sửa 1 dòng trong file cũ có sẵn 20 lỗi ESLint và chưa format | Chỉ lỗi mới bị chặn; Prettier báo cảnh báo "file vốn chưa format" | baseline ESLint/Prettier trong worktree (symlink node_modules) |
| E17 | Monorepo pnpm: PR sửa `packages/shared` làm vỡ type ở `apps/web` (không đổi) | `stack / react (apps/web)` đỏ với lỗi tsc "mới do PR gây ra" | base tự `pnpm install` trong worktree (`baseNeedsOwnDeps`) |

Với mỗi điểm "chưa chắc" bị sai: sửa, thêm test mock theo response thật, rồi ghi vào Nhật ký.

**Nghiệm thu Phase 2:** E1–E12 và E14–E17 đạt (E13 nếu có Vercel). Ghi link PR của từng kịch bản vào Nhật ký.

## Phase 3 — GitHub App và secrets (⛔ STOP: người dùng phải tự làm trên web)

Claude Code không tạo GitHub App thay người dùng được. Hãy hướng dẫn từng bước và chờ xác nhận:

1. **App "harness bot"**: Contents R/W, Pull requests R/W. Cài cho *All repositories*. Sau đó lưu:
   ```bash
   gh variable set HARNESS_APP_CLIENT_ID --org <org> --body <client-id>
   gh secret set HARNESS_APP_PRIVATE_KEY --org <org> < key.pem
   ```
2. **App "org audit"**: có thể là cùng App nếu thêm Administration R, Deployments R, Workflows R/W, Issues R/W. Lưu `ORG_AUDIT_APP_CLIENT_ID` (variable) và `ORG_AUDIT_APP_PRIVATE_KEY` (secret) ở repo `.github`.
3. Đặt `AUDIT_REPORT_REPO` = một repo private, và `PLATFORM_OWNERS`.
4. Nếu bật AI: `gh secret set ANTHROPIC_API_KEY --org <org>`.
5. Không dùng App thì bật Org settings → Actions → "Allow GitHub Actions to create and approve pull requests".

## Phase 4 — Rollout

1. Chạy `gh workflow run org-audit -R <org>/.github` (dry-run), rồi đọc issue report trong `AUDIT_REPORT_REPO`. Tóm tắt cho người dùng: repo nào thiếu gì, có file `.env` bị commit không (critical).
2. ⛔ STOP: chạy `fix=true` với `only=<pilot repos>` trước, sau đó mới tới toàn org. Lệnh: `gh workflow run org-audit -R <org>/.github -f fix=true -f only=a,b`.
3. Mỗi PR `ci: adopt org harness (v1)` có kèm `harness.yml` với `enforcement: observe`. Sau khi merge, repo ở chế độ quan sát.
   - Repo **mới hoặc ít code**: copy file starter còn thiếu (ESLint/RuboCop), quan sát vài ngày rồi đổi sang `enforce`.
   - Repo **có sẵn nhiều code**: làm theo **Phase 4b**.
4. Nhắc bật **Allow auto-merge** ở từng repo, hoặc `gh api -X PATCH repos/<org>/<repo> -f allow_auto_merge=true` sau khi người dùng đồng ý.
5. ⛔ STOP: `./scripts/apply-ruleset.sh <org> team active` (hoặc `enterprise evaluate`) **chỉ sau khi** mọi repo đã merge caller. Nếu bật sớm, PR của các repo còn lại sẽ kẹt ở "Expected — Waiting for status".
6. Gợi ý cho người dùng: 2 tuần đầu đặt `merge.bot_approve.enabled: false` ở `profiles/base.yml` để quan sát false positive, sau đó mới bật.

## Phase 4b — Onboard repo có sẵn (mỗi repo một lượt, theo `docs/onboarding-existing-repo.md`)

Làm trên từng repo cũ, mỗi lần một repo, cwd là repo đó và clone `<org>/.github` ở thư mục bên cạnh.
1. `node ../.github/scripts/harness/debt.mjs`: báo cáo nợ. Chạy thêm `stack.mjs` toàn repo để biết quy mô nợ lint.
2. ⛔ STOP nếu có file `.env*`/`.vercel/` bị commit hoặc secret trong lịch sử: liệt kê cho người dùng, chờ họ rotate. Không tự viết lại lịch sử git.
3. Đọc code và viết `ARCHITECTURE.md` mô tả kiến trúc **thực tế**. Viết `harness.yml` từ khung của `debt.mjs`: khai báo profile rõ ràng, **chưa tắt hay hạ mức rule nào**. Rule nào `debt.mjs` đánh dấu "xem lại" thì đánh giá sau giai đoạn quan sát, dựa trên báo nhầm thật.
4. ⛔ STOP: cho người dùng xem báo cáo nợ, ARCHITECTURE.md, harness.yml trước khi mở PR.
5. Quan sát 1–2 tuần, gom các trường hợp báo nhầm và sửa rule. ⛔ Người dùng quyết định ngày đổi `enforce`.

**Nghiệm thu mỗi repo:** có `ARCHITECTURE.md` được người dùng duyệt, `harness.yml` đã chỉnh, tỉ lệ PR "sẽ bị chặn oan" trong giai đoạn quan sát dưới ~10%.

## Phase 5 — Backlog (làm khi được yêu cầu)

| Việc | Ghi chú |
|---|---|
| Profile `go`, `python` | Theo mục "Thêm một stack mới" trong `CLAUDE.md` |
| Chạy test suite của repo (rspec/vitest) | Mỗi repo cần DB/service khác nhau. Hướng đi: `harness.yml` khai báo `test.command` + `services`, hoặc để CI riêng của repo làm required check thứ ba |
| Dependabot/Renovate tự merge | Hiện lockfile và manifest luôn cần người duyệt. Nếu muốn bot dependency tự merge bản patch, cần policy riêng: `authors` + chỉ semver patch + không đổi `resolved` sang registry khác |
| Annotation bị giới hạn 10 lỗi/step | Gate có thể thiếu chi tiết. Hướng đi: mỗi job ghi `findings.json` lên artifact, gate tải về |
| Cache dependency (pnpm store, bundler) cho job `js`/`rails` | Hiện mỗi PR cài lại từ đầu |
| Baseline tsc cho Yarn PnP | Hiện bỏ qua (coi lỗi ngoài file đổi là có sẵn) |
| `trivy image` sau khi build Docker | Chưa build image trong harness |
| Deploy Supabase (`db push`) sau khi gate xanh trên `main` | Cần `SUPABASE_ACCESS_TOKEN`, environment có approval |
| Chi phí AI | Mỗi head SHA 1 lần gọi, diff tối đa 120k ký tự. Cân nhắc chỉ bật cho PR có label, hoặc dùng model nhỏ hơn cho PR < 50 dòng |

## Rủi ro đã biết

- Rule kiến trúc là regex nên vẫn có thể báo nhầm. Có thể dùng `harness-disable-line <id>`, nhưng PR đó sẽ cần người duyệt. Theo dõi false positive trong 2 tuần đầu và chỉnh `profiles/*.yml`.
- `@ts-expect-error` nằm trong `suppression_markers`, nên PR dùng nó luôn cần người duyệt. Nếu quá ồn thì bàn lại với người dùng.
- dependency-cruiser chạy kèm `typescript@5` (TS 7 bản Go chưa có JS API ổn định cho depcruise).
- Với plan Team, caller nằm trong repo con nên vẫn sửa được trong PR. Hàng rào là CODEOWNERS + `require_code_owner_review` + org-audit. Chỉ Enterprise mới khoá hẳn.

---

## Nhật ký

<!-- Claude Code ghi vào đây: ngày · phase · việc đã làm · link PR/run · lỗi phát hiện và cách sửa -->
- 2026-10-06 · Phase 0 (HARNESS_PLAN.md) · `gh` đăng nhập (admin:org, repo, workflow). Org plan Team. App `blended-asia-harness` cài All repositories, quyền: administration R, contents RW, deployments R, issues RW, metadata R, pull_requests RW, workflows RW, không webhook; key kiểm chứng bằng JWT → `GET /app` OK. Đã đặt org variable `HARNESS_APP_CLIENT_ID` + org secret `HARNESS_APP_PRIVATE_KEY` (visibility all). Còn: `ORG_AUDIT_APP_*` ở repo `.github` (dùng cùng App), `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` khi bật AI review, team `@Blended-Asia/platform`.
- 2026-10-06 · Phase 1 (HARNESS_PLAN.md) · `git init -b main` + 10 commit local (chưa push). Đủ 8 thay đổi: OpenAI provider (`review.provider`, `DEFAULT_MODELS`), regex env mẫu `.env.<x>.example` (3 chỗ), path nhạy cảm `**/db/migrate/**`…, `gate.branches` (verdict + pr-convention, đọc từ base), 4 ruleset nhóm + `apply-ruleset.sh` (REPOS/BRANCHES/DRY_RUN), org-audit theo nhánh làm việc (adoption PR vào develop, starter có `gate.branches`), Ruby version (root `.ruby-version`/`.tool-versions`/Gemfile), `scripts/e2e-sandbox.sh`. Thêm: sửa `git grep -E '\b'` (BSD/macOS bỏ sót) trong check biến public; test org-audit flaky (log làm hỏng IPC của node:test). Kết quả: 111 pass / 0 fail (3 skip integration), actionlint + shellcheck sạch. Integration test trên Mac: react + rails fail **giống hệt bản gốc** (Ruby hệ thống 2.6, depcruise) → không do thay đổi; chờ job `integration` của self-test trên runner (Phase 2). Còn mở: model OpenAI mặc định (`DEFAULT_MODELS.openai = 'gpt-5'`, chưa xác minh với tài khoản OpenAI của org).
