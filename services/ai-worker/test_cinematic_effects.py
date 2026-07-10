import requests
import json
import time

def test_cinematic():
    print("====================================================")
    print("🎬 CHRONOX CINEMATIC EFFECTS & TIMELINE COPILOT TEST")
    print("====================================================\n")
    
    # 1. Mock timeline state
    timeline_state = """Track V1 (video, MAIN):
  - clip_id="clip-nature-001" type=video name="waterfall_tripod.mp4" timeline=[0.0s -> 10.0s] dur=10.0s effects=[]"""

    prompt = (
        "Làm cho clip-nature-001 chạy ngược lại để nước chảy ngược đầy thơ mộng, "
        "thêm hiệu ứng rung máy handheld camera-shake cho bớt đơ, "
        "thêm viền sáng Halation phim nhựa, và dán dải đen Letterbox 2.39:1 chuẩn điện ảnh."
    )
    
    payload = {
        "prompt": prompt,
        "project_id": "cinematic_project_101",
        "mode": "local",
        "local_model": "qwen3.5:9b",
        "timeline_state": timeline_state,
        "color_stats": None,
        "scene_map": None
    }
    
    print("Sending prompt to ChronoX NLE Core Backend Chat Service...")
    print(f"Prompt: {prompt}\n")
    
    # Wait for servers to be fully ready
    time.sleep(2)
    
    try:
        res = requests.post("http://127.0.0.1:8000/api/ai/chat", json=payload, stream=True)
        if res.status_code != 200:
            print(f"❌ API Error: {res.status_code} - {res.text}")
            return
            
        full_reply = ""
        for line in res.iter_lines():
            if line:
                try:
                    parsed = json.loads(line.decode("utf-8"))
                    content = parsed.get("message", {}).get("content", "")
                    full_reply += content
                except Exception:
                    pass
                    
        print("✅ Response from ChronoX NLE Core:")
        print(full_reply)
        
    except Exception as e:
        print(f"❌ Connection failed: {e}. Please make sure Ollama is running.")

if __name__ == "__main__":
    test_cinematic()
