"""The rule-based director: decides what goes where, how long each cut holds, where a quick-cut burst
lands, and where (sparingly) a sound effect helps. The AI director makes the same kinds of decisions
with real understanding of the footage; this one is what runs without an API key, and it's also the
safety net that repairs the AI's plan.

House rules come from three places:
  - the creator's own editing profile (profiles/krios.json: opens fast, settles, holds the payoff)
  - what the best short-form/day-in-the-life editors do (cut on phrase starts, show what's said,
    vary shot size, one sound per purpose, riser peaks on the reveal)
  - what performs on this account (stakes, faces, payoffs)
"""
from __future__ import annotations

import numpy as np

from . import plan, story
from .analyze import hamming
from .style import BURST, CUT_LEAD, MAX_SHOT, MIN_SHOT, SFX_RULES

TYPE_FIT = {
    "hook": {"face close-up": 0.5, "reaction": 0.5, "talking to camera": 0.35, "group": 0.3},
    "payoff": {"reaction": 0.6, "face close-up": 0.5, "group": 0.45, "talking to camera": 0.4},
    "transition": {"transport / transition": 0.5, "wide/establishing": 0.45, "walking away / back of head": 0.35},
    "action": {"pov / hands": 0.35, "screen / product": 0.35, "detail / object": 0.3, "medium": 0.25, "group": 0.2},
    "list": {"detail / object": 0.35, "pov / hands": 0.3, "screen / product": 0.3},
    "question": {"face close-up": 0.35, "reaction": 0.35},
}
FILLERISH = {"walking away / back of head", "transport / transition"}


# ------------------------------------------------------------------------------------------- timing

def plan_cuts(words, vo_dur, beats, pace_at, first_shot, music_beats=None) -> list[float]:
    """Cut times. Every cut lands on a word onset (picture leads the word by CUT_LEAD). Preference order:
    the start of a beat (clause) > a content word > any word; with music, onsets that sit on a beat win ties."""
    ons = plan.onsets(words)
    strong = story.strong_words(words)
    beat_starts = {b["i0"]: b for b in beats}
    mb = np.asarray(music_beats) if music_beats is not None and len(music_beats) else None
    cuts, t = [0.0], 0.0
    while True:
        target = first_shot if len(cuts) == 1 else pace_at(t)
        if vo_dur - t <= min(MAX_SHOT, max(target, MIN_SHOT) * 1.4):
            break
        best, best_cost = None, 1e9
        for i, o in enumerate(ons):
            if o < t + MIN_SHOT - 1e-6 or o > t + MAX_SHOT or vo_dur - o < MIN_SHOT:
                continue
            cost = abs(o - (t + target))
            b = beat_starts.get(i)
            if b is not None and o - t >= 0.6 * target:
                # a new thought starts here: cutting on it is what makes an edit feel intentional
                cost -= min(0.75 * target, 0.9) * (1.3 if b["intent"] in ("transition", "payoff") else 1.0)
            elif i in strong:
                cost -= min(0.15 * target, 0.2)
            if mb is not None:
                d = float(np.min(np.abs(mb - o)))
                if d < 0.07:
                    cost -= min(0.2 * target, 0.25)
            if cost < best_cost:
                best, best_cost = o, cost
        if best is None:
            break
        cuts.append(best)
        t = best
    return cuts


def burst_slice(music_beats) -> float:
    """Shot length inside a burst: a musical subdivision when there's music, else the house default."""
    if music_beats is not None and len(music_beats) > 4:
        beat = float(np.median(np.diff(music_beats)))
        for sub in (beat / 2, beat, beat / 4):
            if BURST["min_shot"] <= sub <= BURST["max_shot"]:
                return sub
    return BURST["shot"]


