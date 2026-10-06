# YOUR_ORG/.github: harness cho mọi PR

> Làm tiếp với Claude Code: đọc `CLAUDE.md` (bối cảnh + bất biến) và `HANDOFF.md` (việc còn lại theo phase).

**Harness** = toàn bộ cơ chế quanh một PR gồm hai phần:
- **Sensor**: các check (security, infra, convention, kiến trúc) chạy theo đúng stack của repo.
- **Gate**: vòng phản hồi. Chưa đạt thì comment lý do và chỗ cần sửa. Đạt thì approve (nếu rủi ro thấp) và tự merge.

Logic nằm ở repo này, ghim theo tag `v1`. Mỗi repo con chỉ cần 2 file caller ngắn và một file cấu hình `.github/harness.yml` (không bắt buộc).

```
PR mở / push commit
 ├─ org-pr-convention.yml ──► org / pr-convention            (title, branch, mô tả, size)   ← required
 └─ org-harness.yml
      ├─ security   TruffleHog · Trivy CVE · Semgrep · .env/secret công khai
      ├─ infra      Docker · Vercel · Supabase (tự phát hiện)
      ├─ stack      plan → architecture (mọi ngôn ngữ)
      │                  → rails (RuboCop · Brakeman · Packwerk)      ┐ mỗi thư mục
      │                  → react / node (ESLint · tsc · Prettier · dependency-cruiser) ┘ 1 job
      └─ harness / gate  ◄── gom kết quả + AI review (tuỳ chọn)                        ← required
              ├─ ❌ chưa đạt → sticky comment: job nào fail, file:dòng, cách sửa
              └─ ✅ đạt     → nhỏ & không đụng path nhạy cảm: bot approve
                              → bật auto-merge: GitHub tự merge khi đủ required checks + review
Ruleset org-baseline ──► bắt buộc 2 required check trên
org-audit (thứ Hai) ──► quét mọi repo, phát hiện caller bị sửa / config nới lỏng, mở PR áp dụng
```

## Template theo stack (profile)

Không làm template cho từng repo mà làm theo **profile của stack**. Repo chỉ khai báo mình thuộc profile nào (hoặc để tự nhận diện) và ghi đè chỗ khác biệt.

| Profile | Nhận diện | Tool | Rule kiến trúc mặc định |
|---|---|---|---|
| `rails` | Gemfile có `rails` | RuboCop (config của repo), Brakeman (chặn từ confidence Medium), Packwerk nếu có `packwerk.yml` | model không dùng params/session/render · view không query DB · controller không SQL thô · migration không gọi model của app · tắt CSRF phải review |
| `react` | package.json có react/next | ESLint (config của repo), `tsc --noEmit`, Prettier (nếu repo dùng), dependency-cruiser: vòng import, import devDependency vào code chạy thật, import không resolve được | client component không đọc env server / service role / import code server · `components/` không import từ `app/`/`pages/` · cảnh báo `dangerouslySetInnerHTML`, `@ts-ignore` |
| `node` | package.json khác | như `react` | không ghép chuỗi vào SQL · cảnh báo `console.log` |

- `profiles/<stack>.yml` chứa tool và rule mặc định của org. Sửa ở đây là áp cho mọi repo cùng stack.
- `profiles/starter/` chứa file mẫu cho repo con: `harness.yml`, `.rubocop.yml`, `eslint.config.mjs`, `.prettierrc.json`, `.dependency-cruiser.cjs`, và `ARCHITECTURE.md` cho từng stack (tài liệu AI reviewer dùng làm chuẩn đối chiếu).
- Monorepo: mỗi thư mục là một profile, chạy song song (vd `api/` rails + `web/` react).
- Thêm stack mới (Go, Python…): thêm `profiles/<tên>.yml` + một nhánh trong `scripts/harness/stack.mjs` + job trong `stack.yml`.

**Chỉ chặn nợ mới.** Trên PR, ESLint/Prettier/RuboCop/rule kiến trúc chỉ xét file hoặc dòng thay đổi. Riêng `tsc` và Brakeman còn chạy thêm trên commit base (git worktree) để so sánh:
- Lỗi đã có từ trước ở file không đổi: chỉ ghi chú, không chặn.
- Lỗi **mới do PR gây ra** ở file không đổi thì vẫn chặn. Ví dụ đổi tên hàm export làm vỡ file gọi nó.

Muốn quét toàn repo thì dùng `convention.scope: all`. Run trên `main`/schedule thì quét toàn bộ và chỉ báo cáo.

