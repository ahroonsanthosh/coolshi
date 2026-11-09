"""Reference video: "cut my clips like this one".

Measures the reference's cut rhythm, asks the AI to describe its editing style, and estimates its
look (contrast / saturation / brightness) so the grade can be nudged towards it.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image

from . import brain, media


def cut_times(path: str, threshold: float = 0.28) -> list[float]:
    r = media.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path, "-vf",
                   f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"])
    times = [float(m) for m in re.findall(r"pts_time:([0-9.]+)", r.stderr.decode(errors="replace"))]
    out = []
    for t in sorted(times):
        if not out or t - out[-1] > 0.2:   # a flash or a fast whip registers twice; ignore sub-0.2s blips
            out.append(t)
    return out


def rhythm(path: str) -> dict:
    info = media.probe(path)
    cuts = [t for t in cut_times(path) if 0.15 < t < info["duration"] - 0.15]
    edges = [0.0] + cuts + [info["duration"]]
    shots = [round(b - a, 3) for a, b in zip(edges, edges[1:]) if b - a > 0.05]
    arr = np.array(shots) if shots else np.array([info["duration"]])
    thirds = np.array_split(arr, 3) if len(arr) >= 3 else [arr]
    return {
        "duration": round(info["duration"], 2),
        "shots": shots,
        "count": len(shots),
        "mean": round(float(arr.mean()), 2),
        "median": round(float(np.median(arr)), 2),
        "p10": round(float(np.percentile(arr, 10)), 2),
        "p90": round(float(np.percentile(arr, 90)), 2),
        "by_third": [round(float(t.mean()), 2) for t in thirds if len(t)],
        "first_shot": shots[0] if shots else None,
        "cut_times": [round(t, 2) for t in cuts],
    }


def look(path: str, info: dict | None = None) -> dict:
    """Average saturation / contrast / brightness of a video (sampled at 2 fps)."""
    sats, cons, brs = [], [], []
    for _, f in media.read_frames(path, 2, 240, gray=False, info=info):
        x = f.astype(np.float32) / 255.0
        mx, mn = x.max(axis=2), x.min(axis=2)
        sats.append(float(((mx - mn) / (mx + 1e-4)).mean()))
        y = 0.2126 * x[..., 0] + 0.7152 * x[..., 1] + 0.0722 * x[..., 2]
        cons.append(float(y.std()))
        brs.append(float(y.mean()))
    if not sats:
        return {}
    return {"saturation": round(float(np.median(sats)), 4), "contrast": round(float(np.median(cons)), 4),
            "brightness": round(float(np.median(brs)), 4)}


def grade_towards(ref_look: dict, clip_looks: list[dict], base_grade: str) -> str:
    """Build an eq that moves the footage's average look part of the way towards the reference's.
    Deliberately gentle (50%, tight clamps): differences in brightness and colour are mostly about WHAT was filmed
    (night club vs daytime street), not how it was graded, so only nudge saturation/contrast and barely touch
    brightness."""
    if not ref_look or not clip_looks:
        return base_grade
    ours = {k: float(np.median([c[k] for c in clip_looks if k in c])) for k in ("saturation", "contrast", "brightness")}
    k = 0.5
    sat = 1 + k * (ref_look["saturation"] / max(ours["saturation"], 1e-3) - 1)
    con = 1 + k * (ref_look["contrast"] / max(ours["contrast"], 1e-3) - 1)
    bri = 0.3 * (ref_look["brightness"] - ours["brightness"])
    sat, con, bri = float(np.clip(sat, 0.9, 1.15)), float(np.clip(con, 0.92, 1.1)), float(np.clip(bri, -0.02, 0.02))
    return f"eq=contrast={con:.3f}:saturation={sat:.3f}:brightness={bri:.3f}"


def keyframe_sheet(path: str, rh: dict, out: Path, info: dict) -> Path:
    """One frame from the middle of each shot (up to 40), tiled, with shot number and length."""
    edges = [0.0] + rh["cut_times"] + [rh["duration"]]
    mids = [((a + b) / 2, b - a) for a, b in zip(edges, edges[1:])][:40]
    tiles = []
    for i, (t, d) in enumerate(mids):
        p = out.with_name(f"{out.stem}_{i:02d}.jpg")
        media.grab_jpg(path, t, p, 150, info)
        im = Image.open(p).convert("RGB")
        tiles.append((im, i, d))
        os.remove(p)
    cols = 8
    w = 150
    h = max(im.height for im, _, _ in tiles) if tiles else 267
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 4), rows * (h + 22)), (0, 0, 0))
    from PIL import ImageDraw
    draw = ImageDraw.Draw(sheet)
    for im, i, d in tiles:
        x, y = (i % cols) * (w + 4), (i // cols) * (h + 22)
        sheet.paste(im, (x, y + 20))
        draw.text((x + 2, y + 2), f"#{i} {d:.1f}s", fill=(255, 255, 0))
    sheet.save(out, quality=85)
    return out


def load(path: str, work: Path, transcribe_fn, log=print) -> dict:
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:12]
    cache = work / "reference.json"
    if cache.exists():
        d = json.loads(cache.read_text())
        if d.get("key") == key:
            return d
    log(f"Studying the reference video {Path(path).name}...")
    info = media.probe(path)
    rh = rhythm(path)
    lk = look(path, info)
    words = transcribe_fn(path) if info.get("has_audio") else []
    d = {"key": key, "path": path, "rhythm": rh, "look": lk,
         "transcript": " ".join(w["w"] for w in words), "profile": None}
    if brain.available():
        sheet = keyframe_sheet(path, rh, work / "reference_sheet.jpg", info)
        try:
            d["profile"] = brain.study_reference(sheet, rh, d["transcript"]).model_dump()
        except brain.BrainError as e:
            log(f"  couldn't get the AI's read of the reference ({e}); using its rhythm only")
    cache.write_text(json.dumps(d, indent=1))
    log(f"  {rh['count']} shots in {rh['duration']:.1f}s: median {rh['median']}s, "
        f"by thirds {rh['by_third']}")
    return d


def style_text(ref: dict) -> str:
    """What the AI editor and reviewer are told about the reference."""
    if not ref:
        return ""
    rh = ref["rhythm"]
    lines = [f"REFERENCE VIDEO TO EMULATE: {rh['count']} shots in {rh['duration']}s; shot length median {rh['median']}s "
             f"(10th-90th pct {rh['p10']}-{rh['p90']}s); average by thirds {rh['by_third']}; first shot {rh['first_shot']}s.",
             f"Its shot lengths in order: {rh['shots'][:60]}"]
    p = ref.get("profile")
    if p:
        lines.append(f"How it's edited: {p['summary']}")
        lines.append(f"Hook: {p['hook']}. Structure: {p['structure']}. Shot mix: {p['shot_mix']}. "
                     f"Camera: {p['camera']}. Energy: {p['energy_curve']}.")
        lines.append("Rules to copy: " + " | ".join(p["rules"]))
    lines.append("Match this rhythm and approach with our footage; keep our caption style and our story.")
    return "\n".join(lines)