def choose_bursts(beats, beat_scene, cuts, vo_dur, words, pool_by_scene, max_bursts=2, music_beats=None) -> list[dict]:
    """Quick-cut bursts (3-4 shots, ~0.3s each) where the story arrives somewhere new - the classic
    day-in-the-life move - only if that place has enough clean, different-looking shots. With music,
    the burst starts on a beat and each shot is a musical subdivision long."""
    ons = plan.onsets(words)
    sl = burst_slice(music_beats)
    mb = np.asarray(music_beats) if music_beats is not None and len(music_beats) else None
    out = []
    for k, b in enumerate(beats):
        if len(out) >= max_bursts:
            break
        if b["intent"] not in ("transition", "list") or k == 0:
            continue
        # a reveal lands on a held face, not on a flurry of cuts: keep bursts clear of payoff beats
        if any(x["intent"] == "payoff" and -1.8 <= x["t0"] - b["t0"] <= 2.0 for x in beats):
            continue
        if beat_scene[k] == beat_scene[k - 1] and b["intent"] != "list":
            continue
        t0 = max(b["t0"] - CUT_LEAD, 0.0)
        if mb is not None:   # start on the musical grid (beats + half-beats): up to 0.3s early or 0.15s late
            grid = np.sort(np.concatenate([mb, mb[:-1] + np.diff(mb) / 2])) if len(mb) > 1 else mb
            near = [float(x) for x in grid if -0.30 <= x - t0 <= 0.15]
            if near:
                t0 = min(near, key=lambda x: abs(x - t0))
        if t0 < 2.0 or t0 > vo_dur * 0.85 or any(abs(t0 - x["t0"]) < 6.0 for x in out):
            continue
        # the place we've arrived at (and the next couple of scenes, still "there")
        avail = sum(len(pool_by_scene.get(beat_scene[k] + d, [])) for d in range(3))
        if avail < 3:
            continue
        n = 4 if avail >= 6 else 3
        want = n * sl
        if mb is not None:
            t1 = t0 + want          # musical: exactly n subdivisions
        else:
            ends = [o for o in ons if t0 + n * BURST["min_shot"] <= o <= t0 + n * BURST["max_shot"]]
            if not ends:
                continue
            t1 = min(ends, key=lambda o: abs(o - (t0 + want)))
        out.append({"t0": t0, "t1": t1, "n": n, "beat": k, "scene": beat_scene[k]})
    return out


# ------------------------------------------------------------------------------------------- shots

