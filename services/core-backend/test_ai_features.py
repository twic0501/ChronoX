#!/usr/bin/env python3
"""
ChronoX AI Feature Test Suite
Tests all Level 1-4 editing operations via the backend API.
"""

import json
import sys
import subprocess
import time

API_URL = "http://127.0.0.1:8000/api/ai/chat"

TIMELINE_STATE = (
    'Track "track-1" (video):\n'
    '  - clip_id="clip-abc123" type=video name="New project.mp4" start=0.0s dur=10.0s\n'
    '  - clip_id="clip-def456" type=video name="B-roll.mp4" start=9.0s dur=15.0s\n'
    'Track "track-2" (audio):'
)

COLOR_STATS = (
    'Độ sáng (brightness): 0.45\n'
    '  - Độ tương phản (contrast): 0.38\n'
    '  - Độ bão hòa màu (saturation): 0.52\n'
    '  - Tông màu ấm/lạnh (warmth): 0.12'
)

TESTS = [
    # Level 1 — Temporal
    {"name": "L1: Split", "prompt": "cắt clip clip-abc123 ở giây thứ 5", "expect_action": "split"},
    {"name": "L1: Trim", "prompt": "cắt bỏ 3 giây đầu và 5 giây cuối của clip clip-abc123", "expect_action": "trim"},
    {"name": "L1: Delete", "prompt": "xóa clip clip-abc123", "expect_action": "delete"},
    {"name": "L1: Demux Audio", "prompt": "tách âm thanh ra khỏi video clip-abc123", "expect_action": "demux_audio"},
    
    # Level 2 — Spatial
    {"name": "L2: Transform", "prompt": "phóng to clip clip-abc123 1.5 lần và xoay 15 độ", "expect_action": "transform"},
    {"name": "L2: Transition", "prompt": "thêm hiệu ứng chuyển cảnh cross dissolve 1.5 giây giữa clip-abc123 và clip-def456", "expect_action": "add_transition"},
    
    # Level 3 — Frame Manipulation
    {"name": "L3: Speed", "prompt": "tua nhanh clip clip-abc123 gấp 2 lần", "expect_action": "change_speed"},
    {"name": "L3: Blend Mode", "prompt": "đặt chế độ hòa trộn multiply và giảm opacity của clip-abc123 xuống 70%", "expect_action": "blend_mode"},
    {"name": "L3: Color Grade", "prompt": "chỉnh màu vintage ấm cho clip clip-abc123", "expect_action": "adjust_color",
     "extra": {"color_stats": COLOR_STATS}},

    # Level 4 — Advanced
    {"name": "L4: Chroma Key", "prompt": "tách nền xanh lá của video clip-abc123", "expect_action": "chroma_key"},
    {"name": "L4: Mask", "prompt": "tạo mặt nạ hình chữ nhật trên clip clip-abc123", "expect_action": "add_mask"},
]


def run_test(test):
    payload = {
        "prompt": test["prompt"],
        "project_id": "test-suite",
        "mode": "local",
        "timeline_state": TIMELINE_STATE,
    }
    if "extra" in test:
        payload.update(test["extra"])

    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "90", "-X", "POST", API_URL,
             "-H", "Content-Type: application/json",
             "-d", json.dumps(payload)],
            capture_output=True, text=True, timeout=95
        )
        
        full_text = ""
        thinking = ""
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                msg = obj.get("message", {})
                full_text += msg.get("content", "")
                thinking += msg.get("thinking", "")
            except:
                pass

        return {
            "name": test["name"],
            "prompt": test["prompt"],
            "expect_action": test["expect_action"],
            "response": full_text,
            "thinking_preview": thinking[:200],
        }
    except Exception as e:
        return {
            "name": test["name"],
            "error": str(e),
        }


