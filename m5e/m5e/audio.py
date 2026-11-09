"""Voiceover prep: tighten pauses (cut on the quietest 10ms near each join) and remap word timings."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from . import media
from .style import TARGET_LUFS, VO_FILTER, VO_HEAD, VO_KEEP_PAUSE, VO_MAX_PAUSE

SR = 48000
AFTER_WORD = 0.11    # keep this much after a word ends (whisper ends can be a touch early)
BEFORE_WORD = 0.06   # and this much before the next one starts


def _quietest(x: np.ndarray, t: float, search: float = 0.04) -> float:
    a, b = int(max(t - search, 0) * SR), int(min(t + search, len(x) / SR) * SR)
    if b - a < 480:
        return t
    win = 480  # 10 ms
    seg = x[a:b]
    e = np.convolve(seg ** 2, np.ones(win), "valid")
    return (a + int(np.argmin(e)) + win // 2) / SR


def keep_ranges(words: list[dict], dur: float, max_pause=VO_MAX_PAUSE) -> list[tuple[float, float]]:
    if not words:
        return [(0.0, dur)]
    start = max(0.0, words[0]["s"] - VO_HEAD)
    ranges = []
    cur = start
    for a, b in zip(words, words[1:]):
        gap = b["s"] - a["e"]
        if gap > max_pause and gap > AFTER_WORD + BEFORE_WORD + 0.02:
            cut0 = a["e"] + AFTER_WORD
            cut1 = b["s"] - BEFORE_WORD
            # leave a natural pause of ~VO_KEEP_PAUSE in total
            extra = VO_KEEP_PAUSE - (AFTER_WORD + BEFORE_WORD)
            if extra > 0:
                cut1 -= extra
            if cut1 > cut0 + 0.03:
                ranges.append((cur, cut0))
                cur = cut1
    ranges.append((cur, min(dur, words[-1]["e"] + 0.3)))
    return ranges


def tighten(src: str, words: list[dict], out: Path, enabled: bool = True) -> tuple[Path, list[dict], float]:
    x = media.read_audio(src, SR)
    dur = len(x) / SR
    ranges = keep_ranges(words, dur) if enabled else [(max(0.0, words[0]["s"] - VO_HEAD) if words else 0.0, dur)]
    ranges = [(_quietest(x, a) if i else a, _quietest(x, b) if i < len(ranges) - 1 else b)
              for i, (a, b) in enumerate(ranges)]
    fade = int(0.008 * SR)
    pieces = []
    for a, b in ranges:
        seg = x[int(a * SR):int(b * SR)].copy()
        if len(seg) > 2 * fade:
            seg[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
            seg[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        pieces.append(seg)
    y = np.concatenate(pieces) if pieces else x
    # remap word times onto the tightened timeline
    offsets = []
    acc = 0.0
    for a, b in ranges:
        offsets.append((a, b, acc))
        acc += b - a
    new_words = []
    for w in words:
        for a, b, o in offsets:
            if a - 0.02 <= w["s"] <= b + 0.02:
                s = o + max(w["s"] - a, 0)
                e = o + min(w["e"], b) - a
                new_words.append({**w, "s": round(s, 3), "e": round(max(e, s + 0.05), 3)})
                break
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                          "-c:a", "pcm_s24le", str(out)], stdin=subprocess.PIPE)
    p.communicate(y.astype(np.float32).tobytes())
    return out, new_words, len(y) / SR


def loudnorm_filter(path: str, pre: str = "") -> str:
    """Two-pass EBU R128 so the result lands on -14 LUFS without pumping."""
    chain = ",".join(filter(None, [pre, f"loudnorm=I={TARGET_LUFS}:TP=-1.0:LRA=9:print_format=json"]))
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", chain, "-f", "null", "-"],
                       capture_output=True, text=True)
    txt = r.stderr
    try:
        j = json.loads(txt[txt.rindex("{"):txt.rindex("}") + 1])
        meas = (f"measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:"
                f"measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true")
        return ",".join(filter(None, [pre, f"loudnorm=I={TARGET_LUFS}:TP=-1.0:LRA=9:{meas}"]))
    except (ValueError, KeyError):
        return ",".join(filter(None, [pre, f"loudnorm=I={TARGET_LUFS}:TP=-1.0:LRA=9"]))


def vo_chain(path: str) -> str:
    return loudnorm_filter(path, VO_FILTER)
