# Kế Hoạch Triển Khai: Hoàn Thiện 13 Công Cụ Biên Tập Phi AI — ChronoX

Tạm gác lại toàn bộ tính năng AI (Ollama, Whisper, VAD). Tập trung 100% vào việc hoàn thiện bộ công cụ biên tập tiêu chuẩn để ChronoX trở thành một video editor chuyên nghiệp thực thụ.

---

## Nhóm 1: Đã Hoàn Thiện & Hoạt Động Tốt (6 mục — Giữ nguyên, chỉ polish)

### Mục 1: ✂️ Cắt / Tách clip (Split) — ĐÃ CÓ 90%
- Phím tắt `Ctrl + B` gọi `TimelineManager.splitElements()`.
- **Việc cần làm**: Không cần sửa gì thêm.

### Mục 2: 🧲 Hút dính tự động (Auto Snapping) — ĐÃ CÓ 100%
- Clip tự động hút vào cạnh clip lân cận khi kéo thả.
- **Việc cần làm**: Không cần sửa gì thêm.

### Mục 3: 🔄 Dồn dịch timeline (Ripple Editing) — ĐÃ CÓ 100%
- Tự động lấp khoảng trống khi xóa/co ngắn clip.
- **Việc cần làm**: Không cần sửa gì thêm.

### Mục 4: ↩️ Hoàn tác / Làm lại (Undo / Redo) — ĐÃ CÓ 100%
- Hệ thống Command-Pattern đồ sộ, phím tắt `Ctrl + Z` / `Ctrl + Y`.
- **Việc cần làm**: Không cần sửa gì thêm.

### Mục 5: 🔍 Thu phóng Timeline (Zoom & Navigation) — ĐÃ CÓ 100%
- Thanh trượt zoom, cuộn ngang dọc đồng bộ preview.
- **Việc cần làm**: Không cần sửa gì thêm.

### Mục 6: 📍 Đánh dấu vị trí (Bookmarks / Markers) — ĐÃ CÓ 90%
- Nút Bookmark02Icon trên Toolbar, BookmarkNoteOverlay gõ ghi chú.
- **Việc cần làm**: Không cần sửa gì thêm.

---

## Nhóm 2: Có Lõi Backend — Cần Mở Khóa Giao Diện (2 mục)

### Mục 7: 🔊 Biên tập âm thanh (Audio Volume & Fade) — CÓ 80%

Lõi đã có: waveform trên timeline, Audio Tab chỉnh volume, toggle mute.

**Việc cần làm**:

#### [MODIFY] [audio-tab.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/properties/tabs/audio-tab.tsx)
- Bổ sung 2 thanh trượt mới: **Fade In (giây)** và **Fade Out (giây)**.
- Khi người dùng kéo Fade In = 1s, hệ thống tự chèn keyframe volume ẩn: `0dB → volume` trong 1 giây đầu clip.
- Khi người dùng kéo Fade Out = 1s, hệ thống tự chèn keyframe volume ẩn: `volume → 0dB` trong 1 giây cuối clip.

---

### Mục 8: 📈 Hoạt họa chuyển động (Animation Presets) — CÓ LÕI, THIẾU UI

Lõi renderer đã viết sẵn `resolveTransformAtTime()` và `resolveOpacityAtTime()` nhưng giao diện không có nút đặt keyframe.

**Việc cần làm**:

#### [MODIFY] [transform-tab.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/properties/tabs/transform-tab.tsx)
Thêm phần **Animation Presets** (nhóm nút bấm) phía dưới các thông số Transform hiện tại:
- **Fade In**: Click → tự chèn 2 keyframe Opacity: `0` tại `t=0s` và `1` tại `t=1s`.
- **Fade Out**: Click → tự chèn 2 keyframe Opacity: `1` tại `t=(duration-1s)` và `0` tại `t=duration`.
- **Zoom In**: Click → tự chèn 2 keyframe Scale: `0.8` tại `t=0s` và `1.0` tại `t=1s`.
- **Zoom Out**: Click → tự chèn 2 keyframe Scale: `1.0` tại `t=(duration-1s)` và `0.8` tại `t=duration`.
- **Slide Left → Right**: Click → tự chèn 2 keyframe Position X: `-100%` tại `t=0s` và `0` tại `t=0.5s`.

---

## Nhóm 3: Cần Xây Dựng Mới Cho MVP (5 mục)

### Mục 9: 🎨 Chỉnh màu (Color Adjustment) — CHƯA CÓ

#### [NEW] [color_adjust.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/color_adjust.frag.glsl)
WebGL Fragment Shader tính toán Brightness, Contrast, Saturation trong 1 pass duy nhất.

#### [NEW] [color_adjust.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/color_adjust.ts)
Đăng ký hiệu ứng `color-adjust` vào `effectsRegistry` với 3 params:
- `brightness`: min -1, max 1, default 0, step 0.01
- `contrast`: min -1, max 1, default 0, step 0.01
- `saturation`: min -1, max 1, default 0, step 0.01

#### [MODIFY] [definitions/index.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/index.ts)
Import và đăng ký `colorAdjustEffectDefinition` vào mảng `defaultEffects`.

---

### Mục 10: ✨ Thư viện hiệu ứng (Effects Library) — CHỈ CÓ BLUR