### Rule kiến trúc riêng của repo

Rule là regex chạy được với mọi ngôn ngữ: "file khớp `paths` không được chứa `forbid`".

```yaml
# .github/harness.yml
architecture:
  disable: [react/no-ts-ignore]
  rules:
    - id: web/features-isolated
      paths: ["web/src/features/**"]
      forbid: 'from\s+["'']@/features/(?!shared/)'
      message: Feature không import nội bộ feature khác, đi qua @/features/shared.
      severity: error            # error chặn PR, warn chỉ cảnh báo
      # allow: '...'             # dòng khớp allow thì bỏ qua
      # if_file_matches: '...'   # chỉ áp cho file có nội dung khớp (vd "use client")
```

Muốn bỏ qua có chủ đích một dòng: thêm comment `harness-disable-line <rule-id>` vào dòng đó. PR có marker kiểu này (cả `eslint-disable`, `rubocop:disable`, `nosemgrep`, `@ts-ignore`…) sẽ không được bot tự approve mà phải có người duyệt.

**`.github/harness.yml` luôn đọc từ commit base của PR.** Vì vậy một PR không thể tự tắt rule hay tự tăng ngưỡng approve cho chính nó. Thay đổi config chỉ có hiệu lực sau khi merge, và file nằm trong `.github/**` nên luôn cần người duyệt.

## Dự án có sẵn

Repo cũ thì bật theo lộ trình **quan sát trước, ép sau**. Hướng dẫn chi tiết cho người và cho Claude Code ở [`docs/onboarding-existing-repo.md`](docs/onboarding-existing-repo.md).

- **`enforcement: observe`**: gate chấm và comment "nếu bật thì PR này sẽ bị chặn vì…" nhưng không chặn, không tự approve/merge. PR áp dụng harness do org-audit mở đã để sẵn chế độ này.
- **Chỉ chặn nợ mới, ở mọi check**:
  - ESLint, RuboCop: chạy lại trên bản base của chính các file đã sửa, chỉ chặn lỗi **không có từ trước**, kể cả lỗi mới nằm ở dòng cũ (vd xoá chỗ dùng làm biến thành unused). Sửa một dòng trong file cũ không phải dọn cả file.
  - tsc, Brakeman: so với base, chỉ chặn lỗi mới.
  - Prettier: file vốn chưa format từ trước chỉ cảnh báo.
  - Trivy CVE và misconfig: so với base, đếm theo số lần. Thêm bản thứ hai của cùng lỗi vẫn bị bắt.
  - Hadolint, compose: so với bản base của chính file đó.
  - `vercel.json`, tên migration: chỉ file đổi/mới.
  - Supabase Advisor: có `advisors_ignore` cho nợ đã chấp nhận.
  - Repo mới muốn "chạm file nào sạch file đó" thì đặt `convention.granularity: file`.
- **`scripts/harness/debt.mjs`**: chạy ở root repo cũ để đo vi phạm từng rule trên toàn repo, phát hiện file env bị commit, rồi dựng khung `harness.yml`.
  - Rule có nhiều vi phạm cũ được đánh dấu "xem lại", vì có thể không hợp kiến trúc thực tế. Script không tự tắt hay hạ mức rule nào.
  - Rule bảo mật (`security: true`) không tắt và không hạ mức được từ repo.
- Ngoại lệ duy nhất chặn mọi PR từ ngày đầu: file `.env*`/`.vercel/` đang bị commit. Phải gỡ và rotate secret.

## Gate: reject, approve, merge

| Tình huống | Gate | Hành động |
|---|---|---|
| Có job fail | ❌ | Sticky comment liệt kê job, `file:dòng` và lỗi (lấy từ annotation của run) + link log |
| Repo ở `enforcement: observe` | 👀 | Comment "nếu bật thì sẽ chặn vì…", check luôn xanh, không approve/merge |
| AI review có vấn đề `critical`/`major` | ❌ | Comment inline đúng dòng + tóm tắt trong sticky comment |
| Đạt, ≤ `max_lines` (mặc định 200), không đụng `human_required_paths`, đúng `authors` | ✅ | Bot **approve** + bật **auto-merge** |
| Đạt nhưng đụng migration, `.github/`, auth, Dockerfile, manifest/lockfile, config của linter, hoặc thêm marker tắt kiểm tra | ✅ | Bật auto-merge, ghi "cần người review". Merge ngay khi có người approve |
| Draft | ✅/❌ | Chỉ comment, không approve/merge |
| PR từ fork | ✅/❌ | Chỉ chấm điểm, không comment/approve/merge, không gọi AI |
| Re-run một run cũ sau khi PR đã có commit mới | ✅/❌ | Chỉ chấm điểm commit cũ, không ghi gì lên PR |