class Picker:
    def __init__(self, cands, notes, metrics, clip_order, banned, must, shot_scene=None):
        self.pool = plan.eligible(cands, notes, set(banned)) or plan.eligible(cands, notes, set(banned), strict=False)
        self.notes = notes
        self.metrics = metrics
        self.order = {c["id"]: (clip_order[c["clip"]], c["start"]) for c in cands}
        self.used: set[str] = set()
        # seconds of clean footage left in each run (a 4s shot can give two different moments)
        self.left = {(c["clip"], c["run"][0]): c["run"][1] - c["run"][0] for c in cands}
        self.uses: dict[tuple, int] = {}
        self.shot_scene = shot_scene or {}
        self.must = set(must) - set(banned)
        self.text = {c["id"]: set(story.content_words(" ".join([notes.get(c["id"], {}).get("what", ""),
                                                                notes.get(c["id"], {}).get("setting", ""),
                                                                " ".join(notes.get(c["id"], {}).get("tags", []))])))
                     for c in cands}

    def score(self, c, beat, prev, length):
        n = self.notes.get(c["id"], {})
        s = c["score"]
        st = n.get("shot_type")
        s += TYPE_FIT.get(beat["intent"], {}).get(st, 0.0)
        if st in FILLERISH and beat["intent"] not in ("transition",):
            s -= 0.35                                            # walking/transport only where the VO is moving
        if not n and "moving, no face (likely walking/filler)" in c["flags"] and beat["intent"] != "transition":
            s -= 0.3
        if beat["intent"] in ("hook", "payoff"):
            s += 0.5 * min(c["face"] * 4, 1) + 0.08 * n.get("hook", 0)
        s += 0.4 * min(len(set(beat["keys"]) & self.text.get(c["id"], set())), 2)   # show what's said
        s += 0.04 * n.get("energy", 3) * (1 if beat["intent"] in ("transition", "list", "hook") else 0)
        if prev is not None:
            if "hash" in c and "hash" in prev and hamming(c["hash"], prev["hash"]) <= 12:
                s -= 0.5                                         # near-identical framing back to back = jump cut
            if st and st == self.notes.get(prev["id"], {}).get("shot_type"):
                s -= 0.15                                        # vary shot size/type
        run = self.left.get((c["clip"], c["run"][0]), c["run"][1] - c["run"][0])
        if run < length:
            s -= 0.8 * (length - run) / max(length, 1e-6)   # it would run out and need covering
        if c["id"] in self.used:
            s -= 0.25                                         # prefer something new, but a long shot can return
        s -= 0.35 * self.uses.get((c["clip"], c["run"][0]), 0)   # ...and one long take shouldn't dominate
        if c["id"] in self.must:
            s += 1.0
        return s

    def pick(self, beat, scene_shots, prev, length, chronological=True, need=0.0, exclude=frozenset()):
        left = lambda c: self.left.get((c["clip"], c["run"][0]), 0.0)   # noqa: E731
        ok = lambda c: (prev is None or c["id"] != prev["id"]) and c["id"] not in exclude   # noqa: E731
        cands = [c for c in self.pool if left(c) >= min(length, 0.6) and ok(c)]
        if not cands:
            cands = [c for c in self.pool if ok(c)]
        if not cands:
            if exclude:
                return None
            cands = list(self.pool)
        if need:
            cands = [c for c in cands if left(c) >= need] or cands
        in_scene = [c for c in cands if c["id"] in scene_shots]
        base = in_scene
        if len(base) < 2 and scene_shots and self.shot_scene:
            # thin scene: widen to the moments just before/after it in the day, not to anywhere
            here = [self.shot_scene[x] for x in scene_shots if x in self.shot_scene]
            if here:
                h = min(here)
                for radius in (1, 2, 3):
                    base = [c for c in cands if abs(self.shot_scene.get(c["id"], 999) - h) <= radius]
                    if len(base) >= 2:
                        break
        base = base or cands
        ranked = sorted(base, key=lambda c: -self.score(c, beat, prev, length))[:6]
        if chronological and in_scene and beat["intent"] not in ("hook", "payoff"):
            # among the best few, keep the day's order: take the earliest of the ones close to the top score
            top = self.score(ranked[0], beat, prev, length)
            near = [c for c in ranked if self.score(c, beat, prev, length) >= top - 0.12]
            choice = min(near, key=lambda c: self.order[c["id"]])
        else:
            choice = ranked[0]
        self.used.add(choice["id"])
        k = (choice["clip"], choice["run"][0])
        self.left[k] = max(0.0, self.left.get(k, 0.0) - length - 0.15)
        self.uses[k] = self.uses.get(k, 0) + 1
        return choice


# ------------------------------------------------------------------------------------------- sound