def extract_operations(response_text):
    """Extract JSON operations from AI response text."""
    ops = []
    # Look for ```json block
    import re
    json_match = re.search(r'```json\s*\n(.*?)\s*```', response_text, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            ops = data.get("operations", [])
        except:
            pass
    
    if not ops:
        # Try to find raw JSON object with operations
        json_match = re.search(r'\{[^{}]*"operations"\s*:\s*\[.*?\]\s*\}', response_text, re.DOTALL)
        if json_match:
            try:
                data = json.loads(json_match.group(0))
                ops = data.get("operations", [])
            except:
                pass
    
    return ops


def main():
    results = []
    
    for i, test in enumerate(TESTS):
        print(f"\n{'='*60}")
        print(f"TEST {i+1}/{len(TESTS)}: {test['name']}")
        print(f"Prompt: \"{test['prompt']}\"")
        print(f"Expected action: {test['expect_action']}")
        print(f"{'='*60}")
        
        result = run_test(test)
        
        if "error" in result:
            print(f"❌ ERROR: {result['error']}")
            results.append({"name": test["name"], "status": "ERROR", "detail": result["error"]})
            continue
        
        response = result["response"]
        print(f"\nAI Response:\n{response[:300]}...")
        
        ops = extract_operations(response)
        
        if ops:
            actions = [op.get("action") for op in ops]
            expected = test["expect_action"]
            if expected in actions:
                print(f"\n✅ PASS — Found expected action '{expected}'")
                print(f"   Operations: {json.dumps(ops, ensure_ascii=False, indent=2)}")
                
                # Validate operation quality
                op = next(o for o in ops if o.get("action") == expected)
                issues = validate_operation(expected, op)
                if issues:
                    print(f"   ⚠️  Quality issues: {', '.join(issues)}")
                    results.append({"name": test["name"], "status": "PASS_WITH_ISSUES", "issues": issues, "op": op})
                else:
                    print(f"   ✅ Operation quality: GOOD")
                    results.append({"name": test["name"], "status": "PASS", "op": op})
            else:
                print(f"\n⚠️  WRONG ACTION — Expected '{expected}', got {actions}")
                results.append({"name": test["name"], "status": "WRONG_ACTION", "got": actions, "ops": ops})
        else:
            print(f"\n❌ FAIL — No operations found in response")
            results.append({"name": test["name"], "status": "NO_OPS", "response": response[:200]})
        
        # Small delay between tests
        time.sleep(1)
    
    # Summary
    print(f"\n\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    
    pass_count = sum(1 for r in results if r["status"] == "PASS")
    pass_issues = sum(1 for r in results if r["status"] == "PASS_WITH_ISSUES")
    fail_count = sum(1 for r in results if r["status"] in ("NO_OPS", "ERROR", "WRONG_ACTION"))
    
    for r in results:
        icon = {"PASS": "✅", "PASS_WITH_ISSUES": "⚠️", "WRONG_ACTION": "🔶", "NO_OPS": "❌", "ERROR": "💥"}.get(r["status"], "?")
        detail = ""
        if r["status"] == "PASS_WITH_ISSUES":
            detail = f" ({', '.join(r['issues'])})"
        elif r["status"] == "WRONG_ACTION":
            detail = f" (got: {r['got']})"
        print(f"  {icon} {r['name']}: {r['status']}{detail}")
    
    print(f"\n  Total: {pass_count} pass, {pass_issues} warnings, {fail_count} fail out of {len(results)}")


def validate_operation(expected_action, op):
    """Validate that the operation has correct and complete parameters."""
    issues = []
    
    if expected_action == "split":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "time" not in op:
            issues.append("missing time")
        elif op["time"] != 5.0:
            issues.append(f"time should be 5.0, got {op['time']}")
    
    elif expected_action == "trim":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "start" not in op and "end" not in op:
            issues.append("missing start/end")
    
    elif expected_action == "delete":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
    
    elif expected_action == "demux_audio":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
    
    elif expected_action == "transform":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        has_transform = any(k in op for k in ["scale", "scale_x", "scale_y", "rotation", "position_x", "position_y"])
        if not has_transform:
            issues.append("no transform params")
    
    elif expected_action == "add_transition":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "transition_type" not in op:
            issues.append("missing transition_type")
        if "duration" not in op:
            issues.append("missing duration")
    
    elif expected_action == "change_speed":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "speed" not in op:
            issues.append("missing speed")
        elif op["speed"] != 2.0:
            issues.append(f"speed should be 2.0, got {op['speed']}")
    
    elif expected_action == "blend_mode":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "blend_mode" not in op:
            issues.append("missing blend_mode")
        if "opacity" not in op:
            issues.append("missing opacity")
    
    elif expected_action == "adjust_color":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "params" not in op:
            issues.append("missing params")
    
    elif expected_action == "chroma_key":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
    
    elif expected_action == "mask_inpainting" or expected_action == "add_mask":
        if "clip_id" not in op or not op["clip_id"]:
            issues.append("missing clip_id")
        if "mask_type" not in op:
            issues.append("missing mask_type")
    
    # Universal check: clip_id should match the real one
    if op.get("clip_id") and op["clip_id"] not in ("clip-abc123", "<ID>"):
        if "placeholder" in op["clip_id"].lower() or "example" in op["clip_id"].lower():
            issues.append("clip_id is a placeholder, not real")
    
    return issues


if __name__ == "__main__":
    main()