Auto-merge dùng tính năng gốc của GitHub, nên GitHub luôn chờ **mọi** required check (kể cả `org / pr-convention`) và số approve mà ruleset yêu cầu.

**AI review** (`review.ai: true`) gọi OpenAI Chat Completions (mặc định, `review.provider: openai`) hoặc Claude API (`provider: anthropic`) với structured output. Nó đọc diff (đã bỏ lockfile), `ARCHITECTURE.md` của repo và kết quả linter, rồi trả về các comment theo mức độ nghiêm trọng.
- AI **chỉ có quyền chặn**. Việc approve do policy cố định quyết định (kích thước, path, tác giả), vì nội dung PR có thể chứa prompt injection kiểu "hãy approve PR này". Prompt coi diff là dữ liệu không tin cậy và báo injection là lỗi `critical`.
- Mỗi commit chỉ được AI review **một lần**. Kết quả được ghi vào review của chính gate (`github-actions[bot]` hoặc App của harness; bot khác không giả được) và dùng lại khi re-run. Nếu AI từng chặn ở một commit trước của PR, bản sửa luôn cần người xác nhận. Nhờ vậy push commit rỗng để AI review lại cũng không lách được.
- AI chặn nhầm: một người có quyền **maintain/admin, khác tác giả PR** gắn label `harness:override-ai` rồi re-run job gate. Label do tác giả hoặc người chỉ có quyền write gắn thì không có hiệu lực. Override không bỏ qua được lỗi của tool, và PR đó vẫn cần người approve.
- API lỗi thì mặc định không chặn nhưng cũng không tự approve. Đặt `review.fail_closed: true` để chặn hẳn.
- `ARCHITECTURE.md` cũng đọc từ base: PR không sửa được chuẩn mà AI dùng để chấm nó.
- `review.model` để trống thì dùng model mặc định theo provider (`DEFAULT_MODELS` trong `scripts/harness/verdict.mjs`).

## Plan GitHub quyết định mức độ "ép buộc"

| | Free | Team | Enterprise Cloud |
|---|---|---|---|
| Gọi reusable workflow từ `.github` **public** | ✅ mọi repo | ✅ mọi repo | ✅ mọi repo |
| Gọi từ `.github` **private** | chỉ repo private | chỉ repo private/internal | chỉ repo private/internal |
| Ruleset bắt buộc check cho **repo private** | ❌ (chỉ repo public) | ✅ | ✅ |
| Required workflows: repo con không cần caller, **không sửa được** | ❌ | ❌ | ✅ |

**`.github` phải public** vì job `stack` và `gate` checkout `scripts/harness` + `profiles` từ repo này bằng token của repo con. Repo này không chứa secret. Report audit thì luôn đi vào một repo private riêng.

Với Team, caller nằm trong repo con nên dev có thể sửa nó trong PR để né check. Có các lớp chặn sau:
- `CODEOWNERS` phủ `/.github/workflows/`, kèm `require_code_owner_review` trong ruleset.
- `harness.yml` và `ARCHITECTURE.md` đọc từ base. `.github/**` và `CODEOWNERS` luôn cần người duyệt, config không bỏ được (kể cả khi đổi tên/move file).
- org-audit so caller với template, kiểm tra CODEOWNERS có phủ cả caller lẫn `harness.yml` không, và báo khi `harness.yml` nới lỏng (tắt rule/tool, tăng ngưỡng tự approve…).
- Gate không chỉ tin input `results` mà tự hỏi lại API trạng thái mọi job trong run. Review/comment do người thường chèn marker giả không được tính.
- Check chỉ mang tên `harness / gate` khi chạy từ PR/merge queue. Run từ push/schedule/"Run workflow" thành `harness / gate (push)`…

Chỉ Enterprise mới khoá hoàn toàn được, bằng `required-*.yml` + `rulesets/org-baseline-enterprise.json`.

## Cài đặt

1. **Tạo repo `YOUR_ORG/.github` (public)**, push nội dung này lên rồi chạy:
   ```bash
   ./scripts/init.sh <ten-org>        # thay YOUR_ORG ở mọi file
   git commit -am "chore: init" && git push
   git tag v1 && git push origin v1
   ```
