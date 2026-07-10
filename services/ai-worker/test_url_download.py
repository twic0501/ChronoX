import requests
import time

def test_download():
    print("=============================================")
    print("📥 CHRONOX VIDEO LINK DOWNLOAD PIPELINE TEST")
    print("=============================================\n")
    
    url = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
    payload = {
        "url": url
    }
    
    print(f"Triggering direct download for: {url}")
    
    # Wait for the backend to start up
    time.sleep(2)
    
    try:
        res = requests.post("http://127.0.0.1:8000/api/ai/download-asset", json=payload)
        if res.status_code == 200:
            print("✅ Download & Transcode completed successfully!")
            print("Response:", res.json())
        else:
            print(f"❌ Failed: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"❌ Connection error: {e}")

if __name__ == "__main__":
    test_download()