#### [NEW] [grayscale.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/grayscale.frag.glsl) & [grayscale.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/grayscale.ts)
Hiệu ứng ảnh đen trắng. Shader: `float lum = dot(rgb, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(lum, lum, lum, a);`
Param: `intensity` (0-100, mặc định 100) để pha trộn giữa màu gốc và đen trắng.

#### [NEW] [invert.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/invert.frag.glsl) & [invert.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/invert.ts)
Hiệu ứng đảo ngược màu (Negative). Shader: `gl_FragColor = vec4(1.0 - rgb, a);`
Param: `intensity` (0-100, mặc định 100).

#### [NEW] [vignette.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/vignette.frag.glsl) & [vignette.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/vignette.ts)
Hiệu ứng làm tối 4 góc kiểu điện ảnh.
Params: `intensity` (0-100, mặc định 50), `radius` (0-1, mặc định 0.75).

#### [NEW] [chroma_key.frag.glsl](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/chroma_key.frag.glsl) & [chroma_key.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/chroma_key.ts)
Hiệu ứng tách nền xanh (Green Screen / Chroma Key).
Params: `keyColor` (hex, mặc định `#00FF00`), `tolerance` (0-1, mặc định 0.4), `smoothness` (0-1, mặc định 0.1).

#### [MODIFY] [definitions/index.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/effects/definitions/index.ts)
Đăng ký tất cả 4 hiệu ứng mới vào mảng `defaultEffects`.

---

### Mục 11: 🔀 Chuyển cảnh (Transitions) — CHƯA CÓ

#### [NEW] [cross-dissolve.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/lib/transitions/cross-dissolve.ts)
Cơ chế Cross Dissolve: Tự động xếp chồng đè 2 clip kề nhau khoảng 0.5-1s, nội suy opacity ngược chiều nhau (Clip A: 1→0, Clip B: 0→1) tại vùng chồng lấn.

#### [MODIFY] [assets-panel-store.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/stores/assets-panel-store.tsx)
Mở lại tab **Transitions** trong sidebar trái (hiện đang bị ẩn), hiển thị danh sách transition có sẵn để người dùng kéo thả vào giữa 2 clip.

---

### Mục 12: 🎙️ Ghi âm trực tiếp (Voiceover Recording) — CHƯA CÓ

#### [NEW] [voiceover-button.tsx](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/components/editor/panels/assets/views/voiceover-button.tsx)
Nút ghi âm từ micro máy tính bằng **HTML5 MediaRecorder API**:
- Bấm nút → Bắt đầu ghi âm (hiện đèn đỏ nhấp nháy + đếm giây).
- Bấm lại → Dừng ghi, tự lưu thành file `.webm` hoặc `.wav`.
- Tự động thêm file âm thanh vào Media Library và insert clip âm thanh mới vào timeline tại vị trí playhead hiện tại.

---

### Mục 13: 🗣️ Đọc chữ thành tiếng (Text-to-Speech — TTS) — CHƯA CÓ

#### [NEW] [tts-service.ts](file:///home/twictrn/Projects/chronox-frontend/apps/web/src/services/tts/tts-service.ts)
Dịch vụ TTS sử dụng **Web Speech API** (`SpeechSynthesis`) có sẵn trong trình duyệt (không cần backend):
- Người dùng gõ nội dung chữ → Chọn ngôn ngữ/giọng đọc → Bấm nút "Tạo giọng đọc".
- Hệ thống phát và ghi âm giọng đọc bằng `MediaRecorder`, lưu thành file `.webm`.
- Tự động insert clip âm thanh vào timeline.

---

## Thứ Tự Triển Khai

| Ưu tiên | Mục | Tên công cụ | Thời lượng dự kiến |
|---------|-----|-------------|-------------------|
| 🔴 P0 | 9 | Chỉnh màu (Color Adjustment) | ~1 giờ |
| 🔴 P0 | 10 | Thư viện hiệu ứng (Grayscale, Invert, Vignette, Chroma Key) | ~1.5 giờ |
| 🟠 P1 | 8 | Animation Presets (Fade In/Out, Zoom In/Out) | ~1 giờ |
| 🟠 P1 | 7 | Audio Fade In/Out | ~45 phút |
| 🟡 P2 | 11 | Chuyển cảnh Cross Dissolve | ~1.5 giờ |
| 🟡 P2 | 12 | Ghi âm Voiceover | ~1 giờ |
| 🟡 P2 | 13 | Text-to-Speech | ~1 giờ |
| ✅ | 1-6 | Đã hoàn thiện, chỉ polish | — |

---

## Kế Hoạch Nghiệm Thu

1. **Chỉnh màu**: Chọn clip → Thêm hiệu ứng Color Adjust → Kéo thanh Brightness → Preview sáng lên ngay lập tức.
2. **Hiệu ứng**: Bấm thêm Grayscale → Video chuyển đen trắng. Bấm Chroma Key → Nền xanh biến mất.
3. **Animation**: Click Fade In → Play → Clip hiện ra mượt mà từ đen. Click Zoom In → Clip to dần lên.
4. **Audio Fade**: Kéo Fade In = 1s → Play → Tiếng từ nhỏ lớn dần, không bị nổ.
5. **Transitions**: Kéo Cross Dissolve vào giữa 2 clip → Play → Hòa tan mượt mà.
6. **Voiceover**: Bấm ghi âm → Nói thử → Clip mới hiện trên timeline.
7. **TTS**: Gõ "Xin chào" → Bấm tạo → Xuất hiện clip giọng đọc tiếng Việt.
