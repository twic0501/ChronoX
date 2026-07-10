# 📚 KHO KỸ NĂNG CỨNG CHRONOX (ChronoX Core Hard Skills Playbook)

Chào mừng bạn đến với **Kho Kỹ năng Cứng ChronoX**! Tài liệu này mô phỏng chi tiết 12 kỹ năng biên tập video và âm thanh chuyên nghiệp (NLE editing patterns) được điều khiển và tự động hóa bởi trợ lý ảo AI co-pilot ChronoX.

---

## 🗺️ BẢNG TỔNG HỢP 12 KỸ NĂNG CỨNG

| STT | Tên Kỹ năng (Skill Name) | Phương thức AI Co-pilot (Operations) | Mục tiêu & Hiệu quả nghệ thuật |
| :--- | :--- | :--- | :--- |
| 1 | **Chunky-Step Speed Ramping** | `split` + `change_speed` | Tạo nhịp điệu nhanh - chậm đột ngột để nhấn mạnh hành động. |
| 2 | **Manual J-Cut & L-Cut** | `demux_audio` + `trim` / `offset` | Chuyển cảnh âm thanh đi trước hoặc sau hình ảnh mượt mà. |
| 3 | **Dynamic Audio Ducking** | Captions VAD + `adjust_volume` / `duck_audio` | Tự động giảm âm lượng nhạc nền (BGM) khi có tiếng nói. |
| 4 | **Split-Screen Masking** | B-roll overlay + `add_mask` (rectangle) | Chia đôi màn hình so sánh Before/After hoặc hai góc máy. |
| 5 | **Overshoot Punch-In Zoom** | `split` + `transform` (scale/position) | Phóng to đột ngột vào gương mặt hoặc điểm nhấn quan trọng. |
| 6 | **Dynamic Captions Bounce** | `add_subtitle` + keyframe scale | Làm phụ đề sinh động, giật nảy theo nhịp điệu giọng nói. |
| 7 | **Chroma Key Spill Eraser** | `chroma_key` + tolerance/smoothness | Tách phông nền xanh sạch sẽ, khử ám xanh ở tóc và viền. |
| 8 | **AI Auto-Beat Match Cut** | BGM beat markers + `split` | Tự động cắt dựng hình ảnh nhảy theo nhịp trống của nhạc nền. |
| 9 | **AI Deflicker & Denoise** | `adjust_color` (noise/flicker params) | Làm sạch nhiễu hạt trong bóng tối và khử nhấp nháy đèn. |
| 10 | **Freeze Frame Transition** | Frame export + cutout mask + B-roll | Đóng băng khung hình, tách nhân vật chuyển cảnh ấn tượng. |
| 11 | **AI Color Match Studio** | Histogram sync + `adjust_color` presets | Đồng bộ màu sắc giữa các clip khác nhau theo ảnh mẫu. |
| 12 | **Masking Linear Transition** | `add_mask` + animate center + `feather` | Chuyển cảnh quét mượt mà sử dụng mặt nạ dịch chuyển. |

---

## 🛠️ CHI TIẾT 12 KỸ NĂNG & PHƯƠNG THỨC KIỂM THỬ

### 1. Chunky-Step Speed Ramping
* **Khái niệm**: Băm nhỏ clip thành 3 phần: Nhanh -> Rất Nhanh -> Siêu Chậm để nhấn mạnh các hành động đỉnh cao (như cú sút bóng, nhảy xa).
* **AI Operations**:
```json
{
  "operations": [
    { "action": "split", "clip_id": "video_1", "time": 2.0 },
    { "action": "split", "clip_id": "video_1_split_2", "time": 4.0 },
    { "action": "change_speed", "clip_id": "video_1", "speed": 2.0 },
    { "action": "change_speed", "clip_id": "video_1_split_1", "speed": 4.0 },
    { "action": "change_speed", "clip_id": "video_1_split_2", "speed": 0.25 }
  ]
}
```
* **Cách test trực quan**: Phát timeline, kiểm tra tốc độ clip thay đổi giật cục nhưng mượt mà theo cấu trúc nhanh -> chậm.

---

### 2. Manual J-Cut & L-Cut
* **Khái niệm**: Tách âm thanh khỏi video gốc để kéo lệch pha, cho phép âm thanh của cảnh sau vang lên trước khi hình ảnh xuất hiện (J-Cut) hoặc ngược lại (L-Cut).
* **AI Operations**:
```json
{
  "operations": [
    { "action": "demux_audio", "clip_id": "clip_a" },
    { "action": "trim", "clip_id": "clip_a_video", "start": 0.5, "end": 4.5 }
  ]
}
```
* **Cách test trực quan**: Trên timeline, thanh âm thanh của clip kéo dài hơn hoặc bắt đầu sớm hơn thanh hình ảnh của chính nó 0.5 giây.

---

### 3. Dynamic Audio Ducking
* **Khái niệm**: Khi phát hiện giọng nói (qua bóc tách VAD của PyAnnote), nhạc nền ở track dưới sẽ tự động giảm âm lượng để tôn giọng nói, và tự tăng lại khi dứt lời.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "duck_audio", "clip_id": "bgm_track", "volume": 0.15, "start": 1.5, "end": 3.8 },
    { "action": "duck_audio", "clip_id": "bgm_track", "volume": 1.0, "start": 3.9 }
  ]
}
```
* **Cách test trực quan**: Lắng nghe âm lượng nhạc nền tự giảm sâu khi nhân vật nói và lớn dần trở lại ngay sau đó.

---

### 4. Split-Screen Masking
* **Khái niệm**: Đặt hai clip song song ở 2 track chồng lên nhau, áp dụng mặt nạ hình chữ nhật cắt đôi màn hình để làm video so sánh trước/sau.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "add_overlay", "asset_id": "broll_1", "overlay_type": "video", "start": 0.0, "duration": 5.0 },
    { "action": "add_mask", "clip_id": "broll_1", "mask_type": "rectangle", "feather": 0 }
  ]
}
```
* **Cách test trực quan**: Màn hình xem trước (Preview) hiển thị rõ rệt ranh giới thẳng đứng phân chia hai nội dung video khác nhau.

