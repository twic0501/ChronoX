# Kế Hoạch Tái Cấu Trúc Frontend & Tích Hợp ChronoX AI Assistant

Kế hoạch này tập trung vào việc đổi tên thương hiệu dự án thành **ChronoX**, tích hợp Logo mới, tinh giản các cấu trúc giao diện trống thừa thãi của OpenCut, và thiết lập khu vực bệ phóng cho tính năng **ChronoX AI Assistant** ở panel bên phải.

---

## User Review Required

> [!IMPORTANT]
> **Phương án bố trí ChronoX AI Sidebar ở bên phải**:
> Tôi đề xuất nâng cấp Panel bên phải thành một hệ thống Tab linh hoạt:
> 1. **Tab 1: ChronoX AI** (Hiển thị mặc định khi chưa chọn clip): Khung chat AI thông minh hỗ trợ người dùng biên tập video bằng giọng nói/văn bản.
> 2. **Tab 2: Thuộc tính (Properties)** (Chỉ hiển thị hoặc tự động chuyển qua khi click chọn một clip trên timeline): Chỉnh sửa kích thước, âm lượng, màu sắc của clip như cũ.
>
> Cách bố trí này giúp tận dụng không gian trống cực kỳ hiệu quả, loại bỏ hoàn toàn lỗi hiển thị trống (Empty View) gây cụt hứng của OpenCut.

> [!TIP]
> **Tinh giản Menu bên trái**:
> Do các tab Stickers, Transitions, Filters, Settings hiện tại của OpenCut trống rỗng và rất thô sơ (vì thiếu kết nối Cloud), tôi đề xuất ẩn/loại bỏ các tab này để giao diện **ChronoX** trông cực kỳ gọn gàng, chuyên nghiệp, chỉ tập trung vào 3 tab cốt lõi: **Assets** (Nhập media), **Text** (Thêm chữ), và **Audio** (Âm thanh).

---

## Proposed Changes

### 1. Đổi tên thương hiệu (Rebranding to ChronoX)

#### [MODIFY] [site-constants.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/constants/site-constants.ts)
- Thay đổi `SITE_INFO.title` thành `"ChronoX"`.
- Cập nhật slogan: `"ChronoX - An Agentic AI video workspace that empowers beginners to edit frames using natural language."`

#### [MODIFY] [header.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/header.tsx) và [editor-header.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/editor-header.tsx)
- Cập nhật Logo và nhãn hiển thị thành **ChronoX**.
- Tải file logo mới mà bạn vừa gửi lên và đặt làm logo mặc định.

#### [MODIFY] [onboarding.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/onboarding.tsx)
- Thay đổi tiêu đề chào mừng thành: `"Welcome to ChronoX! 🎬"`
- Đổi mô tả thành: `"Trình biên tập video local thế hệ mới tích hợp Trí tuệ nhân tạo Agentic AI."`

---

### 2. Thiết lập cấu trúc Tab Phía bên phải (AI + Properties)

#### [NEW] [ChatSidebar.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/properties/chat-sidebar.tsx)
Tạo mới component khung chat AI:
- Có khung hiển thị hội thoại cuộn mượt.
- Hộp nhập câu lệnh chat hỗ trợ Auto-focus.
- Vùng hiển thị trạng thái suy nghĩ của AI (bóc tách thẻ `<thought>...</thought>`).
- Thanh hiển thị tiến độ render (Progress bar) nhận dữ liệu từ server FastAPI thông qua Server-Sent Events (SSE).

#### [MODIFY] [index.tsx (Properties Panel)](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/properties/index.tsx)
- Viết lại hàm render:
  - Nếu không có clip nào được chọn: Hiển thị mặc định **ChronoX AI Chat**.
  - Nếu có clip được chọn: Hiển thị thanh chuyển đổi Tab (AI Chat $\leftrightarrow$ Clip Properties) ở trên cùng.

---

### 3. Tinh giản Sidebar bên trái (Left Sidebar)

#### [MODIFY] [index.tsx (Assets/Tools Panel)](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/assets/index.tsx)
- Ẩn các nút công cụ trống (Stickers, Transitions, Filters, Settings) để làm gọn sidebar. Chỉ giữ lại Assets, Audio và Text.

---

## Verification Plan

### Manual Verification
1. F5 lại trình duyệt, kiểm tra xem tiêu đề tab trình duyệt và tiêu đề trên thanh Header đã đổi thành **ChronoX** chưa.
2. Kiểm tra xem panel bên phải khi chưa chọn clip đã hiển thị khung chat **ChronoX AI Assistant** thay vì thông báo "Empty View" thô sơ chưa.
3. Chọn thử một clip trên timeline, kiểm tra xem tab thuộc tính (Properties) có xuất hiện song song với tab AI để chuyển đổi qua lại không.
