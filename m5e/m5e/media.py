"""ffmpeg/ffprobe helpers."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import numpy as np

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".hevc"}
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"}


def need(tool: str) -> str:
    p = shutil.which(tool)
    if not p:
        raise SystemExit(f"'{tool}' was not found. Install ffmpeg (it includes ffprobe) and try again.")
    return p


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, **kw)
    if r.returncode != 0:
        err = r.stderr.decode(errors="replace")[-2000:] if isinstance(r.stderr, bytes) else str(r.stderr)[-2000:]
        raise RuntimeError(f"command failed: {' '.join(map(str, cmd[:6]))} ...\n{err}")
    return r


def probe(path: str | Path) -> dict:
    need("ffprobe")
    r = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    d = json.loads(r.stdout)
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"
              and s.get("disposition", {}).get("attached_pic", 0) == 0), None)
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), None)
    fmt = d.get("format", {})
    out = {
        "path": str(path),
        "duration": float(fmt.get("duration") or (v or a or {}).get("duration") or 0),
        "has_video": v is not None,
        "has_audio": a is not None,
    }
    if v:
        w, h = int(v["width"]), int(v["height"])
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(round(float(sd["rotation"])))
        rot = rot or int((v.get("tags") or {}).get("rotate", 0) or 0)
        if abs(rot) % 180 == 90:
            w, h = h, w
        num, den = (v.get("avg_frame_rate") or "30/1").split("/")
        if not float(den) or not float(num):
            num, den = (v.get("r_frame_rate") or "30/1").split("/")
        fps = float(num) / float(den) if float(den) else 30.0
        trc = v.get("color_transfer", "")
        out.update(w=w, h=h, fps=fps, fps_num=int(num), fps_den=int(den), rotation=rot, pix_fmt=v.get("pix_fmt"),
                   hdr=trc in ("arib-std-b67", "smpte2084"), color_transfer=trc,
                   color_primaries=v.get("color_primaries", ""))
    tags = fmt.get("tags") or {}
    created = tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time")
    ts = None
    if created:
        try:
            ts = datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
        except ValueError:
            ts = None
    out["created"] = ts or os.path.getmtime(path)
    return out


@lru_cache(maxsize=1)
def has_filter(name: str) -> bool:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
    return any(line.split()[1:2] == [name] for line in r.stdout.splitlines() if len(line.split()) > 1)


def sdr_filter(info: dict) -> str:
    """Filter chain that brings HDR phone footage (iPhone HLG / Dolby Vision) into normal bt709 SDR.
    Without this, HDR clips come out grey and washed-out."""
    if not info.get("hdr"):
        return ""
    if has_filter("zscale") and has_filter("tonemap"):
        return ("zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,"
                "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    if has_filter("libplacebo"):
        return "libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:tonemapping=bt.2390"
    return "colorspace=all=bt709:iall=bt2020:fast=1"


def read_frames(path: str, fps: float, width: int, gray: bool = True, start: float = 0.0,
                duration: float | None = None, info: dict | None = None):
    """Decode frames as numpy arrays at a fixed sample rate. Rotation is applied by ffmpeg."""
    need("ffmpeg")
    info = info or probe(path)
    h = int(round(info["h"] * width / info["w"] / 2) * 2)
    pix = "gray" if gray else "rgb24"
    chans = 1 if gray else 3
    vf = ",".join(filter(None, [sdr_filter(info), f"fps={fps}", f"scale={width}:{h}:flags=area", f"format={pix}"]))
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vf", vf, "-f", "rawvideo", "-pix_fmt", pix, "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = width * h * chans
    i = 0
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            arr = np.frombuffer(buf, np.uint8).reshape((h, width) if gray else (h, width, 3))
            yield start + i / fps, arr
            i += 1
    finally:
        p.stdout.close()
        p.wait()


def read_audio(path: str, sr: int = 16000) -> np.ndarray:
    r = run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"])
    return np.frombuffer(r.stdout, np.float32)


def grab_jpg(path: str, t: float, out: Path, width: int, info: dict) -> Path:
    vf = ",".join(filter(None, [sdr_filter(info), f"scale={width}:-2"]))
    run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{max(t, 0):.3f}", "-i", path,
         "-frames:v", "1", "-vf", vf, "-q:v", "3", str(out)])
    return out
