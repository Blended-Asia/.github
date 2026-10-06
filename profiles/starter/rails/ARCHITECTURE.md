# Kiến trúc (Rails)

Tài liệu này được harness đưa cho AI reviewer làm chuẩn đối chiếu. Viết ngắn, viết luật, không viết lịch sử.

## Lớp và trách nhiệm
- **Controller**: nhận request, gọi service/model, chọn response. Không chứa business logic dài quá ~10 dòng, không SQL thô.
- **Model**: dữ liệu, validation, scope, association. Không biết gì về HTTP (params, session, render).
- **Service object** (`app/services`): nghiệp vụ nhiều bước, gọi API ngoài, transaction lớn. Một public method `call`.
- **Query object** (`app/queries`): query phức tạp, tái sử dụng.
- **View/Component**: chỉ hiển thị. Không query DB.
- **Job** (`app/jobs`): idempotent, nhận id chứ không nhận object.

## Quy tắc bắt buộc
- Mọi endpoint mới phải có authorization (Pundit/CanCan/…) và request spec.
- Migration: không gọi model của app, có `down` hoặc dùng `change` đảo ngược được; index cho mọi foreign key.
- Không `update_all`/`delete_all` không điều kiện. Không N+1 trong vòng lặp hiển thị (dùng `includes`).
- Secret chỉ đọc từ `Rails.application.credentials` hoặc ENV, không hardcode.

## Ngoài phạm vi review
Style, format (RuboCop lo), đặt tên biến.
