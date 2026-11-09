"""Measure every clip: focus, shake, exposure, faces, duplicates. Cut it into usable candidate shots.

Focus is judged three ways (calibrated on the account's own footage, see tests/):
  1. Absolute blur (Crete-Roffet "re-blur" metric, worst of horizontal/vertical so motion blur counts):
     a frame that barely changes when blurred further is already blurry.
  2. Relative to the clip's own best frames (contrast-normalised Laplacian): catches focus hunting
     and brief motion blur inside an otherwise sharp clip.
  3. On the face: if there's a face and it's much softer than the rest of the frame, the camera
     focused behind the subject.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import media

SAMPLE_FPS = 6
WORK_W = 360

# --- focus thresholds (see tests/test_focus.py for the labelled frames these come from)
BLUR_HARD = 0.465          # re-blur score above this = blurry, whatever the scene
BLUR_SOFT = 0.42           # above this AND low detail ratio = blurry
DETAIL_LOW = 0.08
REL_DETAIL = 0.33          # detail below 33% of the best nearby frames (+-1.5s, same scene) ...
REL_BLUR_MARGIN = 0.08     # ... and blur clearly worse than the best nearby = focus hunting / brief blur
REL_WINDOW = 9             # samples each side (1.5s at 6 fps)
FACE_REL = 0.15            # face this much blurrier than the clip's best face frames = focus slipped off the face
# --- motion / exposure
WHIP = 0.075               # > 7.5% of frame width per 1/6 s = whip pan
SHAKE_SOFT = 0.03          # high-frequency jitter above this = shaky
DARK, BRIGHT = 22, 238     # mean luma hard limits
MURKY_MEAN, MURKY_P95 = 62, 115  # dark AND no highlights = underexposed (real night shots keep bright lights)
EDGE_TRIM = 0.2            # skip the record-button tap at clip start/end
MIN_RUN = 0.6
MAX_CAND = 4.0

MODEL = Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx"


def blur_score(g: np.ndarray) -> float:
    """Crete-Roffet no-reference blur, 0 (sharp) .. 1 (blurry). Max over the two directions."""
    f = g.astype(np.float32)
    worst = 0.0
    for k in (np.ones((9, 1), np.float32) / 9, np.ones((1, 9), np.float32) / 9):
        axis = 0 if k.shape[0] == 9 else 1
        b = cv2.filter2D(f, -1, k, borderType=cv2.BORDER_REFLECT)
        d_f = np.abs(np.diff(f, axis=axis))
        d_b = np.abs(np.diff(b, axis=axis))
        s_f = float(d_f.sum())
        s_v = float(np.maximum(0, d_f - d_b).sum())
        worst = max(worst, (s_f - s_v) / max(s_f, 1e-6))
    return worst


def detail_ratio(g: np.ndarray) -> float:
    """75th percentile over a 4x4 grid of Laplacian variance / local variance (contrast-normalised detail)."""
    lap = cv2.Laplacian(g, cv2.CV_32F)
    h, w = g.shape
    r = []
    for y in range(0, h - h // 4 + 1, h // 4):
        for x in range(0, w - w // 4 + 1, w // 4):
            c = g[y:y + h // 4, x:x + w // 4].astype(np.float32)
            if c.std() > 6:
                r.append(lap[y:y + h // 4, x:x + w // 4].var() / (c.var() + 1e-3))
    return float(np.percentile(r, 75)) if r else 0.0


def _dhash(g: np.ndarray) -> int:
    s = cv2.resize(g, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (s[:, 1:] > s[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


class Faces:
    def __init__(self):
        self.det = cv2.FaceDetectorYN.create(str(MODEL), "", (WORK_W, 640), 0.6, 0.3, 50)
        self.size = None

    def __call__(self, rgb: np.ndarray):
        h, w = rgb.shape[:2]
        if self.size != (w, h):
            self.det.setInputSize((w, h))
            self.size = (w, h)
        _, faces = self.det.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        out = []
        if faces is not None:
            for f in faces:
                x, y, fw, fh = (float(v) for v in f[:4])
                out.append((x, y, fw, fh, float(f[-1])))
        return out


def measure_clip(info: dict) -> dict:
    """Per-frame metrics at SAMPLE_FPS."""
    faces = Faces()
    keys = ("t", "blur", "detail", "motion", "jitter", "bright", "p95", "clipped", "face", "face_cx", "face_cy",
            "face_blur", "nfaces", "hash")
    m = {k: [] for k in keys}
    prev, win, vecs = None, None, []
    for t, rgb in media.read_frames(info["path"], SAMPLE_FPS, WORK_W, gray=False, info=info):
        g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        H, W = g.shape
        m["t"].append(round(t, 3))
        m["blur"].append(round(blur_score(g), 4))
        m["detail"].append(round(detail_ratio(g), 4))
        m["bright"].append(round(float(g.mean()), 1))
        m["p95"].append(int(np.percentile(g, 95)))
        m["clipped"].append(round(float((g > 250).mean()), 4))
        small = cv2.resize(g, (180, int(180 * H / W)), interpolation=cv2.INTER_AREA).astype(np.float32)
        if win is None:
            win = cv2.createHanningWindow((small.shape[1], small.shape[0]), cv2.CV_32F)
        if prev is None:
            vecs.append((0.0, 0.0))
        else:
            (dx, dy), _ = cv2.phaseCorrelate(prev, small, win)
            vecs.append((dx / small.shape[1], dy / small.shape[1]))
        prev = small
        fs = [f for f in faces(rgb) if f[3] >= 0.06 * H]
        if fs:
            x, y, fw, fh, _ = max(fs, key=lambda f: f[2] * f[3])
            m["face"].append(round(fh / H, 3))
            m["face_cx"].append(round((x + fw / 2) / W, 3))
            m["face_cy"].append(round((y + fh / 2) / H, 3))
            x0, y0 = int(max(x, 0)), int(max(y, 0))
            x1, y1 = int(min(x + fw, W)), int(min(y + fh, H))
            m["face_blur"].append(round(blur_score(g[y0:y1, x0:x1]), 4) if (x1 - x0) > 16 and (y1 - y0) > 16 else None)
        else:
            m["face"].append(0.0)
            m["face_cx"].append(None)
            m["face_cy"].append(None)
            m["face_blur"].append(None)
        m["nfaces"].append(len(fs))
        m["hash"].append(_dhash(g))
    v = np.array(vecs) if vecs else np.zeros((0, 2))
    for i in range(len(v)):
        lo, hi = max(0, i - 2), min(len(v), i + 3)
        m["jitter"].append(round(float(np.linalg.norm(v[i] - np.median(v[lo:hi], axis=0))), 4))
    m["motion"] = [round(float(np.hypot(*x)), 4) for x in v]
    return m


def _relative_soft(det: np.ndarray, blur: np.ndarray, i: int) -> bool:
    lo, hi = max(0, i - REL_WINDOW), min(len(det), i + REL_WINDOW + 1)
    if hi - lo < 4:
        return False
    best_det = float(np.percentile(det[lo:hi], 80)) or 1e-3
    best_blur = float(np.percentile(blur[lo:hi], 20))
    return det[i] < REL_DETAIL * best_det and blur[i] > best_blur + REL_BLUR_MARGIN


def frame_verdicts(info: dict, m: dict) -> list[str | None]:
    """None = usable, otherwise the reason the frame is unusable."""
    n = len(m["t"])
    if not n:
        return []
    blur = np.array(m["blur"])
    det = np.array(m["detail"])
    fbs = [x for x in m["face_blur"] if x is not None]
    best_face = float(np.percentile(fbs, 20)) if len(fbs) >= 4 else None
    dur = info["duration"]
    out = []
    for i in range(n):
        t = m["t"][i]
        fb = m["face_blur"][i]
        if t < EDGE_TRIM or t > dur - EDGE_TRIM:
            r = "edge"
        elif blur[i] > BLUR_HARD or (blur[i] > BLUR_SOFT and det[i] < DETAIL_LOW):
            r = "out of focus / motion blur"
        elif _relative_soft(det, blur, i):
            r = "softer than the frames around it (focus hunting / motion)"
        elif fb is not None and best_face is not None and m["face"][i] > 0.12 and fb > best_face + FACE_REL:
            r = "face softer than elsewhere in the clip (focus slipped)"
        elif m["motion"][i] > WHIP:
            r = "whip pan"
        elif m["bright"][i] < DARK or (m["bright"][i] < MURKY_MEAN and m["p95"][i] < MURKY_P95):
            r = "too dark / underexposed"
        elif m["bright"][i] > BRIGHT or m["clipped"][i] > 0.35:
            r = "blown out"
        else:
            r = None
        out.append(r)
    # a single soft frame inside a good run isn't visible; don't split shots over it
    for i in range(1, n - 1):
        if out[i] and out[i] != "edge" and not out[i - 1] and not out[i + 1]:
            out[i] = None
    return out


def candidates_for(clip_id: str, info: dict, m: dict) -> tuple[list[dict], dict]:
    verdicts = frame_verdicts(info, m)
    n = len(verdicts)
    if n == 0:
        return [], {}
    dur = info["duration"]
    step = 1.0 / SAMPLE_FPS
    rejected: dict[str, int] = {}
    for r in verdicts:
        if r and r != "edge":
            rejected[r] = rejected.get(r, 0) + 1
    runs, i = [], 0
    while i < n:
        if verdicts[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and not verdicts[j + 1]:
            j += 1
        runs.append((i, j))
        i = j + 1
    cands = []
    for a, b in runs:
        t0, t1 = m["t"][a], min(m["t"][b] + step, dur - EDGE_TRIM / 2)
        if t1 - t0 < MIN_RUN:
            continue
        pieces = max(1, int(np.ceil((t1 - t0) / MAX_CAND)))
        edges = np.linspace(t0, t1, pieces + 1)
        for k in range(pieces):
            s0, s1 = float(edges[k]), float(edges[k + 1])
            idx = [x for x in range(a, b + 1) if s0 <= m["t"][x] < s1] or [a]
            focus = float(np.mean([np.clip(1 - (m["blur"][x] - 0.26) / 0.2, 0, 1) for x in idx]))
            mo = float(np.mean([m["motion"][x] for x in idx]))
            ji = float(np.mean([m["jitter"][x] for x in idx]))
            fa = float(np.median([m["face"][x] for x in idx]))
            cx = [m["face_cx"][x] for x in idx if m["face_cx"][x] is not None]
            stab = max(0.0, 1.0 - mo / WHIP)
            flags = []
            if ji > SHAKE_SOFT:
                flags.append("shaky")
            if fa == 0 and mo > 0.02:
                flags.append("moving, no face (likely walking/filler)")
            score = 0.4 * focus + 0.2 * stab + 0.25 * min(fa * 4, 1.0) + 0.15 * (1 - min(ji / SHAKE_SOFT, 1.0))
            mid = idx[len(idx) // 2]
            cands.append({
                "id": f"{clip_id}s{len(cands) + 1:02d}", "clip": clip_id,
                "start": round(s0, 3), "end": round(s1, 3), "dur": round(s1 - s0, 3),
                "focus": round(focus, 3), "stability": round(stab, 3), "jitter": round(ji, 4),
                "face": round(fa, 3), "faces": int(max(m["nfaces"][x] for x in idx)),
                "face_cx": round(float(np.median(cx)), 3) if cx else None,
                "score": round(score, 3), "flags": flags, "hash": m["hash"][mid],
                "run": [round(t0, 3), round(t1, 3)],
            })
    return cands, rejected


def mark_duplicates(cands: list[dict], max_dist: int = 6) -> None:
    """Near-identical candidates (re-takes, the same view held twice) -> keep the best one."""
    kept: list[dict] = []
    # best first; on (near) ties keep the earlier take
    for c in sorted(cands, key=lambda c: (-round(c["score"], 2), c["clip"], c["start"])):
        twin = next((k for k in kept if hamming(k["hash"], c["hash"]) <= max_dist), None)
        if twin is not None:
            c["duplicate_of"] = twin["id"]
            if "duplicate" not in c["flags"]:
                c["flags"].append("duplicate")
        else:
            kept.append(c)


def make_strip(info: dict, cand: dict, out: Path, tile_w: int = 300, metrics: dict | None = None) -> Path:
    """Three frames (start / middle / end) side by side - what the AI editor and the review page see.
    If there's a face, a 4th tile shows it cropped from the FULL-resolution frame, so focus on the
    person can actually be judged (a 300px thumbnail can't show a slightly missed focus)."""
    s, e = cand["start"], cand["end"]
    times = [s + 0.12, (s + e) / 2, max(s + 0.12, e - 0.15)]
    tiles = []
    for k, t in enumerate(times):
        p = out.with_name(f"{out.stem}_{k}.jpg")
        media.grab_jpg(info["path"], t, p, tile_w, info)
        tiles.append(Image.open(p).convert("RGB"))
        os.remove(p)
    h = max(t.height for t in tiles)
    face_tile = None
    if metrics and cand.get("face", 0) >= 0.06:
        mt = np.array(metrics["t"])
        idx = [i for i in range(len(mt)) if s <= mt[i] <= e and metrics["face_cx"][i] is not None]
        if idx:
            i = max(idx, key=lambda j: metrics["face"][j])
            p = out.with_name(f"{out.stem}_face.jpg")
            media.grab_jpg(info["path"], float(mt[i]), p, info["w"], info)   # full resolution
            full = Image.open(p).convert("RGB")
            os.remove(p)
            W, H = full.size
            side = int(min(max(metrics["face"][i] * H * 1.7, 64), W, H))
            cx, cy = metrics["face_cx"][i] * W, metrics["face_cy"][i] * H
            x0 = int(min(max(cx - side / 2, 0), W - side))
            y0 = int(min(max(cy - side / 2, 0), H - side))
            face_tile = full.crop((x0, y0, x0 + side, y0 + side))
            if side > h:
                face_tile = face_tile.resize((h, h), Image.LANCZOS)
    width = tile_w * 3 + 8 + ((face_tile.width + 12) if face_tile else 0)
    strip = Image.new("RGB", (width, h), (0, 0, 0))
    for k, t in enumerate(tiles):
        strip.paste(t, (k * (tile_w + 4), 0))
    if face_tile:
        strip.paste(face_tile, (tile_w * 3 + 20, (h - face_tile.height) // 2))
    strip.save(out, quality=88)
    return out


def analyze_clip(clip_id: str, info: dict, cache_dir: Path) -> dict:
    st = os.stat(info["path"])
    key = f"{st.st_size}-{int(st.st_mtime)}-v4"
    cache = cache_dir / f"{clip_id}.json"
    if cache.exists():
        d = json.loads(cache.read_text())
        if d.get("key") == key and d.get("path") == info["path"]:
            return d
    m = measure_clip(info)
    cands, rejected = candidates_for(clip_id, info, m)
    d = {"key": key, "path": info["path"], "metrics": m, "candidates": cands, "rejected_frames": rejected}
    cache.write_text(json.dumps(d))
    return d
