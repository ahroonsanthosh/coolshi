"""Objective checks of a cut - the things a good editor looks at - for the report, the review page and the
AI reviewer."""
from __future__ import annotations

import numpy as np

from . import plan, story
from .analyze import hamming
from .style import FPS


def _kendall(a: list[float]) -> float:
    """1.0 = perfectly in order, 0 = random, -1 = reversed."""
    n = len(a)
    if n < 3:
        return 1.0
    s = 0
    for i in range(n):
        for j in range(i + 1, n):
            s += np.sign(a[j] - a[i])
    return float(s / (n * (n - 1) / 2))


def measure(timeline, words, cands, notes, clip_order, profile=None, music_beats=None, sfx=None) -> dict:
    by_id = {c["id"]: c for c in cands}
    d = [s["frames"] / FPS for s in timeline]
    t0s = [s["f0"] / FPS for s in timeline]
    total = (timeline[-1]["f0"] + timeline[-1]["frames"]) / FPS if timeline else 0.0
    m = {"shots": len(d), "length_s": round(total, 2), "median_shot": round(float(np.median(d)), 2) if d else 0,
         "first_shot": round(d[0], 2) if d else 0, "last_shot": round(d[-1], 2) if d else 0}
    if len(d) >= 3:
        m["by_third"] = [round(float(x.mean()), 2) for x in np.array_split(np.array(d), 3)]
    if profile and d:
        curve = profile["curve"]
        diffs = []
        for b in range(len(curve)):
            lo, hi = b / len(curve) * total, (b + 1) / len(curve) * total
            inside = [x for x, t in zip(d, t0s) if lo <= t + x / 2 < hi and not timeline[t0s.index(t)].get("burst_part")]
            if inside and curve[b]:
                diffs.append(abs(float(np.median(inside)) - curve[b]))
        m["rhythm_vs_profile_s"] = round(float(np.mean(diffs)), 2) if diffs else None
    cuts = [s for s in timeline[1:] if not s.get("burst_part")]
    if words:
        ons = plan.onsets(words)
        m["cuts_on_words"] = round(sum(min(abs(s["f0"] / FPS - o) for o in ons) <= 1.01 / FPS for s in cuts)
                                   / max(len(cuts), 1), 2)
        clause = [ons[b["i0"]] for b in story.beats(words)]
        m["cuts_on_clause_starts"] = round(sum(min(abs(s["f0"] / FPS - o) for o in clause) <= 1.01 / FPS for s in cuts)
                                           / max(len(cuts), 1), 2)
    if music_beats is not None and len(music_beats) > 1:
        bt = np.asarray(music_beats)
        grid = np.sort(np.concatenate([bt, bt[:-1] + np.diff(bt) / 2]))
        m["cuts_on_beat_grid"] = round(float(np.mean([np.min(np.abs(grid - s["f0"] / FPS)) <= 0.04
                                                       for s in timeline[1:]])), 2)
    groups, prev = 0, False
    for s in timeline:
        if s.get("burst_part") and not prev:
            groups += 1
        prev = bool(s.get("burst_part"))
    m["bursts"] = groups
    sfx = sfx or []
    kinds: dict[str, int] = {}
    for x in sfx:
        kinds[x["type"]] = kinds.get(x["type"], 0) + 1
    m["sfx"] = kinds
    m["sfx_on_non_burst_cuts"] = round(sum(1 for x in sfx if x["type"] not in ("click", "pop")) / max(len(cuts), 1), 2)
    pics = [(s.get("v_clip", s["clip"]), s.get("v_src_in", s["src_in"]), s["frames"] / FPS) for s in timeline]
    m["repeated_moments"] = sum(1 for i, a in enumerate(pics) for b in pics[i + 1:]
                                if a[0] == b[0] and a[1] < b[1] + b[2] - 0.02 and b[1] < a[1] + a[2] - 0.02)
    m["covers"] = sum(1 for s in timeline if "cover" in s.get("why", ""))
    sim = 0
    for a, b in zip(timeline, timeline[1:]):
        ca, cb = by_id.get(a.get("shot") or ""), by_id.get(b.get("shot") or "")
        if ca and cb and ca["id"] != cb["id"] and hamming(ca["hash"], cb["hash"]) <= 12:
            sim += 1
    m["near_identical_back_to_back"] = sim
    order = [(clip_order.get(s.get("v_clip", s["clip"]), 0), s.get("v_src_in", s["src_in"])) for s in timeline[1:]]
    m["chronology"] = round(_kendall([o[0] * 1000 + o[1] for o in order]), 2)
    last = by_id.get(timeline[-1].get("shot") or "") if timeline else None
    first = by_id.get(timeline[0].get("shot") or "") if timeline else None
    m["opens_on_face"] = bool(first and first["face"] >= 0.08)
    m["ends_on_face"] = bool(last and last["face"] >= 0.08)
    filler = 0.0
    for s in timeline:
        c = by_id.get(s.get("shot") or "")
        n = notes.get(s.get("shot") or "", {})
        if (c and "moving, no face (likely walking/filler)" in c["flags"]) or n.get("filler") or \
                n.get("shot_type") == "walking away / back of head":
            filler += s["frames"] / FPS
    m["filler_seconds"] = round(filler, 2)
    return m


def as_text(m: dict) -> str:
    out = [f"{m['shots']} shots in {m['length_s']}s; median shot {m['median_shot']}s; first {m['first_shot']}s; "
           f"last {m['last_shot']}s; by thirds {m.get('by_third')}"]
    if m.get("rhythm_vs_profile_s") is not None:
        out.append(f"rhythm vs the creator's profile: off by {m['rhythm_vs_profile_s']}s per tenth on average")
    if "cuts_on_words" in m:
        out.append(f"cuts landing on a word onset: {round(m['cuts_on_words'] * 100)}%; on a clause start: "
                   f"{round(m['cuts_on_clause_starts'] * 100)}%")
    if "cuts_on_beat_grid" in m:
        out.append(f"cuts on the music's beat grid: {round(m['cuts_on_beat_grid'] * 100)}%")
    out.append(f"bursts: {m['bursts']}; sound effects: {m['sfx'] or 'none'}")
    out.append(f"chronology (1 = the day in order): {m['chronology']}; opens on a face: {m['opens_on_face']}; "
               f"ends on a face: {m['ends_on_face']}")
    out.append(f"near-identical shots back to back: {m['near_identical_back_to_back']}; repeated moments: "
               f"{m['repeated_moments']}; covering shots (planned shot ran out): {m['covers']}; "
               f"filler on screen: {m['filler_seconds']}s")
    return "\n".join(out)
