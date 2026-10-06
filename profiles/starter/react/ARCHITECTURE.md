# Kiến trúc (Next.js / React)

Tài liệu này được harness đưa cho AI reviewer làm chuẩn đối chiếu.

## Cấu trúc
- `app/`: route (App Router). Mặc định là **Server Component**; chỉ thêm `"use client"` cho phần cần state/event.
- `components/`: UI dùng chung, không import từ `app/`.
- `lib/`: tiện ích thuần, client SDK, kết nối DB (file server dùng `import "server-only"`).
- `features/<tên>/`: code theo tính năng; feature khác chỉ dùng qua `features/<tên>/index.ts`.

## Dữ liệu & bảo mật
- Đọc/ghi dữ liệu ở server (Server Component, Server Action, route handler). Client không gọi DB trực tiếp ngoài Supabase client với anon key + RLS.
- `SUPABASE_SERVICE_ROLE_KEY` và mọi secret chỉ dùng trong code server.
- Mọi Server Action / route handler phải kiểm tra session và quyền trước khi đọc/ghi.
- Validate input bằng schema (zod) ở biên server.

## Chất lượng
- Logic nghiệp vụ mới có unit test; flow quan trọng có e2e.
- Không fetch dữ liệu trong `useEffect` khi có thể lấy ở server.

## Ngoài phạm vi review
Format (Prettier), lint style (ESLint).
