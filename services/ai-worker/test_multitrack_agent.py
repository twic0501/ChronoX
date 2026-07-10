import requests
import json

def test_multitrack():
    print("====================================================")
    print("🤖 CHRONOX AGENTIC NLE MULTI-TRACK PROCESSOR TEST")
    print("====================================================\n")
    
    # 1. Mock a real timeline state containing:
    # - V1 Track: A-roll (primary talking head clip)
    # - A1 Track: BGM (background audio)
    timeline_state = """Track V1 (video, MAIN):
  - clip_id="clip-aroll-001" type=video name="a_roll_dialogue.mp4" timeline=[0.0s -> 15.0s] dur=15.0s effects=[]
Track A1 (audio, BGM):
  - clip_id="clip-bgm-002" type=audio name="cinematic_bgm.wav" timeline=[0.0s -> 15.0s] dur=15.0s volume=1.0"""

    prompt = (
        "Nhân bản clip đối thoại clip-aroll-001 lên track overlay làm hiệu ứng Text Behind Subject, "
        "chèn thêm B-roll dalat_view.mp4 đè lên từ giây thứ 5 đến giây thứ 10, "
        "và dìm nhạc nền clip-bgm-002 xuống volume 0.1 trong suốt khoảng thời gian đó."
    )
    
    payload = {
        "prompt": prompt,
        "project_id": "eval_project_99",
        "mode": "local",
        "local_model": "qwen3.5:9b",
        "timeline_state": timeline_state,
        "color_stats": None,
        "scene_map": None
    }
    
    print("Sending prompt to ChronoX NLE Core Backend Chat Service...")
    print(f"Prompt: {prompt}\n")
    
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
    test_multitrack()
