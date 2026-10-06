# Onboard một repo CÓ SẴN vào harness

Repo cũ luôn mang theo nợ: CVE trong lockfile, Dockerfile chạy root, code vi phạm rule kiến trúc, có khi cả file `.env` bị commit. Nguyên tắc ở đây là **không bắt trả nợ cũ trước khi được làm việc tiếp, nhưng không cho phép đẻ thêm nợ mới**.

## Harness đã lo phần nào

| Check | Trên PR | Nợ cũ |
|---|---|---|
| ESLint, RuboCop | file đã sửa, so với bản base của chính file đó: chỉ chặn lỗi mới, kể cả lỗi mới ở dòng cũ | không chặn |
| Prettier | file đã sửa; file vốn chưa format từ trước thì chỉ cảnh báo | cảnh báo |
| Rule kiến trúc | chỉ dòng thêm/sửa | không chặn |
| `tsc`, Brakeman | file đổi + **lỗi mới do PR gây ra** ở file khác (so với base qua git worktree) | không chặn |
| Trivy CVE, Trivy misconfig | chỉ cái **mới** so với lockfile/config của base | ghi trong summary, không chặn |
| Hadolint, compose policy | file đổi, so với bản base của chính file đó: chỉ chặn lỗi mới | không chặn |
| `vercel.json` | chỉ file đổi | không chặn |
| Semgrep | baseline theo base | không chặn |
| Secret (TruffleHog), biến public lộ secret | chỉ phần diff | không chặn |
| Tên migration Supabase | chỉ migration mới thêm | không chặn |
| Supabase Security Advisor | toàn DB | **chặn**, trừ key nằm trong `advisors_ignore` |
| File `.env*` / `.vercel/` đang bị commit | toàn repo | **chặn mọi PR**, phải sửa và rotate secret |

Push lên `main` và lịch quét hằng tuần vẫn quét toàn bộ. Kết quả chỉ để báo cáo nợ, không chặn ai.

## Quy trình (Claude Code làm, người duyệt ở các điểm ⛔)

Chuẩn bị: clone repo cần onboard và repo `<org>/.github` cạnh nhau.
```
~/work/<repo>        # cwd
~/work/.github       # harness
```

### 1. Đo nợ
```bash
node ../.github/scripts/harness/debt.mjs > /tmp/debt.md
```
Báo cáo gồm:
- profile nhận diện được
- số vi phạm của từng rule kiến trúc trên **toàn repo** và các file vi phạm nhiều nhất
- file env bị commit, migration đặt tên lệch chuẩn
- config còn thiếu
- khung `harness.yml`

Cách đọc số vi phạm: trên PR, rule kiến trúc chỉ xét **dòng mới**, nên nợ cũ không bao giờ chặn PR.
- Rule có hàng chục vi phạm cũ là dấu hiệu rule có thể **không hợp kiến trúc thực tế**: code mới viết theo pattern sẵn có sẽ bị chặn. `debt.mjs` đánh dấu các rule này để "xem lại", nhưng **không tự đề xuất tắt hay hạ mức**.
- Chỉ hạ mức hoặc tắt khi thấy báo nhầm trên PR thật trong giai đoạn quan sát.
- Rule bảo mật (`security: true`) không tắt và không hạ mức được từ `harness.yml`. Gặp trường hợp ngoại lệ thì dùng `harness-disable-line` trên dòng đó; PR khi ấy sẽ cần người duyệt.

Chạy thêm từng stack ở chế độ quét toàn bộ để biết quy mô nợ của linter. Không có `BASE_SHA` thì kết quả chỉ báo cáo:
```bash
PROFILE_PATH=web PROFILE_NAME=react CHECKS='{"eslint":true,"typecheck":true,"prettier":true,"depcruise":true,"depcruise_dirs":["src","app","lib"]}' \
  HARNESS_DIR=../.github node ../.github/scripts/harness/stack.mjs js
```

### 2. Sửa thứ bắt buộc (⛔ báo người dùng trước)
- File `.env*` hoặc `.vercel/` bị commit:
  1. `git rm --cached`, thêm vào `.gitignore`.
  2. **Rotate mọi secret trong file**, vì secret đã nằm trong lịch sử git.
  3. Người dùng phải tự rotate ở dashboard (Supabase, Stripe…). Claude Code chỉ liệt kê những key cần rotate.
- Secret thật mà TruffleHog tìm thấy trong lịch sử (job schedule): xử lý như trên. Nếu cần xoá khỏi lịch sử (`git filter-repo`) thì việc đó viết lại history, **phải hỏi người dùng**.

### 3. Viết `ARCHITECTURE.md` từ code thật
Đọc cấu trúc thư mục, vài controller/model/service/component tiêu biểu, routing, chỗ gọi DB và auth. Viết lại **kiến trúc mà code đang theo**, không phải kiến trúc lý tưởng. Mẫu ở `profiles/starter/<stack>/ARCHITECTURE.md`.
- Chỉ ghi thành luật những điều mà phần lớn code hiện tại đã tuân theo. Điều chỉ là mong muốn thì đưa vào mục "Hướng đi" để AI không chặn oan.
- Liệt kê ngoại lệ đã biết (vd "module `legacy/billing` chưa theo service object").
- Mục đích: AI review dùng file này làm chuẩn. Viết sai thì AI chặn oan hoặc bỏ lọt.