def plan_sfx(beats, beat_scene, bursts, cuts, vo_dur) -> list[dict]:
    """One sound per purpose, never on every cut. Placed on planned times; snapped to real cuts later."""
    sfx = []
    for b in bursts:  # soft clicks on each cut inside a burst (the first cut gets a slightly fuller pop)
        sfx.append({"t": b["t0"], "type": "pop", "why": "burst starts", "burst": True})
    whooshes = 0
    for k, b in enumerate(beats):
        if k == 0 or b["intent"] != "transition" or beat_scene[k] == beat_scene[k - 1]:
            continue
        t = max(b["t0"] - CUT_LEAD, 0.0)
        if any(abs(t - x["t0"]) < 0.5 for x in bursts):
            continue
        if whooshes >= SFX_RULES["max_whoosh"] or any(abs(t - x["t"]) < SFX_RULES["min_gap"] for x in sfx):
            continue
        if min((abs(t - c) for c in cuts), default=9) < 0.12:
            sfx.append({"t": t, "type": "whoosh", "why": "location change"})
            whooshes += 1
    risers = 0
    for k, b in enumerate(beats):
        if b["intent"] != "payoff" or k == 0 or risers >= SFX_RULES["max_riser"]:
            continue
        t = max(b["t0"] - CUT_LEAD, 0.0)
        if t < 3.0:
            continue
        length = float(np.clip(t - beats[k - 1]["t0"], 1.2, SFX_RULES["riser_max"]))
        sfx.append({"t": t, "type": "riser", "len": round(length, 2), "why": f"build into: {b['text'][:40]}"})
        sfx.append({"t": t, "type": "hit", "why": "reveal lands"})
        risers += 1
    return sorted(sfx, key=lambda x: x["t"])


# ------------------------------------------------------------------------------------------- direct

def direct(words, vo_dur, cands, notes, metrics, clips, clip_order, pace_at, first_shot, banned=(), must=(),
           music_beats=None):
    """Full rule-based plan: beats, scenes, cut times, bursts, shot choice, sound."""
    bts = story.beats(words)
    scs = story.scenes(clips, [c for c in cands if "duplicate" not in c["flags"]], notes)
    beat_scene = story.align(bts, scs, vo_dur, notes, cands)
    cuts = plan_cuts(words, vo_dur, bts, pace_at, first_shot, music_beats)
    shot_scene = {x: k for k, sc in enumerate(scs) for x in sc["shots"]}
    picker = Picker(cands, notes, metrics, clip_order, banned, must, shot_scene)
    pool_ids = {c["id"] for c in picker.pool}
    pool_by_scene = {k: [x for x in sc["shots"] if x in pool_ids] for k, sc in enumerate(scs)}
    bursts = choose_bursts(bts, beat_scene, cuts, vo_dur, words, pool_by_scene, music_beats=music_beats)

    def beat_at(t):
        for k, b in enumerate(bts):
            if b["t0"] - CUT_LEAD - 0.05 <= t < (bts[k + 1]["t0"] - CUT_LEAD if k + 1 < len(bts) else 1e9):
                return k
        return len(bts) - 1

    # remove ordinary cuts that fall inside a burst; the burst's own start/end become cuts
    for b in bursts:
        cuts = [c for c in cuts if not (b["t0"] - 0.3 < c < b["t1"] + MIN_SHOT * 0.5)] + [b["t0"], b["t1"]]
    cuts = sorted(set(round(c, 3) for c in cuts if c < vo_dur - MIN_SHOT * 0.5))

    seq, prev = [], None
    hook_beat = bts[0] if bts else {"intent": "hook", "keys": [], "text": ""}
    # decide the ending first (like an editor would) so the shot that should close the reel is still there
    ending = None
    if len(cuts) > 2 and bts:
        last_len = vo_dur - cuts[-1]
        lb = bts[-1]
        ending = picker.pick({**lb, "intent": "payoff"}, set(scs[beat_scene[-1]]["shots"]) if scs else set(), None,
                             last_len, chronological=False, need=last_len)
        have = ending["run"][1] - ending["run"][0]
        if have < last_len - 0.05:
            # the best closing shot is shorter than the slot: start it later (on a word) so it can hold to the end
            ons = plan.onsets(words)
            later = [o for o in ons if vo_dur - have <= o <= vo_dur - MIN_SHOT and o > cuts[-2] + MIN_SHOT]
            if later:
                cuts[-1] = min(later)
    for k, t0 in enumerate(cuts):
        t1 = cuts[k + 1] if k + 1 < len(cuts) else vo_dur
        burst = next((b for b in bursts if abs(b["t0"] - t0) < 1e-3), None)
        bi = beat_at(t0)
        beat = bts[bi] if bts else hook_beat
        scene_shots = set(scs[beat_scene[bi]]["shots"]) if scs and bts else set()
        if burst:
            for d in (1, 2):
                if beat_scene[bi] + d < len(scs):
                    scene_shots |= set(scs[beat_scene[bi] + d]["shots"])
            shots = []
            for _ in range(burst["n"]):
                c = picker.pick({**beat, "intent": "list"}, scene_shots, prev, BURST["shot"], exclude=set(shots))
                if c is None:
                    break
                shots.append(c["id"])
                prev = c
            seq.append({"t0": t0, "t1": burst["t1"], "burst": shots, "why": f"burst: {beat['text'][:40]}"})
            continue
        if k == 0:
            c = picker.pick({**beat, "intent": "hook"}, set(), None, t1 - t0, chronological=False)
            why = "hook: strongest opening image"
        elif t1 >= vo_dur - 1e-6:
            c = ending if ending is not None and (prev is None or ending["id"] != prev["id"]) else \
                picker.pick({**beat, "intent": "payoff"}, scene_shots, prev, t1 - t0, chronological=False, need=t1 - t0)
            why = "ending: hold on a face/payoff"
        else:
            c = picker.pick(beat, scene_shots, prev, t1 - t0)
            why = f"{beat['intent']}: {beat['text'][:40]}"
        seq.append({"t0": t0, "shot": c["id"], "offset": None, "why": why})
        prev = c
    sfx = plan_sfx(bts, beat_scene, bursts, cuts, vo_dur)
    return {"seq": seq, "sfx": sfx, "beats": bts, "scenes": scs, "beat_scene": beat_scene, "bursts": bursts}