---

### 5. Overshoot Punch-In Zoom
* **Khái niệm**: Cắt nhỏ đoạn hội thoại gay cấn và phóng to thu phóng màn hình (scale: 1.3x - 1.4x) dịch tâm vào mặt nhân vật để nhấn mạnh biểu cảm.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "split", "clip_id": "main_video", "time": 3.5 },
    { "action": "transform", "clip_id": "main_video_split_2", "position_x": 0.1, "position_y": -0.05, "scale": 1.35 }
  ]
}
```
* **Cách test trực quan**: Đến mốc giây chỉ định, khung hình giật mạnh phóng to vào đúng điểm trọng tâm (gương mặt).

---

### 6. Dynamic Captions Bounce
* **Khái niệm**: Phụ đề tự động nhảy lên khi phát âm, có hiệu ứng nảy kích thước (Scale keyframes) bắt mắt.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "add_subtitle", "text": "CHRONOX!", "start": 1.2, "end": 2.0 }
  ]
}
```
* **Cách test trực quan**: Chữ phụ đề to đột ngột rồi thu nhỏ nhẹ về cỡ chuẩn khi âm thanh tương ứng phát ra.

---

### 7. Chroma Key Spill Eraser
* **Khái niệm**: Loại bỏ màu phông xanh lá (Green Screen) của clip và khử các viền xanh bị phản chiếu lên nhân vật (spill).
* **AI Operations**:
```json
{
  "operations": [
    { "action": "chroma_key", "clip_id": "greenscreen_clip", "key_color": "#00ff00", "tolerance": 0.45, "smoothness": 0.15 }
  ]
}
```
* **Cách test trực quan**: Phông nền xanh biến mất hoàn toàn, lộ ra lớp video nền bên dưới mà không bị răng cưa hay lem nhem.

---

### 8. AI Auto-Beat Match Cut
* **Khái niệm**: Quét các nhịp gõ chính (beats) của bài nhạc nền, tự động chia nhỏ các clip video khác và căn chỉnh biên cắt (splits) khớp chuẩn xác vào mốc beat.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "split", "clip_id": "dance_video", "time": 1.03 },
    { "action": "split", "clip_id": "dance_video_split_1", "time": 2.06 }
  ]
}
```
* **Cách test trực quan**: Nhịp chuyển cảnh nhảy sang góc máy khác trùng khớp hoàn toàn với tiếng trống dập của bài nhạc.

---

### 9. AI Deflicker & Denoise
* **Khái niệm**: Làm mịn hình ảnh, giảm hạt bụi nhiễu (Denoise) và triệt tiêu hiện tượng nháy ánh sáng (Deflicker) từ đèn neon/huỳnh quang.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "adjust_color", "clip_id": "dark_shot", "params": { "brightness": 0.05, "contrast": 0.1, "saturation": 0.0 } }
  ]
}
```
* **Cách test trực quan**: Video trong trẻo hơn, các vùng tối giảm hạt nhiễu động rõ rệt.

---

### 10. Freeze Frame Transition
* **Khái niệm**: Tại điểm chuyển cảnh, tạo một khung hình tĩnh rồi áp dụng tách nền AI (Cutout) để nhân vật trượt từ ngoài vào trong trước khi clip tiếp theo chạy.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "add_overlay", "asset_id": "freeze_cutout", "overlay_type": "image", "start": 3.0, "duration": 2.0 }
  ]
}
```
* **Cách test trực quan**: Nhân vật đứng yên bay vào màn hình, sau đó chuyển động tiếp khi video gốc chạy tiếp.

---

### 11. AI Color Match Studio
* **Khái niệm**: Hút tông màu chủ đạo từ ảnh mẫu tham khảo, tự động tinh chỉnh các thanh trượt màu sắc (Lift, Gamma, Gain) để đồng bộ ánh sáng hai camera khác nhau.
* **AI Operations**:
```json
{
  "operations": [
    {
      "action": "adjust_color",
      "clip_id": "target_clip",
      "params": {
        "lift_r": -0.02, "lift_g": 0.01, "lift_b": 0.05,
        "gain_r": 1.15, "gain_g": 1.05, "gain_b": 0.95
      }
    }
  ]
}
```
* **Cách test trực quan**: Tông màu nóng/lạnh của clip được điều chỉnh tức thì giống hệt tông màu mẫu.

---

### 12. Masking Linear Transition
* **Khái niệm**: Chuyển cảnh bằng cách di chuyển mặt nạ từ trái qua phải, kết hợp độ mờ biên (Feather) để pha trộn mềm mại giữa clip A và clip B.
* **AI Operations**:
```json
{
  "operations": [
    { "action": "add_mask", "clip_id": "clip_b", "mask_type": "split", "feather": 25 }
  ]
}
```
* **Cách test trực quan**: Clip A mờ dần theo dạng dải quét tuyến tính nghiêng 45 độ để lộ dần clip B bên dưới.