### 4. Viết `.github/harness.yml`
Bắt đầu từ khung của `debt.mjs`, sau đó:
- `enforcement: observe`
- `profiles` khai báo rõ nếu là monorepo hoặc nhận diện sai.
- **Chưa tắt hay hạ mức rule nào.** Ghi lại các rule cần "xem lại" để đánh giá sau giai đoạn quan sát.
- Nếu `ARCHITECTURE.md` cho thấy rule mặc định sai hẳn với kiến trúc của repo (vd repo dùng `src/ui/` chứ không phải `components/`): thêm rule riêng đúng path, và chỉ tắt rule mặc định khi đã có rule thay thế.
- Thêm rule riêng nếu `ARCHITECTURE.md` có luật kiểm được bằng regex (vd cấm import chéo giữa các feature).
- `merge.bot_approve.enabled: false` trong giai đoạn đầu.

### 5. Giữ CI sẵn có của repo
- Test suite của repo (rspec, vitest…) **giữ nguyên** và để làm required check thứ ba. Harness không chạy test.
- Job lint trùng với harness (vd chạy `eslint .`) có thể bỏ sau khi harness chạy ổn. Không bỏ ngay trong PR onboard.
- Branch protection cũ: org-audit sẽ báo nếu thiếu required check.

### 6. Mở PR onboard (⛔ người dùng duyệt)
Một PR `ci: adopt org harness (observe)` gồm:
- `.github/workflows/org-harness.yml` và `.github/workflows/org-pr-convention.yml` (copy từ `workflow-templates/`, thay `$default-branch`)
- `.github/harness.yml`, `ARCHITECTURE.md`
- config linter còn thiếu (`.rubocop.yml`, `eslint.config.mjs`…) **chỉ khi** team đồng ý. Thêm config linter vào repo cũ sẽ làm mọi file chạm tới phải sửa style theo.
- `.github/CODEOWNERS` phủ `/.github/`

Lưu ý: chính PR này chạy harness với config **mặc định** (enforce), vì `harness.yml` được đọc từ base, mà base chưa có file này.
- Nhờ "chỉ chặn lỗi mới", gate thường xanh: PR chỉ thêm file cấu hình. Nếu thêm config linter mới thì lỗi lint cũ cũng không tính là lỗi mới.
- Nếu ruleset của org **đã** phủ repo này (vd `~ALL`) mà gate đỏ, thì cần admin bypass hoặc tạm loại repo khỏi ruleset. Nên onboard xong các repo **trước** khi bật ruleset, đúng thứ tự trong HANDOFF.
- **Enterprise** (ruleset "require workflows"): ở chế độ observe, các job sensor vẫn có thể đỏ, mà ruleset loại này thường đòi cả workflow phải xanh. Trong giai đoạn quan sát, loại repo khỏi ruleset (`conditions.repository_name.exclude`).

Ngay sau khi merge, repo vào chế độ quan sát.

Supabase: lần đầu job `infra / supabase` sẽ liệt kê `cacheKey` của nợ RLS/Advisor. Thêm vào `advisors_ignore` trong caller rồi mở issue sửa từng cái:
```yaml
  infra:
    uses: <org>/.github/.github/workflows/infra.yml@v1
    with:
      advisors_ignore: |
        rls_disabled_in_public_public_legacy_logs
```

### 7. Quan sát 1–2 tuần
- Gate comment "nếu bật thì sẽ chặn vì…" trên mọi PR. Gom các trường hợp **báo nhầm**, sửa `harness.yml` hoặc rule, hoặc báo cho repo `.github` nếu rule mặc định sai cho cả org.
- Đếm: bao nhiêu PR sẽ bị chặn, vì lý do gì. Mục tiêu trước khi bật là còn dưới ~10% PR bị chặn oan.
- Cách so lỗi lint/tsc với base là **đếm theo key `file|rule|message`** (không theo số dòng). Hệ quả có chủ đích: trong cùng một file, sửa một lỗi cũ rồi thêm một lỗi y hệt ở chỗ khác thì không bị chặn (tổng không tăng). Lỗi mới khác loại thì luôn bị chặn.

### 8. Bật thật (⛔ người dùng quyết)
Ba bước, mỗi bước một PR:
1. `enforcement: enforce` (PR sửa `.github/harness.yml` cần người duyệt; có hiệu lực sau khi merge).
2. Thêm repo vào ruleset của org (hoặc ruleset đã phủ `~ALL` thì repo tự vào).
3. Sau khi chạy ổn: `merge.bot_approve.enabled: true`, có thể bật `review.ai: true`.

### 9. Trả nợ dần
- Report hằng tuần của org-audit + summary của run trên `main` cho biết nợ còn lại.
- Mỗi lần trả xong một nhóm: nâng rule từ `warn` về `error`, xoá key khỏi `advisors_ignore`. Summary của job Advisor in sẵn key nào đã sửa xong.

## Prompt cho Claude Code

```
Onboard repo hiện tại vào harness của org theo ../.github/docs/onboarding-existing-repo.md.
Đọc ../.github/CLAUDE.md trước. Làm bước 1–5, rồi dừng lại cho tôi xem:
báo cáo nợ (debt.mjs), ARCHITECTURE.md bạn viết từ code, harness.yml đề xuất, và danh sách việc ở bước 2 nếu có.
Chưa mở PR, chưa xoá file nào khỏi git, chưa đụng secret khi tôi chưa đồng ý.
```