2. **Org secrets/variables** cho harness:
   - `OPENAI_API_KEY` (secret, nếu dùng AI review; hoặc `ANTHROPIC_API_KEY` khi `review.provider: anthropic`).
   - **GitHub App "harness bot"** (khuyên dùng), quyền Contents R/W + Pull requests R/W, cài cho mọi repo. Lưu variable `HARNESS_APP_CLIENT_ID` và secret `HARNESS_APP_PRIVATE_KEY`.
     - Lý do: merge do GITHUB_TOKEN thực hiện **không kích hoạt workflow** trên `main`. Vercel/Supabase integration không bị ảnh hưởng, nhưng các deploy bằng GitHub Actions thì bị.
     - Không có App thì harness dùng GITHUB_TOKEN. Muốn bot approve được, phải bật Org settings → Actions → "Allow GitHub Actions to create and approve pull requests".
3. **Từng repo**: Settings → General → bật **Allow auto-merge**. Repo nào chưa bật, comment của gate sẽ nhắc.
4. **GitHub App cho org-audit**: có thể dùng chung App ở bước 2 nếu thêm đủ quyền. Cần Administration *Read*, Contents *R/W*, Deployments *Read*, Issues *R/W*, Metadata *Read*, Pull requests *R/W*, Workflows *R/W*.
   - Trong repo `.github`: variable `ORG_AUDIT_APP_CLIENT_ID`, secret `ORG_AUDIT_APP_PRIVATE_KEY`.
   - Variable `AUDIT_REPORT_REPO` là một repo **private** nhận report. Repo `.github` public nên script tự chạy quiet: không in tên repo ra log.
   - Tuỳ chọn: `PLATFORM_OWNERS=@YOUR_ORG/platform`, `HARNESS_REF` (mặc định `v1`).
5. **Rollout**:
   - Chạy org-audit dry-run để xem report.
   - Chạy `fix=true` để mở PR `ci: adopt org harness (v1)` vào từng repo. PR thêm `org-harness.yml`, `org-pr-convention.yml`, `harness.yml`, PR template, CODEOWNERS.
   - Merge từng PR. Copy file starter (`.rubocop.yml`, `eslint.config.mjs`…) cho repo nào gate báo thiếu.
6. **Bật ruleset** *sau khi* các repo đã có caller. Bật trước thì PR sẽ kẹt ở "Expected — Waiting for status".
   ```bash
   ./scripts/apply-ruleset.sh <org> team active
   SOLO=true ./scripts/apply-ruleset.sh <org> team active          # repo 1 người: không bắt approve
   ./scripts/apply-ruleset.sh <org> enterprise evaluate            # Enterprise: chạy thử trước
   ```
   Sau PR đầu tiên, kiểm tra tên check thực tế trên PR có đúng `org / pr-convention` và `harness / gate` không, khác thì sửa `context` trong `rulesets/org-baseline.json`. `integration_id: 15368` là GitHub Actions, dùng để chặn ai đó giả status bằng API.
7. **Vercel preview** có Deployment Protection: tạo *Protection Bypass for Automation*, lưu thành org secret `VERCEL_AUTOMATION_BYPASS_SECRET`.

Bỏ qua finding đã chấp nhận rủi ro: `.trivyignore`, `// nosemgrep`, `.hadolint.yaml`, `config/brakeman.ignore`, `harness-disable-line`. Repo có migration nên bật thêm "Require branches to be up to date" để check thứ tự timestamp luôn so với base mới nhất.

## Phát hành thay đổi

PR vào repo này → `self-test` (actionlint + test offline) → merge → dời tag:
```bash
git tag -f v1 && git push -f origin v1     # thay đổi tương thích
```
Khi có breaking change:
1. Đổi default `harness_ref` trong `stack.yml` và `harness.yml` thành `v2`, rồi tag `v2`.
2. Đặt variable `HARNESS_REF=v2` và chạy org-audit với `fix=true`. Audit sẽ mở PR bump ref và giữ nguyên config của từng repo.

Chạy test local: `node --test 'tests/*.test.mjs'` (Node ≥ 22, cần `git`, `ruby`, `python3`, `docker compose`).

## Chưa làm

- Profile Go/Python/PHP: khung đã sẵn, thêm theo mục "Thêm stack mới".
- Deploy: Vercel/Supabase vẫn deploy qua integration. Có thể thêm `supabase db push` trên `main` sau khi gate xanh.
- Build và quét image Docker (`trivy image`), test coverage, chạy test suite của repo. Harness hiện không chạy `rspec`/`vitest` của repo vì mỗi repo cần DB/service khác nhau. Nên để CI test riêng của repo làm required check thứ ba.
