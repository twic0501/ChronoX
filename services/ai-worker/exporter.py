import os
import sys
import json
import subprocess


def _num(params, key, default=0.0):
    v = params.get(key, default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _color_adjust_filter(params):
    """Translate a color-adjust effect's params into an FFmpeg filter chain.

    The browser preview grades via a WebGL shader (color_adjust.frag.glsl);
    the exported file must reproduce it or every scene keeps its original
    look ("all scenes same colour"). This is a close FFmpeg approximation of
    that shader using `eq` (brightness/contrast/saturation/exposure) and
    `colorbalance` (lift→shadows, gain→highlights, temperature→r/b split).
    """
    parts = []

    brightness = _num(params, "brightness")
    contrast = _num(params, "contrast")
    saturation = _num(params, "saturation")
    exposure = _num(params, "exposure")

    eq = []
    if abs(brightness) > 1e-3:
        eq.append(f"brightness={_clamp(brightness, -1.0, 1.0):.4f}")
    if abs(contrast) > 1e-3:
        # shader: (rgb-0.5)*(1+contrast)+0.5  ≡  eq contrast=1+contrast
        eq.append(f"contrast={_clamp(1.0 + contrast, 0.0, 2.0):.4f}")
    if abs(saturation) > 1e-3:
        eq.append(f"saturation={_clamp(1.0 + saturation, 0.0, 3.0):.4f}")
    if abs(exposure) > 1e-3:
        # shader multiplies linear light by 2^exposure; approximate with gamma
        eq.append(f"gamma={_clamp(1.0 / (2.0 ** exposure), 0.1, 10.0):.4f}")
    if eq:
        parts.append("eq=" + ":".join(eq))

    # Temperature / warmth: shader shifts R up and B down. `warmth` is the
    # alias the AI agent emits; `temperature` is the canonical key.
    temp = _num(params, "temperature") or _num(params, "warmth")
    tint = _num(params, "tint")

    # Lift (shadows offset) and Gain (highlights scale, 1.0 = neutral) → the
    # shadow/highlight bands of colorbalance (additive, -1..1).
    rs = _num(params, "lift_r")
    gs = _num(params, "lift_g")
    bs = _num(params, "lift_b")
    rh = _num(params, "gain_r", 1.0) - 1.0
    gh = _num(params, "gain_g", 1.0) - 1.0
    bh = _num(params, "gain_b", 1.0) - 1.0
    # Fold temperature/tint into the midtones.
    rm = temp * 0.5 - tint * 0.25
    gm = tint * 0.5
    bm = -temp * 0.5 - tint * 0.25

    cb = {
        "rs": rs, "gs": gs, "bs": bs,
        "rm": rm, "gm": gm, "bm": bm,
        "rh": rh, "gh": gh, "bh": bh,
    }
    cb_parts = [
        f"{k}={_clamp(v, -1.0, 1.0):.4f}"
        for k, v in cb.items()
        if abs(v) > 1e-3
    ]
    if cb_parts:
        parts.append("colorbalance=" + ":".join(cb_parts))

    return ",".join(parts)


def _effects_filter(el):
    """Build the FFmpeg filter suffix for an element's visual effects.

    Currently maps the color-adjust grade (the one the AI applies per scene).
    Other GPU-only effects are ignored gracefully rather than failing export.
    """
    chain = []
    for ef in (el.get("effects") or []):
        if not isinstance(ef, dict):
            continue
        if ef.get("enabled") is False:
            continue
        if ef.get("type") == "color-adjust":
            f = _color_adjust_filter(ef.get("params") or {})
            if f:
                chain.append(f)
    return ",".join(chain)


def export_timeline(timeline_json_path, output_path):
    print(f"Loading timeline from {timeline_json_path}...")
    with open(timeline_json_path, 'r', encoding='utf-8') as f:
        project_data = json.load(f)

    # Resolve tracks
    # We find scenes -> first scene -> tracks
    scenes = project_data.get("scenes", [])
    if not scenes:
        print("Error: No scenes found in project data.")
        sys.exit(1)
        
    tracks = scenes[0].get("tracks", [])
    
    # We will gather all video and audio elements
    video_elements = []
    audio_elements = []
    
    for track in tracks:
        track_type = track.get("type")
        elements = track.get("elements", [])
        if track_type == "video":
            video_elements.extend(elements)
        elif track_type == "audio":
            audio_elements.extend(elements)

    # Sort by startTime
    video_elements.sort(key=lambda x: x.get("startTime", 0.0))
    audio_elements.sort(key=lambda x: x.get("startTime", 0.0))

    if not video_elements:
        print("Error: No video elements found on the timeline.")
        sys.exit(1)

    inputs = []
    filter_parts = []
    input_indices = {}
    
    # Helper to resolve original path — fail loudly instead of silently
    # exporting a placeholder video when source files are missing.
    def resolve_path(el):
        path = el.get("sourceOriginalPath")
        if path and os.path.exists(path):
            return path
        path = el.get("sourceProxyPath")
        if path and os.path.exists(path):
            return path
        name = el.get("name") or el.get("id") or "unknown"
        print(
            f"Error: source file for element '{name}' not found "
            f"(sourceOriginalPath={el.get('sourceOriginalPath')!r}, "
            f"sourceProxyPath={el.get('sourceProxyPath')!r})."
        )
        print("EXPORT_FAILED: missing source media — re-import the asset and try again.")
        sys.exit(2)

    # Register inputs
    for el in video_elements:
        path = resolve_path(el)
        if path not in input_indices:
            input_indices[path] = len(inputs)
            inputs.append(path)

    for el in audio_elements:
        path = resolve_path(el)
        if path not in input_indices:
            input_indices[path] = len(inputs)
            inputs.append(path)

    # Generate FFmpeg filters
    v_concat_inputs = []
    a_concat_inputs = []
    
    # 1. Process Video Elements
    for idx, el in enumerate(video_elements):
        path = resolve_path(el)
        in_idx = input_indices[path]
        trim_start = el.get("trimStart", 0.0)
        duration = el.get("duration", 5.0)
        trim_end = trim_start + duration
        
        # Speed ramping
        rate = 1.0
        retime = el.get("retime")
        curve = None
        reverse = False
        if retime and isinstance(retime, dict):
            rate = retime.get("rate", 1.0)
            curve = retime.get("curve")
            reverse = retime.get("reverse", False)
            
        v_lbl = f"v{idx}"
        
        # Video Stabilization 2-Pass detection
        trf_file = None
        if el.get("stabilize") or el.get("stabilize") == "true":
            trf_file = f"./shared_storage/stabilize_{el.get('id')}.trf"
            print(f"Running stabilization Pass 1 for clip {el.get('id')}...")
            detect_cmd = [
                "ffmpeg", "-y", "-ss", str(trim_start), "-to", str(trim_end), "-i", path,
                "-vf", f"vidstabdetect=shakiness=5:accuracy=15:result={trf_file}",
                "-f", "null", "-"
            ]
            subprocess.run(detect_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Crop/trim video
        trim_filter = f"[{in_idx}:v]trim=start={trim_start}:end={trim_end},setpts=PTS-STARTPTS"
        if trf_file and os.path.exists(trf_file):
            trim_filter += f",vidstabtransform=input={trf_file}:smoothing=30"
            
        if curve:
            # Cinematic Non-Linear speed ramp using a sinusoidal s-curve easing function
            trim_filter += f",setpts='(1.0/{rate})*PTS + (0.15/{rate})*sin(PTS*2.0)'"
        elif rate != 1.0:
            # setpts=1/rate*PTS
            trim_filter += f",setpts={1.0/rate}*PTS"
        
        if reverse:
            trim_filter += ",reverse"

        # Per-clip visual effects (color grade). Without this the export drops
        # the AI's per-scene colour, leaving every scene its original look.
        fx = _effects_filter(el)
        if fx:
            trim_filter += f",{fx}"

        filter_parts.append(f"{trim_filter}[{v_lbl}]")
        v_concat_inputs.append(f"[{v_lbl}]")

        # Extract audio from video if it has audio
        a_lbl = f"a_v{idx}"
        trim_audio_filter = f"[{in_idx}:a]atrim=start={trim_start}:end={trim_end},asetpts=PTS-STARTPTS"
        if el.get("voice_isolation") or el.get("voice_isolation") == "true":
            trim_audio_filter += ",afftdn=noise_reduction=12:noise_type=w,highpass=f=80,lowpass=f=10000"
            
        if rate != 1.0:
            trim_audio_filter += f",atempo={rate}"
        if reverse:
            trim_audio_filter += ",areverse"
        filter_parts.append(f"{trim_audio_filter}[{a_lbl}]")
        a_concat_inputs.append(f"[{a_lbl}]")

    # 2. Process Dedicated Audio Elements
    for idx, el in enumerate(audio_elements):
        path = resolve_path(el)
        in_idx = input_indices[path]
        trim_start = el.get("trimStart", 0.0)
        duration = el.get("duration", 5.0)
        trim_end = trim_start + duration
        
        a_lbl = f"a_dedicated{idx}"
        trim_audio_filter = f"[{in_idx}:a]atrim=start={trim_start}:end={trim_end},asetpts=PTS-STARTPTS"
        if el.get("voice_isolation") or el.get("voice_isolation") == "true":
            trim_audio_filter += ",afftdn=noise_reduction=12:noise_type=w,highpass=f=80,lowpass=f=10000"
            
        filter_parts.append(f"{trim_audio_filter}[{a_lbl}]")
        a_concat_inputs.append(f"[{a_lbl}]")

    # Concat filters
    v_concat_str = "".join(v_concat_inputs)
    v_out_lbl = "v_out"
    filter_parts.append(f"{v_concat_str}concat=n={len(video_elements)}:v=1:a=0[{v_out_lbl}]")

    a_concat_str = "".join(a_concat_inputs)
    a_out_lbl = "a_out"
    total_audio_tracks = len(video_elements) + len(audio_elements)
    filter_parts.append(f"{a_concat_str}amix=inputs={total_audio_tracks}[{a_out_lbl}]")

    filter_complex = ";".join(filter_parts)

    # Formulate command
    cmd = ["ffmpeg", "-y"]
    for path in inputs:
        cmd.extend(["-i", path])
        
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", f"[{v_out_lbl}]",
        "-map", f"[{a_out_lbl}]",
        "-c:v", "libx264",
        "-crf", "21",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-ar", "48000",
        output_path
    ])

    print(f"Running command: {' '.join(cmd)}")
    
    # Non-blocking subprocess Popen
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    
    while True:
        line = process.stdout.readline()
        if not line:
            break
        # Parse progress if present (e.g. time=00:00:05.12)
        if "time=" in line:
            print(f"PROGRESS_UPDATE: {line.strip()}", flush=True)

    process.wait()
    
    # Clean up temporary stabilization log files
    for el in video_elements:
        if el.get("stabilize") or el.get("stabilize") == "true":
            trf_file = f"./shared_storage/stabilize_{el.get('id')}.trf"
            if os.path.exists(trf_file):
                try:
                    os.remove(trf_file)
                except Exception:
                    pass

    if process.returncode == 0:
        print("EXPORT_SUCCESS")
    else:
        print(f"EXPORT_FAILED with code {process.returncode}")
        sys.exit(process.returncode)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python exporter.py <timeline_json_path> <output_path>")
        sys.exit(1)
    export_timeline(sys.argv[1], sys.argv[2])
