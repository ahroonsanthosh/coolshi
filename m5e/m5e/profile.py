"""Editing profile: how a particular editor cuts, measured from their own published reels.

`python -m m5e learn <folder of reels>` writes a profile; m5e then cuts new footage with that
rhythm (by position in the video), opening, ending, burst habits and music level.

The shipped profile `profiles/krios.json` was measured from 13 @kriosfounders voiceover reels,
weighted towards the best performers.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import media, reference

PROFILES = Path(__file__).parent / "profiles"
BINS = 10


def _bursts(shots: list[float], short: float = 0.6, run: int = 3) -> int:
    n, i = 0, 0
    while i < len(shots):
        j = i
        while j < len(shots) and shots[j] < short:
            j += 1
        if j - i >= run:
            n += 1
        i = max(j, i + 1)
    return n


def measure_reel(path: str, transcribe_fn=None) -> dict | None:
    rh = reference.rhythm(path)
    if rh["count"] < 4:            # a single-take skit has no cutting style to learn
        return None
    shots = rh["shots"]
    edges = np.cumsum([0.0] + shots)
    curve = []
    for b in range(BINS):
        lo, hi = b / BINS * rh["duration"], (b + 1) / BINS * rh["duration"]
        inside = [s for s, a in zip(shots, edges[:-1]) if lo <= a + s / 2 < hi]
        curve.append(float(np.median(inside)) if inside else None)
    rec = {"path": path, "duration": rh["duration"], "count": rh["count"], "median": rh["median"],
           "p10": rh["p10"], "p90": rh["p90"], "first": shots[0], "last": shots[-1], "curve": curve,
           "bursts": _bursts(shots), "short_frac": float(np.mean(np.array(shots) < 0.6))}
    if transcribe_fn is not None:
        words = transcribe_fn(path)
        if words:
            a = media.read_audio(path)
            sr = 16000
            speech = np.concatenate([a[int(w["s"] * sr):int(w["e"] * sr)] for w in words])
            gaps = [(words[k]["e"] + 0.05, words[k + 1]["s"] - 0.05) for k in range(len(words) - 1)
                    if words[k + 1]["s"] - words[k]["e"] > 0.25]
            if gaps:
                g = np.concatenate([a[int(x * sr):int(y * sr)] for x, y in gaps])

                def db(x):
                    return float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9))
                rec["bed_db"] = round(db(g) - db(speech), 1)   # level of what's under the voice, relative
            rec["words"] = len(words)
    return rec


def build(records: list[dict], weights: list[float] | None = None, name: str = "custom") -> dict:
    recs = [r for r in records if r]
    if not recs:
        raise SystemExit("No reels with enough cuts to learn from.")
    w = np.array(weights if weights else [1.0] * len(recs), dtype=float)
    w = w / w.sum()

    def wmedian(vals, ws):
        pairs = sorted((v, x) for v, x in zip(vals, ws) if v is not None)
        if not pairs:
            return None
        cum, half = 0.0, sum(x for _, x in pairs) / 2
        for v, x in pairs:
            cum += x
            if cum >= half:
                return float(v)
        return float(pairs[-1][0])

    curve = [round(wmedian([r["curve"][b] for r in recs], w), 3) for b in range(BINS)]
    # smooth one-off spikes (a single reel's long talking-head hold shouldn't become a rule), keep the opening
    smooth = [curve[0]] + [round(float(np.median([x for x in curve[max(0, b - 1):b + 2] if x is not None])), 3)
                           for b in range(1, BINS)]
    beds = [r.get("bed_db") for r in recs]
    return {
        "name": name,
        "reels": len(recs),
        "median_shot": round(wmedian([r["median"] for r in recs], w), 3),
        "p10": round(wmedian([r["p10"] for r in recs], w), 3),
        "p90": round(wmedian([r["p90"] for r in recs], w), 3),
        "curve": smooth,                                   # median shot length by tenth of the video (smoothed)
        "curve_raw": curve,
        "first_shot": round(wmedian([r["first"] for r in recs], w), 3),
        "last_shot": round(wmedian([r["last"] for r in recs], w), 3),
        "bursts_per_reel": round(float(np.average([r["bursts"] for r in recs], weights=w)), 2),
        "short_shot_frac": round(float(np.average([r["short_frac"] for r in recs], weights=w)), 3),
        "music_bed_db": round(wmedian(beds, w), 1) if any(b is not None for b in beds) else None,
    }


def load(name_or_path: str | None) -> dict | None:
    if not name_or_path:
        return None
    p = Path(name_or_path)
    if not p.suffix:
        p = PROFILES / f"{name_or_path}.json"
    if not p.exists():
        raise SystemExit(f"Editing profile not found: {p}")
    return json.loads(p.read_text())


def describe(profile: dict) -> str:
    c = profile["curve"]
    vals = [x for x in c if x]
    mid = float(np.median(vals[2:8])) if len(vals) >= 8 else profile["median_shot"]
    shape = ("it opens fast and settles" if vals and vals[0] < 0.8 * mid else
             "it opens slow and speeds up" if vals and vals[0] > 1.2 * mid else "an even rhythm throughout")
    ending = " (a held ending)" if profile["last_shot"] > 1.3 * profile["median_shot"] else ""
    return (f"EDITING PROFILE '{profile['name']}' (measured from {profile['reels']} of the creator's reels): "
            f"median shot {profile['median_shot']}s (10th-90th pct {profile['p10']}-{profile['p90']}s); "
            f"shot length by tenth of the video {c} - {shape}; first shot about "
            f"{profile['first_shot']}s; last shot about {profile['last_shot']}s{ending}; "
            f"{profile['bursts_per_reel']} quick-cut bursts per reel, {round(profile['short_shot_frac'] * 100)}% of "
            f"shots under 0.6s."
            + (f" Music sits about {abs(profile['music_bed_db'])} dB under the voice." if profile.get("music_bed_db") else ""))
