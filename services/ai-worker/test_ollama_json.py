import sys
import json
import re
import requests

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "qwythos"  # Hãy kéo model hoặc create bằng Modelfile thành tên 'qwythos'

SYSTEM_PROMPT = """
Bạn là một AI Editor điều khiển video. Hãy phân tích yêu cầu của người dùng và trả về danh sách các thao tác chỉnh sửa video dưới dạng JSON.
Đầu ra của bạn PHẢI tuân thủ cấu trúc sau:
1. Viết suy nghĩ của bạn trong thẻ <thought>...</thought> (bằng tiếng Việt).
2. Viết danh sách các lệnh thực thi ở định dạng JSON ở cuối.

Ví dụ đầu ra:
<thought>
Người dùng muốn cắt clip. Tôi sẽ dùng lệnh trim cho clip vid1.
</thought>
{
  "operations": [
    {"action": "trim", "clip_id": "vid1", "start": 5.0, "end": 10.0}
  ]
}

Danh sách các clip hiện tại:
- clip_id: "vid1", duration: 30.0s, label: "quay phỏng vấn"
- clip_id: "vid2", duration: 15.0s, label: "b-roll cảnh biển"
"""

def test_ollama_query(user_prompt):
    print(f"--- Đang gửi prompt tới Ollama ({MODEL_NAME}) ---")
    print(f"User Prompt: {user_prompt}\n")
    
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt}
        ],
        "stream": False,
        "options": {
            "temperature": 0.4,
            "top_p": 0.9,
            "repeat_penalty": 1.05
        }
    }
    
    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=60)
        response.raise_for_status()
        raw_output = response.json().get("message", {}).get("content", "")
        
        print("--- Phản hồi thô từ Ollama ---")
        print(raw_output)
        print("\n--- Tiến hành phân tích cấu trúc ---")
        
        # 1. Bóc tách thought
        thought_match = re.search(r"<thought>(.*?)</thought>", raw_output, re.DOTALL)
        if thought_match:
            print(f"✅ Tìm thấy thought:\n{thought_match.group(1).strip()}\n")
        else:
            print("❌ Không tìm thấy thẻ <thought>!\n")
            
        # 2. Tìm khối JSON
        # Tìm dấu ngoặc nhọn mở đầu tiên của JSON sau thẻ thought
        json_start = raw_output.find("{", thought_match.end() if thought_match else 0)
        if json_start != -1:
            json_str = raw_output[json_start:]
            try:
                data = json.loads(json_str)
                print("✅ Parse JSON thành công:")
                print(json.dumps(data, indent=2, ensure_ascii=False))
                
                # Validate operations
                ops = data.get("operations", [])
                if ops:
                    print(f"👉 Tìm thấy {len(ops)} lệnh:")
                    for idx, op in enumerate(ops):
                        print(f"  [{idx + 1}] Action: {op.get('action')}, clip_id: {op.get('clip_id')}, range: {op.get('start')}s -> {op.get('end')}s")
                else:
                    print("⚠️ JSON không chứa danh sách 'operations'.")
            except json.JSONDecodeError as je:
                print(f"❌ Lỗi parse JSON: {je}")
                print("Đoạn text nghi ngờ là JSON:")
                print(json_str)
        else:
            print("❌ Không tìm thấy khối JSON trong phản hồi!")
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Lỗi kết nối Ollama: {e}")
        print("Đảm bảo Ollama server đang chạy ở http://localhost:11434")

if __name__ == "__main__":
    prompt = "Cắt lấy đoạn từ giây thứ 10 đến giây thứ 20 của clip phỏng vấn."
    if len(sys.argv) > 1:
        prompt = sys.argv[1]
    test_ollama_query(prompt)
