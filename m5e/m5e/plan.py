"""Turn an edit plan (from the AI editor or the rule-based fallback) into an exact timeline,
repairing anything that doesn't fit (shot too short, cut too tight, banned shot)."""
from __future__ import annotations

import numpy as np

from .style import CUT_LEAD, MAX_SHOT, MIN_SHOT


def eligible(cands: list[dict], notes: dict, banned: set, strict: bool = True) -> list[dict]:
    out = []
    for c in cands:
        if c["id"] in banned or "duplicate" in c["flags"] or "low-res crop" in c["flags"]:
            continue
        n = notes.get(c["id"])
        if strict and n and (not n.get("focus_ok", True) or n.get("filler")):
            continue
        if strict and c["score"] < 0.35:
            continue
        out.append(c)
    return out


class Footage:
    """Keeps track of which seconds of every clean run have already been shown, so the same frames
    never appear twice, and picks the best window (sharpest, steadiest, faces) inside what's left."""

    PAD = 0.15  # don't reuse frames this close to something already shown

    def __init__(self, cands: list[dict], metrics: dict, notes: dict):
        self.by_id = {c["id"]: c for c in cands}
        self.metrics = metrics
        self.notes = notes
        self.used: dict[tuple, list[tuple[float, float]]] = {}
        self.reused = 0

    @staticmethod
    def _key(c):
        return (c["clip"], c["run"][0])

    def free(self, c) -> list[tuple[float, float]]:
        r0, r1 = c["run"]
        ivs = [(r0, r1)]
        for a, b in sorted(self.used.get(self._key(c), [])):
            a, b = a - self.PAD, b + self.PAD
            nxt = []
            for x, y in ivs:
                if b <= x or a >= y:
                    nxt.append((x, y))
                else:
                    if a > x:
                        nxt.append((x, a))
                    if b < y:
                        nxt.append((b, y))
            ivs = nxt
        return [(x, y) for x, y in ivs if y - x > 0.05]

    def free_len(self, c) -> float:
        return max((y - x for x, y in self.free(c)), default=0.0)

    def _score_window(self, c, st, dur):
        m = self.metrics.get(c["clip"])
        if not m or not m.get("t"):
            return 0.0
        t = np.asarray(m["t"])
        sel = (t >= st) & (t < st + dur)
        if not sel.any():
            return -1.0
        bl = np.asarray(m["blur"])[sel].mean()
        mo = np.asarray(m["motion"])[sel].mean()
        fa = np.asarray(m["face"])[sel].mean()
        return float(-bl - 2 * mo + 0.3 * min(fa * 4, 1))

    def take(self, c, dur: float, offset: float | None = None, allow_overlap: bool = False) -> float:
        """Reserve `dur` seconds of this candidate; returns the source in-point."""
        spans = [(x, y) for x, y in self.free(c) if y - x >= dur - 1e-3]
        if not spans:
            if not allow_overlap:
                raise ValueError("not enough unused footage in this shot")
            self.reused += 1
            r0, r1 = c["run"]
            dur = min(dur, r1 - r0)
            used = self.used.get(self._key(c), [])
            best = min(np.arange(r0, r1 - dur + 1e-6, 1 / 6) if r1 - r0 > dur else [r0],
                       key=lambda st: sum(max(0.0, min(st + dur, b) - max(st, a)) for a, b in used))
            best = float(best)
            self.used.setdefault(self._key(c), []).append((best, best + dur))
            return round(best, 3)
        note = self.notes.get(c["id"], {})
        best, best_v = None, -1e9
        for x, y in spans:
            lo, hi = x, y - dur
            if offset is not None and lo - 1e-3 <= c["start"] + offset <= hi + 1e-3:
                best = float(np.clip(c["start"] + offset, lo, hi))
                break
            # prefer the candidate's own range, and the part the AI said is best
            pref = {"start": c["start"], "end": c["end"] - dur}.get(note.get("best_part"))
            for st in np.arange(lo, hi + 1e-6, 1 / 6):
                v = self._score_window(c, st, dur)
                v -= 0.05 * max(0.0, c["start"] - st) + 0.05 * max(0.0, st + dur - c["end"])
                if pref is not None:
                    v -= 0.1 * abs(st - pref)
                if v > best_v:
                    best, best_v = float(st), v
        if best is None:
            best = spans[0][0]
        self.used.setdefault(self._key(c), []).append((best, best + dur))
        return round(best, 3)


