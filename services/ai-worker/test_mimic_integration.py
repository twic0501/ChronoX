import os
import sys
import json
import requests

def test_integration():
    print("=== STARTING INTEGRATION TEST ===")
    
    # 1. Check if backend is alive
    backend_url = "http://127.0.0.1:8000"
    try:
        res = requests.get(f"{backend_url}/api/ai/status")
        print(f"Backend Status Check: {res.status_code}")
    except Exception as e:
        print(f"❌ Backend not reachable: {e}")
        sys.exit(1)

    # 2. Upload sample video
    sample_path = "services/ai-worker/sample.mp4"
    if not os.path.exists(sample_path):
        sample_path = "sample.mp4"
        
    if not os.path.exists(sample_path):
        print("❌ sample.mp4 not found. Please place a sample.mp4 video file in the workspace.")
        sys.exit(1)

    print(f"Uploading reference video: {sample_path}...")
    with open(sample_path, "rb") as f:
        upload_res = requests.post(f"{backend_url}/api/upload", files={"file": f})
        
    if upload_res.status_code != 200:
        print(f"❌ Upload failed: {upload_res.text}")
        sys.exit(1)
        
    upload_data = upload_res.json()
    ref_video_path = upload_data["original_path"]
    print(f"✅ Uploaded. Server path: {ref_video_path}")

    # 3a. Trigger Mimic Flow API (WITH target audio and video)
    audio_path = upload_data.get("audio_path") or ref_video_path
    
    payload_with_audio = {
        "reference_video_path": ref_video_path,
        "target_audio_path": audio_path,
        "target_video_path": ref_video_path,
        "target_video_duration": 10.0
    }
    
    print(f"Triggering Mimic Flow API with BGM & Video: {json.dumps(payload_with_audio, indent=2)}...")
    mimic_res = requests.post(f"{backend_url}/api/ai/mimic-flow", json=payload_with_audio)
    
    if mimic_res.status_code != 200:
        print(f"❌ Mimic Flow with BGM failed: {mimic_res.text}")
        sys.exit(1)
        
    mimic_data = mimic_res.json()
    print("✅ Mimic Flow response (with audio) received:")
    print(json.dumps(mimic_data, indent=2))
    assert mimic_data["status"] == "success"
    assert "mutations" in mimic_data

    # Check for presence of content-aware mutations
    mutations = mimic_data["mutations"]
    has_zoom = any(m["action"] == "ADD_ZOOM" for m in mutations)
    has_mask = any(m["action"] == "ADD_MASK" for m in mutations)
    has_effect = any(m["action"] == "ADD_EFFECT" for m in mutations)
    
    print(f"Detected effects mutations: Zoom={has_zoom}, Mask={has_mask}, Effect={has_effect}")
    assert has_zoom, "Mimic response should propose subject-centered zoom mutations"

    # 3b. Trigger Mimic Flow API (WITHOUT target audio - Video Only Mode)
    payload_without_audio = {
        "reference_video_path": ref_video_path,
        "target_audio_path": None,
        "target_video_path": ref_video_path,
        "target_video_duration": 10.0
    }
    
    print(f"Triggering Mimic Flow API without BGM (Video-Only): {json.dumps(payload_without_audio, indent=2)}...")
    mimic_res_free = requests.post(f"{backend_url}/api/ai/mimic-flow", json=payload_without_audio)
    
    if mimic_res_free.status_code != 200:
        print(f"❌ Mimic Flow (Video-Only) failed: {mimic_res_free.text}")
        sys.exit(1)
        
    mimic_data_free = mimic_res_free.json()
    print("✅ Mimic Flow response (Video-Only) received:")
    print(json.dumps(mimic_data_free, indent=2))
    assert mimic_data_free["status"] == "success"
    assert "mutations" in mimic_data_free
    print("🎉 Both Mimic Flow modes verified successfully!")

    # 4. Trigger Master Export API
    # Construct a mock project timeline with a video element
    project_payload = {
        "project": {
            "scenes": [
                {
                    "id": "scene_1",
                    "tracks": [
                        {
                            "id": "video_track_1",
                            "type": "video",
                            "elements": [
                                {
                                    "id": "el_1",
                                    "name": "clip_1",
                                    "type": "video",
                                    "startTime": 0.0,
                                    "duration": 4.5,
                                    "trimStart": 1.0,
                                    "trimEnd": 5.5,
                                    "sourceOriginalPath": ref_video_path,
                                    "sourceProxyPath": upload_data["proxy_path"]
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    }

    print(f"Triggering Master Export API...")
    export_res = requests.post(f"{backend_url}/api/project/export", json=project_payload)
    
    # We allow export failures in program test if ffmpeg is busy or missing codecs,
    # but we assert status is code 200 for REST pipeline validation.
    print(f"Export Status: {export_res.status_code}")
    assert export_res.status_code == 200, f"Export request failed: {export_res.text}"
    
    export_data = export_res.json()
    print("✅ Export response received:")
    print(json.dumps(export_data, indent=2))
    
    print("=== ALL INTEGRATION TESTS PASSED ===")

if __name__ == "__main__":
    test_integration()