def snap_sfx(sfx: list[dict], timeline: list[dict], fps: int = 30) -> list[dict]:
    """Move planned sounds onto the real cuts (frame-exact) and expand burst pops into clicks on each burst cut."""
    tt = (lambda s: s["f0"] / fps) if timeline and "f0" in timeline[0] else (lambda s: s["t0"])
    cut_times = [tt(s) for s in timeline[1:]]
    groups, cur = [], []
    for s in timeline:                       # consecutive burst shots = one burst
        if s.get("burst_part"):
            cur.append(tt(s))
        elif cur:
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    out, used_groups = [], set()
    for x in sfx:
        if x.get("burst"):
            cand = [(abs(g[0] - x["t"]), i) for i, g in enumerate(groups) if i not in used_groups and abs(g[0] - x["t"]) < 1.5]
            if not cand:
                continue
            i = min(cand)[1]
            used_groups.add(i)
            for j, t in enumerate(groups[i]):
                out.append({"t": round(t, 4), "type": "pop" if j == 0 else "click", "why": x["why"], "var": j})
            continue
        if not cut_times:
            continue
        near = min(cut_times, key=lambda c: abs(c - x["t"]))
        if abs(near - x["t"]) <= 0.35:
            out.append({**x, "t": round(near, 4)})
    # tidy: drop anything too close to another sound (except burst clicks)
    out.sort(key=lambda x: x["t"])
    tidy = []
    for x in out:
        if x["type"] in ("click", "pop", "hit") or not tidy or x["t"] - tidy[-1]["t"] >= SFX_RULES["min_gap"] or tidy[-1]["type"] == "riser":
            tidy.append(x)
    return tidy


# ------------------------------------------------------------------------------------------- AI plan

def story_context(words, vo_dur, cands, notes, clips):
    bts = story.beats(words)
    scs = story.scenes(clips, [c for c in cands if "duplicate" not in c["flags"]], notes)
    return bts, scs, story.align(bts, scs, vo_dur, notes, cands)