# ---------------------------------------------------------------------------------------------
# Voiceover mode
# ---------------------------------------------------------------------------------------------

def onsets(words: list[dict]) -> list[float]:
    return [max(w["s"] - CUT_LEAD, 0.0) for w in words]


def cut_points(words: list[dict], vo_dur: float, pace: float, template: list[float] | None = None) -> list[float]:
    """Cut times on word onsets, aiming at `pace` seconds per shot (or following a reference video's
    rhythm, mapped by position: the first 10% of ours follows the first 10% of the reference), preferring
    clause starts."""
    ons = onsets(words)
    pace_at = pace_curve(vo_dur, pace, template)
    cuts = [0.0]
    t = 0.0
    while True:
        step = pace_at(t)
        if vo_dur - t < step * 1.5:
            break
        best, best_cost = None, 1e9
        for i, o in enumerate(ons):
            if o < t + MIN_SHOT or o > t + MAX_SHOT or vo_dur - o < MIN_SHOT:
                continue
            cost = abs(o - (t + step))
            if i > 0 and words[i - 1]["w"].endswith((".", ",", "?", "!", ";", ":")):
                cost -= min(0.25 * step, 0.35)  # prefer the start of a clause, in proportion to the shot
            if cost < best_cost:
                best, best_cost = o, cost
        if best is None:
            break
        cuts.append(best)
        t = best
    return cuts


