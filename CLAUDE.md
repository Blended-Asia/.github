# CLAUDE.md — repo `.github` của org (harness cho mọi PR)

Đọc file này trước, sau đó đọc `HANDOFF.md` để biết việc đang dở và thứ tự làm.

## Repo này là gì

Đây là repo `<org>/.github` (**phải để public**). Mọi repo trong org gọi workflow từ repo này, ghim theo tag `v1`. Repo con chỉ có:
- `.github/workflows/org-harness.yml`
- `.github/workflows/org-pr-convention.yml`
- `.github/harness.yml` (tuỳ chọn)

Harness gồm hai phần:
- **Sensor** (check): `security.yml`, `infra.yml`, `stack.yml` (theo profile rails/react/node + rule kiến trúc), `pr-convention.yml`.
- **Gate** (`harness.yml` → `scripts/harness/verdict.mjs`): gom kết quả mọi job trong run.
  - Chưa đạt: sticky comment + check `harness / gate` đỏ.
  - Đạt: bot approve nếu rủi ro thấp, rồi bật native auto-merge.
  - AI review (OpenAI hoặc Claude, theo `review.provider`) là tuỳ chọn và **chỉ được chặn**.

Ngôn ngữ: message, comment trên PR, README đều viết **tiếng Việt**. Code và tên biến viết tiếng Anh.

## Bản đồ

```
.github/workflows/
  pr-convention.yml security.yml infra.yml stack.yml harness.yml   # reusable (workflow_call)
  vercel-preview.yml codeql.yml                                    # reusable, opt-in
  org-audit.yml                                                    # chạy trong repo này: quét cả org
  required-convention.yml required-harness.yml                     # chỉ cho Enterprise ruleset "require workflows"
  self-test.yml                                                    # CI của repo này
workflow-templates/   caller mà repo con copy (Blended-Asia, $default-branch là placeholder)
profiles/             base.yml (policy chung) · rails.yml react.yml node.yml (tool + rule) · starter/ (file mẫu cho repo con)
scripts/harness/      lib (glob, git, YAML qua ruby, annotation) · config (resolve + detect) · rules (architecture)
                      · stack (chạy tool, so baseline) · verdict (gate) · debt (đo nợ repo cũ trước khi onboard)
docs/onboarding-existing-repo.md   quy trình đưa repo CÓ SẴN vào harness (observe → enforce)
scripts/org-audit.mjs quét org, drift caller, CODEOWNERS, ruleset; FIX=true mở PR
rulesets/             org-{trunk,gitflow}-{team,solo}.json (theo nhóm repo) · org-baseline.json (Team, ~ALL) · org-baseline-enterprise.json
tests/                node:test, chạy offline; integration.test.mjs chạy tool thật khi HARNESS_INTEGRATION=1
```

## Lệnh

```bash
node --test 'tests/*.test.mjs'                                  # 97 test, ~10s. Cần git, ruby, python3, docker compose (CLI, không cần daemon)
HARNESS_INTEGRATION=1 node --test tests/integration.test.mjs    # ~2 phút: npm install Next/ESLint/TS, bundle RuboCop, gem Brakeman
actionlint .github/workflows/*.yml workflow-templates/*.yml     # phải sạch, kể cả shellcheck
./scripts/init.sh <org>                                         # thay Blended-Asia trong toàn repo
./scripts/e2e-sandbox.sh <org>/harness-sandbox [e1 e2 …]       # kiểm chứng trên sandbox thật (gh + git), in bảng link PR
REPOS=a,b ./scripts/apply-ruleset.sh <org> trunk-team|trunk-solo|gitflow-team|gitflow-solo|team|enterprise [active|evaluate|disabled]   # DRY_RUN=true: chỉ in JSON
```

Trước khi commit: phải chạy cả test lẫn actionlint. Nếu sửa `stack.mjs`, `profiles/*` hoặc `eslint.config.mjs` của starter thì chạy thêm integration test.

## Quy ước code

- Script chỉ dùng **Node built-in**, không `npm install`. YAML đọc qua `ruby -ryaml` (`lib.loadYaml`) vì runner luôn có Ruby.
- Mọi action **ghim theo commit SHA** kèm comment version (`@<sha> # vX.Y.Z`). Tool cũng ghim version: Trivy, Hadolint, Semgrep, dependency-cruiser, Brakeman, Supabase CLI.
- **Không dùng `${{ }}` trong thân `run:` hay `script:`.** Truyền qua `env:` để tránh script injection. `tests/workflows.test.mjs` sẽ fail nếu vi phạm (và nếu action không ghim SHA).
- Logic dài nằm trong `scripts/`, không inline trong YAML. Ngoại lệ hiện có: `pr-convention.yml`, `vercel-preview.yml` dùng github-script inline, đánh dấu `// ---- x:begin/end ----` để test trích ra chạy.
- Finding chuẩn hoá thành `{severity: 'error'|'warn', file (path từ root repo), line, title, message}` rồi in bằng `lib.report()`. Gate đọc lại qua annotation API, nên đừng in lỗi kiểu khác.
- Test cho logic mới viết bằng `node:test`. GitHub/OpenAI/Anthropic API thì mock `fetch`, có sẵn router trong `tests/verdict.test.mjs` và `tests/org-audit.test.mjs`.

