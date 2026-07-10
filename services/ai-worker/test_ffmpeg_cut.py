import os
import sys
import subprocess

def check_video_file(video_path):
    if not os.path.exists(video_path):
        print(f"❌ Không tìm thấy video tại: {video_path}")
        print("Mẹo: Hãy kéo một file video ngắn (.mp4) của bạn vào thư mục projects để test.")
        return False
    return True

def run_ffmpeg_cmd(cmd):
    print(f"Executing: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print("✅ Thành công!\n")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Thất bại! Mã lỗi: {e.returncode}")
        print(f"Chi tiết: {e.stderr}\n")
        return False

def test_stream_copy(video_path):
    """Cắt thô bằng -c copy (Gây lỗi GOP boundary nếu không ở keyframe)"""
    print("--- 1. Cắt Thô Bằng Stream Copy (-c copy) ---")
    out_file = "test_cut_copy.mp4"
    # Cắt từ giây thứ 3 đến giây thứ 8
    cmd = [
        "ffmpeg", "-y",
        "-ss", "3.0",
        "-to", "8.0",
        "-i", video_path,
        "-c", "copy",
        out_file
    ]
    if run_ffmpeg_cmd(cmd):
        print(f"👉 File cắt thô đã xuất ra: {out_file}")
        print("💡 Hãy mở file này lên: Kiểm tra xem 1-2 giây đầu có bị đứng hình/đen hình/mất tiếng không.")

def test_split_cut(video_path):
    """Cắt lệch pha L-Cut / J-Cut (Video 5.30s, Audio 5.28s)"""
    print("--- 2. Cắt Lệch Pha L-Cut / J-Cut (Sửa lỗi Visual Flash Frame) ---")
    out_file = "test_cut_split.mp4"
    
    # Giả lập:
    # Video cut lúc 3.0s
    # Audio cut lúc 2.8s (lùi 200ms để giữ hơi thở/khoảng im lặng)
    # Lấy độ dài 5 giây
    cmd = [
        "ffmpeg", "-y",
        "-ss", "3.0", "-t", "5.0", "-i", video_path,      # Input 0: cho Video
        "-ss", "2.8", "-t", "5.2", "-i", video_path,      # Input 1: cho Audio (lùi 200ms)
        "-map", "0:v", "-c:v", "libx264", "-crf", "18",   # Lấy video từ Input 0 (Re-encode nhẹ)
        "-map", "1:a", "-c:a", "aac", "-ar", "48000",     # Lấy audio từ Input 1
        "-shortest",                                      # Kết thúc khi track ngắn nhất hết
        out_file
    ]
    if run_ffmpeg_cmd(cmd):
        print(f"👉 File cắt lệch pha đã xuất ra: {out_file}")
        print("💡 File này đã giải mã re-encode nhẹ để đồng bộ trục thời gian hình/tiếng không bị flash frame.")

if __name__ == "__main__":
    video_input = "sample.mp4"
    if len(sys.argv) > 1:
        video_input = sys.argv[1]
        
    if check_video_file(video_input):
        test_stream_copy(video_input)
        print("="*40)
        test_split_cut(video_input)
    else:
        print("\n--- THAM KHẢO LỆNH FFMEG TỰ CHẠY BẰNG TAY ---")
        print("Nếu có file video, bạn có thể chạy thử lệnh này trong terminal:")
        print(f"1. Cắt thô: ffmpeg -y -ss 3.0 -to 8.0 -i your_video.mp4 -c copy output_copy.mp4")
        print(f"2. Cắt L-cut: ffmpeg -y -ss 3.0 -t 5.0 -i your_video.mp4 -ss 2.8 -t 5.2 -i your_video.mp4 -map 0:v -c:v libx264 -map 1:a -c:a aac output_lcut.mp4")