def heuristic_vo(words, vo_dur, cands, notes, metrics_by_clip, clip_order, pace, banned=(), must=(), template=None):
    """Rule-based editor: strongest opener first, then the best shot from each stretch of the day, in order."""
    pool = eligible(cands, notes, set(banned)) or eligible(cands, notes, set(banned), strict=False)
    if not pool:
        raise RuntimeError("No usable footage: every clip was out of focus, too dark or too shaky.")
    cuts = cut_points(words, vo_dur, pace, template)
    if len(pool) < len(cuts):
        cuts = cut_points(words, vo_dur, vo_dur / len(pool))
    pool.sort(key=lambda c: (clip_order[c["clip"]], c["start"]))

    def hook_val(c):
        n = notes.get(c["id"], {})
        return n.get("hook", 0) * 0.3 + min(c["face"] * 4, 1) + c["score"]

    hook = max(pool, key=hook_val)
    rest = [c for c in pool if c is not hook]
    must_ids = set(must)
    picks = []
    if len(cuts) > 1 and rest:
        for b in np.array_split(np.arange(len(rest)), min(len(cuts) - 1, len(rest))):
            if len(b):
                picks.append(max((rest[i] for i in b), key=lambda c: c["score"]))
    for c in (c for c in rest if c["id"] in must_ids and c not in picks):
        weakest = min((p for p in picks if p["id"] not in must_ids), key=lambda p: p["score"], default=None)
        if weakest is not None:
            picks[picks.index(weakest)] = c
    picks.sort(key=lambda c: (clip_order[c["clip"]], c["start"]))
    # end on a face, not on a corridor: pull the best face shot from the last third of the day to the end
    if len(picks) >= 3 and (picks[-1]["face"] < 0.08 or picks[-1]["run"][1] - picks[-1]["run"][0] < 1.2):
        tail = picks[-max(2, len(picks) // 3):]
        # it has to be able to hold the ending, not just flash by
        face = max((c for c in tail if c["face"] >= 0.08 and c["run"][1] - c["run"][0] >= 1.2),
                   key=lambda c: (c["face"], c["score"]), default=None)
        if face is not None:
            picks.remove(face)
            picks.append(face)
    chosen = [hook] + picks
    return [{"t0": cuts[i], "shot": chosen[i]["id"], "offset": None, "why": "auto"}
            for i in range(min(len(cuts), len(chosen)))]


def vo_plan_to_seq(segs: list[dict], words: list[dict]) -> list[dict]:
    """AI plans name the word a shot starts on; convert to times."""
    ons = onsets(words)
    out = []
    for s in sorted(segs, key=lambda s: s["from_word"]):
        if 0 <= s["from_word"] < len(ons):
            out.append({**s, "t0": 0.0 if not out else ons[s["from_word"]]})
    return out


def pace_curve(vo_dur: float, pace: float, template: list[float] | None):
    """Target shot length at time t: flat `pace`, or a reference video's rhythm stretched to this length."""
    if not template:
        return lambda t: pace
    tpl = [min(max(x, MIN_SHOT), MAX_SHOT) for x in template]
    total = sum(tpl)
    edges = np.cumsum([0.0] + tpl) / total
    # keep the reference's shot lengths if the lengths are similar; stretch them if ours is much longer/shorter
    scale = vo_dur / total if (total > vo_dur * 1.25 or total < vo_dur * 0.8) else 1.0

    def at(t):
        f = min(max(t / max(vo_dur, 1e-6), 0.0), 0.999)
        i = int(np.searchsorted(edges, f, side="right") - 1)
        return min(max(tpl[min(i, len(tpl) - 1)] * scale, MIN_SHOT), MAX_SHOT)
    return at


def build_vo_timeline(seq, words, vo_dur, cands, notes, metrics_by_clip, banned=(), pace: float = 1.4,
                      template: list[float] | None = None):
    """Fit a planned sequence of shots to the voiceover.
    - No shot runs longer than MAX_SHOT; cuts land on word onsets wherever possible.
    - If a shot has less clean footage than its slot, the cut moves earlier to a word onset where it fits,
      and the gap is covered with the best unused footage.
    - Nothing is shown twice unless the footage genuinely runs out; then reuse is spread across all shots,
      longest-unseen first, using a different part of the clip each time.
    Returns (timeline, warnings)."""
    fo = Footage(cands, metrics_by_clip, notes)
    banned = set(banned)
    pace_at = pace_curve(vo_dur, pace, template)
    seq = sorted((s for s in seq if s["shot"] in fo.by_id and s["shot"] not in banned), key=lambda s: s["t0"])
    if seq:
        seq[0] = {**seq[0], "t0": 0.0}
    ons = onsets(words)
    pool = eligible(cands, notes, banned) or eligible(cands, notes, banned, strict=False)
    order = {c["id"]: i for i, c in enumerate(sorted(cands, key=lambda c: (c["clip"], c["start"])))}
    timeline: list[dict] = []
    last_seen: dict[str, float] = {}
    t = 0.0

    def snap(lo, hi, target):
        opts = [o for o in ons if lo - 1e-6 <= o <= hi + 1e-6]
        return min(opts, key=lambda o: abs(o - target)) if opts else None

    def place(c, end, why, offset=None, overlap=False):
        nonlocal t
        dur = round(end - t, 3)
        src = fo.take(c, dur, offset, allow_overlap=overlap)
        dur = min(dur, round(c["run"][1] - src, 3)) if overlap else dur
        end = t + dur
        timeline.append({"shot": c["id"], "clip": c["clip"], "src_in": src, "dur": round(dur, 3),
                         "t0": round(t, 3), "t1": round(end, 3), "why": why, "face_cx": c.get("face_cx")})
        last_seen[c["id"]] = end
        t = end

    def end_for(avail, limit):
        """Where to cut a shot that starts at t, has `avail` seconds, and must end by `limit`."""
        hard = min(limit, t + MAX_SHOT, t + avail, vo_dur)
        if hard >= limit - 1e-6:
            return limit
        tgt = min(t + pace_at(t), hard)
        e = snap(t + MIN_SHOT, hard, tgt)
        e = e if e is not None else hard
        # don't leave a sliver too short to be its own shot: run on to the limit if the footage allows
        if limit - e < MIN_SHOT and t + avail >= limit and limit - t <= MAX_SHOT + MIN_SHOT:
            return limit
        return e

    def fill_one(limit, why, reserved=frozenset()):
        """Cover [t, limit) with one shot of fresh footage (or the least-recently-seen one).
        Shots the plan still needs later are left alone unless there's nothing else."""
        recent = [x["shot"] for x in timeline[-3:]]
        options = [c for c in pool if c["id"] not in recent] or [c for c in pool if not timeline or c["id"] != timeline[-1]["shot"]] or pool
        fresh = [c for c in options if fo.free_len(c) >= min(MIN_SHOT, limit - t)]
        fresh = [c for c in fresh if c["id"] not in reserved] or fresh
        last_slot = limit >= vo_dur - 1e-6 and t + pace_at(t) >= vo_dur - MIN_SHOT
        prev = fo.by_id[timeline[-1]["shot"]] if timeline else None
        if fresh:
            here = order.get(prev["id"], 0) if prev is not None else 0

            def rank(c):  # good footage from the same part of the day as what's on screen
                same = 0.1 if prev is not None and c["clip"] == prev["clip"] else 0.0
                p = pace_at(t)
                end_on_face = 0.6 * min(c["face"] * 4, 1) if last_slot else 0.0  # finish on a face
                return (c["score"] + same + 0.15 * min(fo.free_len(c), p) / p + end_on_face
                        - 0.06 * abs(order.get(c["id"], 0) - here))
            c = max(fresh, key=rank)
            place(c, end_for(fo.free_len(c), limit), why)
        else:
            c = max(options, key=lambda c: c["score"] + 0.5 * min((t - last_seen.get(c["id"], -99)) / 10, 1))
            place(c, end_for(c["run"][1] - c["run"][0], limit), why + " (reused)", overlap=True)

    for k, s in enumerate(seq):
        if vo_dur - t < 1.0 / 60:
            break
        nxt = seq[k + 1]["t0"] if k + 1 < len(seq) else vo_dur
        nxt = min(max(nxt, t), vo_dur)
        c = fo.by_id[s["shot"]]
        avail = fo.free_len(c)
        if avail < MIN_SHOT or (timeline and timeline[-1]["shot"] == c["id"]):
            continue
        if nxt - t < MIN_SHOT and k + 1 < len(seq):
            continue  # slot too small; the next planned shot starts here instead
        place(c, end_for(avail, nxt), s.get("why", ""), s.get("offset"))
        later = frozenset(x["shot"] for x in seq[k + 1:])
        guard = 0
        while nxt - t >= MIN_SHOT and guard < 50:  # shot ran out early: cover the rest of its slot
            guard += 1
            fill_one(nxt, "cover: the planned shot ran out of clean footage", later)
    guard = 0
    while vo_dur - t >= MIN_SHOT and guard < 300:
        guard += 1
        before = t
        fill_one(vo_dur, "cover")
        if t <= before + 1e-6:
            break
    if timeline and vo_dur - t > 1e-3:  # tail shorter than a shot: the last shot runs on
        last = timeline[-1]
        c = fo.by_id[last["shot"]]
        new_dur = round(vo_dur - last["t0"], 3)
        if last["src_in"] + new_dur > c["run"][1]:  # keep it inside the clean footage
            last["src_in"] = round(max(c["run"][0], c["run"][1] - new_dur), 3)
        last["t1"] = round(vo_dur, 3)
        last["dur"] = new_dur

    warnings = []
    usable = sum(b - a for (a, b, _c) in {(c["run"][0], c["run"][1], c["clip"]) for c in pool})
    if usable < vo_dur:
        warnings.append(f"Only {usable:.0f}s of clean footage for a {vo_dur:.0f}s voiceover: shoot more b-roll "
                        f"or tighten the script.")
    if fo.reused:
        warnings.append(f"{fo.reused} shot(s) reuse footage already shown (spread out, different moments).")
    return timeline, warnings


# ---------------------------------------------------------------------------------------------
# Natural-sound mode (no voiceover: people talking in the clips, plus the moments between)
# ---------------------------------------------------------------------------------------------

HALLUCINATIONS = {"thank you", "thanks for watching", "thank you for watching", "subscribe", "bye", "you"}
FILLERS = {"mmm", "mm", "hmm", "uh", "um", "ah", "oh", "huh"}


def _norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if ch.isalnum() or ch == "'")


def real_speech(words: list[dict]) -> bool:
    """Filter speech-to-text hallucinations (humming transcribed as 'do-do-do', 'Thank you' on silence)."""
    toks = [_norm(w["w"]) for w in words]
    toks = [t for t in toks if t]
    if not toks:
        return False
    if len(toks) >= 4:
        top = max(set(toks), key=toks.count)
        if toks.count(top) / len(toks) >= 0.5:
            return False
    text = " ".join(toks)
    if text in HALLUCINATIONS and (len(words) <= 3 or words[0].get("p", 1) < 0.1):
        return False
    if all(t in FILLERS for t in toks):
        return False
    if len(toks) <= 2 and words[0].get("p", 1) < 0.05:
        return False
    return True


def utterances(clip_words: dict[str, list[dict]], gap: float = 0.6) -> list[dict]:
    res = []
    for clip, words in clip_words.items():
        cur: list[dict] = []
        for w in words + [None]:
            if w is None or (cur and w["s"] - cur[-1]["e"] > gap):
                if cur and real_speech(cur):
                    res.append({"clip": clip, "start": cur[0]["s"], "end": cur[-1]["e"],
                                "text": " ".join(x["w"] for x in cur)})
                cur = []
            if w is not None:
                cur.append(w)
    return res


def heuristic_talk(utts, cands, notes, clip_order, target_len, banned=()):
    """Spoken lines + the best clean moments between them, in shooting order."""
    items = [{"clip": u["clip"], "start": u["start"], "end": u["end"], "why": "line", "kind": "line"} for u in utts]
    pool = eligible(cands, notes, set(banned)) or eligible(cands, notes, set(banned), strict=False)
    for c in sorted(pool, key=lambda c: -c["score"]):
        d = min(1.8, c["dur"])
        if d < MIN_SHOT:
            continue
        a = c["start"] + max(0.0, (c["dur"] - d) / 2)
        clash = any(i["clip"] == c["clip"] and i["start"] < a + d + 0.3 and a < i["end"] + 0.3 for i in items)
        if not clash:
            items.append({"clip": c["clip"], "start": round(a, 3), "end": round(a + d, 3), "why": "moment",
                          "kind": "moment", "shot": c["id"]})
    items.sort(key=lambda i: (clip_order[i["clip"]], i["start"]))
    total = sum(i["end"] - i["start"] for i in items)
    while total > target_len:  # too long: drop the weakest moments first, never lines
        moments = [i for i in items if i["kind"] == "moment"]
        if not moments:
            break
        weakest = min(moments, key=lambda i: next((c["score"] for c in cands if c["id"] == i.get("shot")), 0))
        items.remove(weakest)
        total -= weakest["end"] - weakest["start"]
    return items


def clean_coverage(clip: str, a: float, b: float, cands: list[dict]) -> float:
    runs = {(c["run"][0], c["run"][1]) for c in cands if c["clip"] == clip}
    cov = sum(max(0.0, min(b, y) - max(a, x)) for x, y in runs)
    return cov / max(b - a, 1e-6)


def _shot_at(cands, clip, t, exclude=()):
    """The candidate shot whose own range covers time t (not just the clean run it was cut from)."""
    inside = [c for c in cands if c["clip"] == clip and c["start"] - 0.05 <= t < c["end"] + 0.05 and c["id"] not in exclude]
    return min(inside, key=lambda c: abs((c["start"] + c["end"]) / 2 - t)) if inside else None


def build_talk_timeline(items, clip_words, cands, notes, metrics_by_clip, max_pause: float = 0.32, banned=()):
    """Lines are snapped to word edges with internal pauses jump-cut out. If a line's picture is soft, shaky or
    banned, its sound plays over clean footage instead (L-cut). Moments keep their own natural sound.
    Two passes: first every frame the edit will definitely show is reserved, then covers are chosen from
    what's left - so nothing appears twice."""
    fo = Footage(cands, metrics_by_clip, notes)
    banned = set(banned)
    pieces = []
    # pass 1: lay out lines and moments, reserve their pictures
    for it in items:
        words = [w for w in clip_words.get(it["clip"], []) if w["e"] > it["start"] - 0.05 and w["s"] < it["end"] + 0.05]
        if words and real_speech(words):
            runs, cur = [], [words[0]]
            for w in words[1:]:
                if w["s"] - cur[-1]["e"] > max_pause:
                    runs.append(cur)
                    cur = [w]
                else:
                    cur.append(w)
            runs.append(cur)
            for r in runs:
                a = max(r[0]["s"] - 0.08, 0)
                d = r[-1]["e"] + 0.12 - a
                if d < 0.25:
                    continue
                own = _shot_at(cands, it["clip"], a + d / 2)
                needs_cover = clean_coverage(it["clip"], a, a + d, cands) < 0.7 or (own is not None and own["id"] in banned)
                if not needs_cover and own is not None:
                    fo.used.setdefault(fo._key(own), []).append((a, a + d))
                pieces.append({"kind": "line", "clip": it["clip"], "a": a, "d": d, "words": r, "own": own,
                               "cover": needs_cover, "why": it.get("why", "line")})
        else:
            c = fo.by_id.get(it.get("shot") or "") or _shot_at(cands, it["clip"], it["start"])
            if c is None or c["id"] in banned:
                continue
            a = max(it["start"], c["run"][0])
            d = min(it["end"], c["run"][1]) - a
            if d >= MIN_SHOT:
                fo.used.setdefault(fo._key(c), []).append((a, a + d))
                pieces.append({"kind": "moment", "clip": it["clip"], "a": a, "d": d, "words": [], "own": c,
                               "cover": False, "why": it.get("why", "moment")})
    # pass 2: build the timeline; covers come from footage nobody else is using, as close in time as possible
    timeline, cap_words, t = [], [], 0.0
    for pc in pieces:
        a, d = pc["a"], pc["d"]
        seg = {"shot": pc["own"]["id"] if pc["own"] else None, "clip": pc["clip"], "src_in": round(a, 3),
               "dur": round(d, 3), "t0": round(t, 3), "t1": round(t + d, 3), "why": pc["why"], "audio": "clip"}
        if pc["cover"]:
            here = int(pc["clip"][1:]) if pc["clip"][1:].isdigit() else 0
            opts = sorted((c for c in eligible(cands, notes, banned) if fo.free_len(c) >= d),
                          key=lambda c: (c["clip"] != pc["clip"],
                                         abs((int(c["clip"][1:]) if c["clip"][1:].isdigit() else 0) - here),
                                         -c["score"]))
            if opts:
                c = opts[0]
                seg.update(v_clip=c["clip"], v_src_in=fo.take(c, d), shot=c["id"])
            elif pc["own"] is not None and pc["own"]["id"] in banned:
                continue  # nothing clean to show instead of a banned picture: drop the line
        timeline.append(seg)
        for w in pc["words"]:
            cap_words.append({**w, "s": round(t + w["s"] - a, 3), "e": round(t + w["e"] - a, 3)})
        t += d
    return timeline, cap_words


def fill_face_positions(timeline: list[dict], metrics_by_clip: dict, cands: list[dict]) -> None:
    """Crop position for every shot from the faces actually seen in that stretch of footage."""
    for s in timeline:
        clip = s.get("v_clip", s["clip"])
        a = s.get("v_src_in", s["src_in"])
        m = metrics_by_clip.get(clip)
        cx = None
        if m and m.get("t"):
            vals = [x for tt, x in zip(m["t"], m["face_cx"]) if a <= tt <= a + s["dur"] and x is not None]
            if vals:
                cx = round(float(np.median(vals)), 3)
        if cx is None:
            c = next((c for c in cands if c["id"] == s.get("shot")), None)
            cx = c.get("face_cx") if c else None
        s["face_cx"] = cx
