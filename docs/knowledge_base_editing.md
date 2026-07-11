# Sổ Tay Tri Thức Dựng Phim: Kỹ Thuật, Dấu Hiệu & Ánh Xạ Thao Tác
Version: 1.0.0

Sổ tay này đóng vai trò là bộ nhớ ngữ nghĩa (Semantic Memory) để LLM tra cứu các kỹ thuật chỉnh sửa video, đối chiếu dấu hiệu nhận dạng từ Mixpeek/OpenCV, và ánh xạ sang các thao tác nguyên tử tương ứng trong `tool_schema.json`.

---

## 1. PHÂN LOẠI KỸ THUẬT (TAXONOMY & DẤU HIỆU NHẬN DẠNG)

### co_correction (Cân màu cơ bản)
* **Dấu hiệu nhận dạng**: 
  - Histogram dồn đống ở dưới (quá tối) hoặc chạm đỉnh luma 100 IRE (cháy sáng).
  - Tông màu bị lệch trắng (nhìn qua white point lệch).
* **Mục tiêu kỹ thuật**: Đưa skin tone về 55-70 IRE, luma phân bổ đều từ 0-100 IRE.
* **Ánh xạ thao tác**:
  1. `set_exposure` để cân bằng sáng.
  2. `set_white_balance` (hoặc `eyedropper_point` vào vùng trắng trung tính).
  3. `set_contrast` (kéo highlights cứu vùng cháy, nâng shadows cứu vùng tối).

### co_tealorange (Tông màu Teal & Orange điện ảnh)
* **Dấu hiệu nhận dạng**:
  - Vùng shadows ngả màu xanh ngọc (Teal / Cyan).
  - Vùng highlights và trung tính (da người) ngả màu cam/vàng ấm.
* **Ánh xạ thao tác**:
  1. `set_color_wheels`:
     - Shadows (Lift): Đẩy nhẹ về hướng Teal (Cyan/Blue-Green).
     - Highlights (Gain): Đẩy nhẹ về hướng Orange (Yellow-Red).
  2. `set_hsl_secondary` (bảo vệ da người): Chọn vùng màu da (`skin`) và khóa sắc độ dọc theo skin-tone line (~11 giờ trên vectorscope).

### cut_beat (Cắt theo nhịp điệu nhạc)
* **Dấu hiệu nhận dạng**:
  - Điểm cắt phân cảnh (Scene change) trùng khớp hoàn toàn hoặc có sai số cực nhỏ (< 3 frame) với điểm gõ trống / percussive hit trong luồng âm thanh.
* **Ánh xạ thao tác**:
  1. `add_marker_at` tại vị trí các beat đã phát hiện.
  2. `cut_at` tại đúng marker đó để phân tách clip.

### tr_speedramp (Thay đổi tốc độ mượt mà)
* **Dấu hiệu nhận dạng**:
  - Không có điểm cắt chuyển cảnh, nhưng tốc độ di chuyển hoặc hành động của vật thể đột ngột tăng vọt lên rất nhanh rồi chậm lại (hoặc ngược lại).
  - Optical flow tăng mạnh tại mốc tăng tốc.
* **Ánh xạ thao tác**:
  1. `set_retime_curve` trên clip với các mốc keyframe tốc độ (ví dụ: `[[0, 100], [10, 400], [15, 100], [25, 40]]`).
  2. `enable_optical_flow` để nội suy chuyển động mượt mà (bắt buộc khi tốc độ < 50% và source là 60fps+).

### tr_whip (Chuyển cảnh Whip Pan lia máy nhanh)
* **Dấu hiệu nhận dạng**:
  - 2-4 frame cuối của clip trước có motion blur phương ngang cực kỳ mạnh.
  - 2-4 frame đầu của clip sau cũng bị motion blur phương ngang cùng chiều.
  - Đi kèm tiếng gió rít (`whoosh` sound effect).
* **Ánh xạ thao tác**:
  1. `add_directional_blur` vào mép cuối clip trước và mép đầu clip sau (đồng bộ góc lia máy).
  2. `add_sfx` tại điểm cắt với kiểu hiệu ứng `whoosh`.
  3. `add_transition` kiểu `cross_dissolve` (thời lượng ngắn, ~4-6 frame) ở giữa.

### co_finishing (Đánh khối hoàn thiện)
* **Dấu hiệu nhận dạng**:
  - Có viền tối bốn góc để thu hút ánh nhìn (Vignette).
  - Có hạt mịn tăng cảm giác điện ảnh (Film grain).
  - Có hai dải đen che trên dưới (Letterbox).
* **Ánh xạ thao tác**:
  1. `add_vignette` (kéo âm nhẹ `-0.5` đến `-1.2` tùy cảnh).
  2. `add_grain` (opacity 10-18%).
  3. `add_letterbox` (aspect ratio 2.35:1).

---

## 2. QUY TẮC RÀNG BUỘC KHI DỰNG PHIM (GIAO ƯỚC VÀNG)

- **Quy tắc Âm thanh**:
  - Âm lượng voiceover/thoại luôn phải đạt peak `-6dB` đến `-3dB` và tích hợp loudness `-14 LUFS`.
  - Nhạc nền (music track) phải có `apply_ducking` tự động giảm `-12dB` mỗi khi xuất hiện giọng thoại.
  - Mọi điểm cắt audio bắt buộc phải chèn `add_audio_fade` (crossfade 2-5 frame) để chống click/pop âm.
- **Quy tắc Chuyển động**:
  - Mọi keyframe di chuyển (zoom, punch-in, text) không bao giờ được để Linear. Bắt buộc gọi `set_easing` với kiểu nội suy `ease_in_out` để chuyển động tự nhiên.
- **Ràng buộc thể loại (Genre Constraints)**:
  - **Talkshow/Interview**: KHÔNG dùng letterbox, KHÔNG dùng transition hoa mỹ. Ưu tiên giữ lại giọng nói đẹp (`enhance_speech`) và giữ lại các đoạn lặng suy nghĩ tự nhiên (`preserve_thinking_pauses: true`).
  - **Cinematic/Montage**: Cắt dựng khớp nhịp beat cực kỳ chặt, ưu tiên teal-orange, speed ramp và whip pan transition.
