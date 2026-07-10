import requests
import json
import time

def test_autonomous():
    print("====================================================")
    print("🤖 CHRONOX AUTONOMOUS AGENT STYLE ANALYSIS & EXECUTE")
    print("====================================================\n")
    
    timeline_state = """Track V1 (video, MAIN):
  - clip_id="clip-vlog-003" type=video name="street_walk.mp4" timeline=[0.0s -> 10.0s] dur=10.0s effects=[] volume=0dB"""

    prompt = "phân tích kĩ thuật áp dụng trong video mẫu và bắt chước cho clip-vlog-003"
    
    payload = {
        "prompt": prompt,
        "project_id": "autonomous_project_103",
        "mode": "local",
        "local_model": "qwen3.5:9b",
        "timeline_state": timeline_state,
        "color_stats": None,
        "scene_map": None
    }
    
    print("Sending style analysis request to ChronoX NLE Core Backend...")
    # Wait for the backend to start up
    time.sleep(2)
    
    try:
        res = requests.post("http://127.0.0.1:8000/api/ai/chat", json=payload)
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
        print(f"❌ Connection failed: {e}")

if __name__ == "__main__":
    test_autonomous()