def from_ai(p, words, vo_dur, cands, music_beats=None, max_bursts=2):
    """Turn the AI director's plan into timeline items + sound cues, enforcing every house rule on the way:
    cuts on word onsets, bursts of 3-4 different shots on the musical grid, sounds only where they belong."""
    ons = plan.onsets(words)
    ids = {c["id"] for c in cands}
    on = lambda i: ons[min(max(int(i), 0), len(ons) - 1)] if ons else 0.0   # noqa: E731
    sl = burst_slice(music_beats)
    mb = np.asarray(music_beats) if music_beats is not None and len(music_beats) else None
    bursts = []
    for b in sorted(p.bursts, key=lambda b: b.from_word)[:max_bursts]:
        shots = []
        for x in b.shots:
            if x in ids and x not in shots:
                shots.append(x)
        shots = shots[:4]
        if len(shots) < 3:
            continue
        t0 = on(b.from_word)
        if mb is not None:
            grid = np.sort(np.concatenate([mb, mb[:-1] + np.diff(mb) / 2])) if len(mb) > 1 else mb
            near = [float(x) for x in grid if -0.30 <= x - t0 <= 0.15]
            if near:
                t0 = min(near, key=lambda x: abs(x - t0))
        t1 = t0 + len(shots) * sl
        if t0 < 1.0 or t1 > vo_dur - MIN_SHOT or any(abs(t0 - x["t0"]) < 3.0 for x in bursts):
            continue
        bursts.append({"t0": t0, "t1": t1, "burst": shots, "why": f"burst: {b.why}"})
    seq, seen = [], set()
    for c in sorted(p.cuts, key=lambda c: c.from_word):
        if c.shot not in ids or c.from_word in seen:
            continue
        seen.add(c.from_word)
        t0 = 0.0 if not seq else on(c.from_word)
        if any(b["t0"] - 0.2 < t0 < b["t1"] + MIN_SHOT * 0.5 for b in bursts):
            continue
        seq.append({"t0": t0, "shot": c.shot, "offset": c.offset, "why": c.why})
    if seq:
        seq[0]["t0"] = 0.0
    seq = sorted(seq + bursts, key=lambda x: x["t0"])
    # sound: keep the AI's intent, enforce the rules
    sfx, whoosh, riser = [], 0, 0
    for x in sorted(p.sfx, key=lambda x: x.at_word):
        t = on(x.at_word)
        in_burst = next((b for b in bursts if b["t0"] - 0.15 <= t <= b["t1"]), None)
        if x.type in ("click", "pop"):
            if in_burst is not None and not any(s.get("burst") and abs(s["t"] - in_burst["t0"]) < 0.05 for s in sfx):
                sfx.append({"t": in_burst["t0"], "type": "pop", "why": x.why, "burst": True})
            continue
        if x.type == "whoosh":
            if whoosh >= SFX_RULES["max_whoosh"] or in_burst is not None:
                continue
            whoosh += 1
        if x.type == "riser":
            if riser >= SFX_RULES["max_riser"] or t < 2.5:
                continue
            riser += 1
            prev_cut = max([s["t0"] for s in seq if s["t0"] < t - 0.3] or [max(t - 2.0, 0.0)])
            length = float(np.clip(t - prev_cut, 1.2, SFX_RULES["riser_max"]))
            sfx.append({"t": t, "type": "riser", "len": round(length, 2), "why": x.why})
            sfx.append({"t": t, "type": "hit", "why": "reveal lands"})
            continue
        if x.type == "hit" and any(s["type"] == "hit" and abs(s["t"] - t) < 0.05 for s in sfx):
            continue
        if x.type == "hit" and not any(s["type"] == "riser" and abs(s["t"] - t) < 0.05 for s in sfx):
            continue   # a hit only lands a riser
        sfx.append({"t": t, "type": x.type, "why": x.why})
    for b in bursts:   # every burst gets its clicks even if the AI forgot
        if not any(s.get("burst") and abs(s["t"] - b["t0"]) < 0.05 for s in sfx):
            sfx.append({"t": b["t0"], "type": "pop", "why": "burst", "burst": True})
    return seq, sorted(sfx, key=lambda s: s["t"])
