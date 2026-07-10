# CHRONOX — TÀI LIỆU THIẾT KẾ UI/UX WORKSPACE

> **Mục tiêu**: Xây dựng giao diện biên tập video chuyên nghiệp, responsive, sử dụng triệt để hệ thống component có sẵn (Base UI, Tailwind v4, Lucide React, và Resizable Panels).
> **Nguyên tắc**: Tối giản, sang trọng (Sleek Dark Mode), tập trung vào tương tác Ngôn ngữ tự nhiên.

---

## 1. PHÂN BỔ BỐ CỤC KHÔNG GIAN (WORKSPACE LAYOUT)

Chúng ta sử dụng `react-resizable-panels` để chia màn hình thành 3 khu vực chính:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TOP MENU / NAVIGATION BAR                       │
├───────────────────────┬───────────────────────────────┬────────────────┤
│                       │                               │                │
│                       │        CANVAS PREVIEW         │  CHAT SIDEBAR  │
│     LEFT SIDEBAR      │        (Trình phát)           │  (AI Brain)    │
│    (Media/Effects/    │                               │                │
│     Assets)           ├───────────────────────────────┤  Hiển thị:     │
│                       │        CONTROL BUTTONS        │  - Lịch sử chat│
│                       │        (Play/Pause/Zoom)      │  - Thought tag │
│                       │                               │  - Progress %  │
├───────────────────────┴───────────────────────────────┴────────────────┤
│                               TIMELINE                                 │
│      (Các track Video, Audio, Playhead, Kéo thả & Cắt phân đoạn)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. CHI TIẾT TỪNG COMPONENT UI/UX

### A. Chat Sidebar Component (`ChatSidebar.tsx`)
- **Vị trí**: Nằm cố định ở panel bên phải (chiếm 25-30% độ rộng màn hình).
- **Thiết kế**:
  - Giao diện dạng Glassmorphism (nền mờ `backdrop-blur-md`, viền mịn `border-border/40`).
  - **Thought Toggle**: Một accordion nhỏ hiển thị suy nghĩ nội bộ của AI (`<thought>...</thought>`) để giám khảo hackathon nhìn thấy quá trình Agent reasoning. Nền màu xám sẫm hoặc xanh than tối.
  - **Message Bubble**:
    - User message: Góc bo tròn, căn phải, nền màu Primary (Slate tối).
    - AI message: Căn trái, kèm avatar AI, nền nhạt hơn, hiển thị markdown đẹp.
  - **Status & Progress Indicator**: 
    - Khi AI đang render hoặc inpaint: Clip liên quan trên Timeline sẽ chuyển sang trạng thái đông băng `locked` với một overlay sọc chuyển động.
    - Thanh Progress Bar chạy mượt nhờ linear interpolation cập nhật từ SSE.
  - **Nút "Force Unlock"**: Một icon nhỏ hình ổ khóa mở nằm cạnh clip bị khóa, click để ép mở khóa UI thủ công.

### B. Canvas Preview Component (`VideoCanvas.tsx`)
- **Vị trí**: Panel trung tâm phía trên.
- **Tính năng**:
  - Chạy video proxy 360p để đảm bảo tốc độ preview 30fps mượt.
  - Áp dụng các bộ lọc màu (Color Grading) trực tiếp bằng WebGL Shaders (render trực tiếp trên GPU client, không gọi backend).
  - Có canvas overlay để vẽ bounding box / mask cho SAM 2 (khi user click vẽ vật thể để xóa hoặc tách nền).

### C. Timeline Component (`VideoTimeline.tsx`)
- **Vị trí**: Chiếm trọn nửa dưới màn hình.
- **Tính năng**:
  - Giao diện track-based (Track Video chính, Track Video đè B-roll, Track Audio thoại, Track Nhạc nền).
  - Playhead (thanh chạy thời gian) cập nhật đồng bộ với Video Player.
  - Hỗ trợ zoom in/out timeline bằng con lăn chuột hoặc phím tắt.
  - Biểu diễn trực quan các điểm **L-Cut/J-Cut**: audio track và video track của cùng một clip có thể có độ dài lệch nhau tại điểm nối (Asymmetric Cuts).

---

## 3. CÁC BƯỚC TRIỂN KHAI FRONTEND UI

Chúng ta sẽ sửa đổi và tạo mới các file trong `apps/web/src`:

1. **Bước 1**: Cập nhật [routes/index.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/routes/index.tsx). Thay thế mã "hello world" bằng layout chia panel dùng `react-resizable-panels` kết hợp Navbar.
2. **Bước 2**: Tạo thư mục `components/workspace` để chứa:
   - `ChatSidebar.tsx` (Sidebar AI)
   - `VideoCanvas.tsx` (Bộ phát video preview)
   - `VideoTimeline.tsx` (Trình quản lý timeline, clips)
3. **Bước 3**: Cài đặt Bun/Npm dependencies của frontend và chạy thử dev server trên cổng `5173` để kiểm chứng visual layout trước khi kết nối API.

---

*Tài liệu thiết kế giao diện này đã sẵn sàng. Hãy cho tôi biết nếu cấu trúc này phù hợp để chúng ta bắt đầu triển khai code layout!*
