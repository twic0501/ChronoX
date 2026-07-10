import requests
import json

def test_brush_tracking():
    url = "http://127.0.0.1:8001/api/ai/track-brush"
    payload = {
        "video_path": "dummy_path.mp4",
        "points": [
            [{"x": 0.4, "y": 0.4}, {"x": 0.5, "y": 0.5}, {"x": 0.6, "y": 0.6}]
        ],
        "brush_size": 40.0,
        "keyframe_time": 2.5,
        "clip_start": 1.0,
        "clip_duration": 3.0
    }
    
    print("Testing /api/ai/track-brush endpoint...")
    try:
        res = requests.post(url, json=payload)
        print(f"Status Code: {res.status_code}")
        data = res.json()
        if res.status_code == 200 and data.get("status") == "success":
            print("✅ Success: Tracking path generated successfully!")
            print(f"Number of frames tracked: {len(data.get('tracking_path', []))}")
            first_frame = data["tracking_path"][0]
            print(f"First tracked frame: {first_frame}")
        else:
            print(f"❌ Failure: {data}")
    except Exception as e:
        print(f"❌ Connection error: {e}")

if __name__ == "__main__":
    test_brush_tracking()