## Bất biến bảo mật — KHÔNG được phá (đều đã có test, đều từng là lỗ hổng thật)

1. **Config đọc từ commit BASE của PR.** Áp dụng cho `.github/harness.yml` (plan, architecture, gate) và `ARCHITECTURE.md` (prompt AI). PR không được tự nới luật chấm chính nó (`resolveConfig({configRef})`, `loadPolicy({configRef})`).
2. **AI chỉ được chặn, không được duyệt.** Approve chỉ do policy cố định quyết định: tổng số dòng ≤ `max_lines`, không đụng `human_required_paths`, không có `suppression_markers`, đúng `authors`, không phải draft hay fork.
3. `ALWAYS_HUMAN = ['.github/**', 'CODEOWNERS', '**/CODEOWNERS']` được hard-code. Sensitive check xét cả `previous_filename` (bắt trường hợp rename). Lockfile, `.npmrc` và config của các linter đều nằm trong human paths.
4. Gate **chỉ tin review/comment của chính nó** (`HARNESS_BOT_LOGIN` = `github-actions[bot]` hoặc `<app-slug>[bot]`). Không tin `user.type === 'Bot'` chung chung.
5. AI review **mỗi head SHA đúng 1 lần**. Kết quả ghi trong review body `<!-- harness-ai:<sha> blockers=N verdict=X -->` và được dùng lại khi re-run. Nếu AI từng chặn ở commit trước → không bot approve (chặn trò push commit rỗng để "quay số").
6. Label `harness:override-ai` chỉ có hiệu lực khi người gắn có quyền **maintain/admin và không phải tác giả PR**. Override không bỏ qua được lỗi tool, và PR đó vẫn cần người approve.
7. **Stale run** (`event.pull_request.head.sha` ≠ head hiện tại) → chỉ chấm điểm, không ghi gì lên PR. Convention check luôn `pulls.get` lại PR, không dùng payload cũ.
8. Required check `harness / gate` chỉ mang đúng tên này với `pull_request` và `merge_group`. Push, schedule, dispatch chạy thành `gate (<event>)`. Dynamic name nằm ở job **bên trong** reusable workflow; job caller giữ tên tĩnh `harness`.
9. Gate không chỉ tin input `results`: luôn hỏi lại `runs/{id}/jobs?filter=latest`.
10. Code harness checkout xong phải được chuyển ra `$RUNNER_TEMP/harness`, để ESLint/Prettier của repo con không quét nhầm.
11. **Chỉ chặn nợ mới, ở mọi check.** Mặc định `convention.granularity: line`.
    - ESLint, RuboCop: chạy lại trên bản base của các file đã sửa và so key `file|rule|message`. Không dựng được base thì lùi về lọc theo dòng thêm.
    - `tsc`, Brakeman: so key/fingerprint với base qua `git worktree`. Lỗi mới do PR gây ra ở file không đổi **vẫn chặn**.
    - Prettier: file vốn chưa format ở base thì chỉ cảnh báo.
    - Trivy CVE/misconfig: so với base bằng **multiset** (đếm), misconfig có cả `Resource` trong key. `--config` trỏ vào file rỗng để `trivy.yaml` của PR không tắt được scan.
    - Hadolint, compose: so với bản base của chính file.
    - vercel.json, tên migration: chỉ file đổi/mới.
    - tsc ở base: nếu PR đổi dependency hoặc package khác trong workspace thì base **phải tự cài deps** (không mượn node_modules của PR). Không dựng được base → **chặn**, không bỏ qua.
    - Rule có `security: true` không tắt và không hạ mức được từ `harness.yml`.
    - Advisor: `advisors_ignore`.
    - Ngoại lệ có chủ đích: file `.env*`/`.vercel/` đang bị commit luôn chặn.
12. `enforcement: observe` **không bao giờ** approve hay bật auto-merge, và gate luôn exit 0. Vì config đọc từ base, PR không tự chuyển được giữa observe và enforce.
13. org-audit: repo `.github` public → chế độ quiet (không in tên repo ra log), report gửi vào repo private `AUDIT_REPORT_REPO`. Caller bị sửa thì chỉ báo cáo, không tự ghi đè.

Thay đổi nào đụng tới các điểm trên thì phải có test chứng minh bất biến vẫn giữ, và ghi rõ trong mô tả PR.

## Thêm một stack mới (vd Go, Python)

1. Tạo `profiles/<name>.yml`: `checks` + `architecture.rules`.
2. Thêm `<name>` vào `PROFILES` và nhánh nhận diện trong `config.mjs/detectProfiles`.
3. Thêm `runGo(ctx)` (hoặc tương tự) vào `stack.mjs`: parser trả finding chuẩn, lọc theo `ctx.changed`, có baseline nếu tool báo lỗi xuyên file.
4. Thêm job trong `stack.yml` (setup toolchain + `stack.mjs <name>`), kèm output `plan` tương ứng.
5. Viết unit test cho parser và test detect. Thêm một case trong `integration.test.mjs`.

## Phát hành

Merge vào `main` → dời tag `v1` (`git tag -f v1 && git push -f origin v1`). Khi có breaking change:
1. Đổi default `harness_ref` trong `stack.yml` và `harness.yml` thành `v2`, rồi tag `v2`.
2. Đặt variable `HARNESS_REF=v2` và chạy org-audit `fix=true` để mở PR bump ref ở mọi repo.
