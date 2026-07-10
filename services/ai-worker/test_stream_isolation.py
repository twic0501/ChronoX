import os
import sys
import uuid
import shutil
import subprocess
import torch

def probe_hardware_capabilities():
    """Dò tìm phần cứng đồ họa local để tối ưu hóa bộ mã hóa (Hardware capabilities probe)"""
    print("--- 1. Quét Cấu Hình Phần Cứng (Hardware Capabilities Probe) ---")
    config = {"encoder": "libx264", "device": "cpu", "hwaccel": None}
    
    # 1. NVIDIA GPU Check
    if torch.cuda.is_available() and shutil.which("nvidia-smi"):
        config["device"] = "cuda"
        config["encoder"] = "h264_nvenc"
        config["hwaccel"] = "cuda"
        print("💡 Phát hiện NVIDIA GPU với CUDA! Sử dụng h264_nvenc để tăng tốc phần cứng.")
    # 2. Intel/AMD VAAPI (Linux)
    elif shutil.which("vainfo"):
        config["encoder"] = "h264_vaapi"
        config["hwaccel"] = "vaapi"
        print("💡 Phát hiện driver VAAPI! Sử dụng h264_vaapi để tăng tốc phần cứng.")
    # 3. CPU fallback
    else:
        print("💡 Sử dụng CPU mã hóa phần mềm tiêu chuẩn (libx264).")
        
    print(f"Cấu hình nạp: {config}\n")
    return config

def run_ffmpeg_with_progress(cmd):
    """
    Chạy FFmpeg với subprocess.Popen để đọc luồng tiến trình không chặn (Non-blocking I/O)
    và hiển thị phần trăm tiến độ thời gian thực (Progress bar).
    Cho phép ngắt tiến trình bằng phím bấm giả lập.
    """
    print(f"Executing CLI: {' '.join(cmd)}")
    
    # Khởi chạy subprocess.Popen
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,  # Gộp stderr vào stdout để đọc tiến trình tiện lợi
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1
    )
    
    try:
        # Đọc dữ liệu ra từ stdout liên tục theo thời gian thực
        while process.poll() is None:
            line = process.stdout.readline()
            if not line:
                continue
            
            # Phân tích tiến độ đơn giản từ logs đầu ra của FFmpeg
            # FFmpeg thường in thông tin dạng: frame=  125 fps= 25 time=00:00:05.00
            if "time=" in line:
                time_part = line.split("time=")[1].split()[0]
                print(f"\r⏳ [FFmpeg Progress] Current rendering time: {time_part}", end="", flush=True)
                
        # Kiểm tra kết quả
        returncode = process.wait()
        print("\n")
        if returncode == 0:
            print("✅ Tiến trình FFmpeg hoàn tất thành công!")
            return True
        else:
            print(f"❌ Tiến trình FFmpeg thất bại với mã lỗi: {returncode}")
            return False
            
    except KeyboardInterrupt:
        # Xử lý Hủy tác vụ an toàn bằng cách gửi ký tự "q" qua stdin
        print("\n⚠️ Nhận lệnh ngắt! Đang gửi ký tự 'q' để dừng an toàn FFmpeg...")
        try:
            process.stdin.write("q\n")
            process.stdin.flush()
            # Chờ tối đa 5 giây cho FFmpeg đóng file gọn gàng
            process.wait(timeout=5)
            print("✅ Đã ngắt FFmpeg an toàn và đóng container file hoàn chỉnh!")
        except Exception as e:
            print(f"⚠️ Không thể dừng FFmpeg an toàn, force terminating... Chi tiết: {e}")
            process.terminate()
        return False

def test_stream_isolation_and_remux(video_path, hw_config):
    """
    Thực thi pipeline tách luồng Audio/Video (Stream Isolation Pipeline)
    và lưu file tạm trong thư mục UUID (Atomic Temporary Directory Control)
    """
    print("--- 2. Tách Luồng (Stream Isolation) & Dọn Dẹp Tạm (Atomic Temp) ---")
    
    # Định nghĩa thư mục tạm trong Workspace (Tránh dùng /tmp ngoài workspace)
    workspace_root = os.path.dirname(os.path.abspath(__file__))
    task_id = str(uuid.uuid4())
    temp_dir = os.path.join(workspace_root, "tmp", f"task_{task_id}")
    os.makedirs(temp_dir, exist_ok=True)
    
    print(f"📂 Khởi tạo thư mục tạm cô lập tại: {temp_dir}")
    
    audio_wav = os.path.join(temp_dir, "audio.wav")
    video_only = os.path.join(temp_dir, "video_only.mp4")
    output_remux = os.path.join(workspace_root, f"output_isolation_{task_id[:8]}.mp4")
    
    try:
        # Bước 1: Tách luồng Audio WAV thô (Audio Stream Isolation)
        print("\n[Bước 1/3] Đang tách luồng Audio thô (WAV)...")
        audio_cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            audio_wav
        ]
        if not run_ffmpeg_with_progress(audio_cmd):
            raise Exception("Tách luồng audio thất bại")
            
        print(f"👉 File audio thô WAV đã trích xuất: {audio_wav} (ẵn sàng nạp vào Whisper/VAD)")
        
        # Bước 2: Xử lý riêng luồng Video (Trích xuất video không tiếng để inpaint/render)
        print("\n[Bước 2/3] Đang tách luồng Video không tiếng...")
        video_cmd = ["ffmpeg", "-y"]
        if hw_config["hwaccel"]:
            video_cmd.extend(["-hwaccel", hw_config["hwaccel"]])
        
        video_cmd.extend([
            "-i", video_path,
            "-an",
            "-c:v", hw_config["encoder"],
            video_only
        ])
        
        if not run_ffmpeg_with_progress(video_cmd):
            raise Exception("Tách luồng video thất bại")
            
        # Bước 3: Remuxing chập 2 luồng lại thành file đầu ra
        print("\n[Bước 3/3] Đang Remuxing chập luồng hình và luồng tiếng thô...")
        remux_cmd = [
            "ffmpeg", "-y",
            "-i", video_only,
            "-i", audio_wav,
            "-map", "0:v",
            "-map", "1:a",
            "-c:v", "copy",
            "-c:a", "aac",
            output_remux
        ]
        if run_ffmpeg_with_progress(remux_cmd):
            print(f"\n🎉 Xuất file kết quả Remuxing thành công: {output_remux}")
            
    except Exception as e:
        print(f"❌ Xảy ra lỗi trong pipeline xử lý: {e}")
    finally:
        # Bắt buộc dọn dẹp sạch sẽ đĩa đệm (Atomic cleanup)
        print(f"\n🧹 Đang thực hiện dọn dẹp thư mục tạm...")
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
            print("✨ Đã xóa sạch thư mục tạm an toàn!")

if __name__ == "__main__":
    video_input = "sample.mp4"
    if len(sys.argv) > 1:
        video_input = sys.argv[1]
        
    if not os.path.exists(video_input):
        print(f"❌ Không tìm thấy video tại: {video_input}")
        print("Mẹo: Hãy copy 1 video ngắn đặt tên sample.mp4 vào chronox-backend để test.")
        sys.exit(1)
        
    # 1. Quét khả năng phần cứng
    hw_config = probe_hardware_capabilities()
    
    # 2. Chạy pipeline tách luồng và remux
    test_stream_isolation_and_remux(video_input, hw_config)
