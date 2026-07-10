import requests
import json
import time

def test_volume_ai():
    print("================================================")
    print("🔊 CHRONOX AI CO-PILOT VOLUME SENSING & MUTE TEST")
    print("================================================\n")
    
    # 1. Mock timeline state showing volume=0dB (our new format!)
    timeline_state = """Track V1 (video, MAIN):
  - clip_id="clip-vlog-002" type=video name="beach_dialogue.mp4" timeline=[0.0s -> 8.0s] dur=8.0s effects=[] volume=0dB"""

    prompt = "Tắt âm lượng (mute) của video clip-vlog-002 đi."
    
    payload = {
        "prompt": prompt,
        "project_id": "volume_project_102",
        "mode": "local",
        "local_model": "qwen3.5:9b",
        "timeline_state": timeline_state,
        "color_stats": None,
        "scene_map": None
    }
    
    print("Sending mute prompt to ChronoX NLE Core Backend...")
    try:
        res = requests.post("http://127.0.0.1:8000/api/ai/chat", json=payload)
        if res.status_code != 200:
            print(f"❌ API Error: {res.status_code} - {res.text}")
            return
            
        # Parse NDJSON response
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
        print(f"❌ Connection failed: {e}")

if __name__ == "__main__":
    test_volume_ai()
