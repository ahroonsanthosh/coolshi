"""Story structure: voiceover beats, footage scenes, and how they line up.

A day-in-the-life voiceover is told in order, and the footage was shot in order, so the default
mapping is chronological. It isn't rigid, though: the hook may come from anywhere, and a beat that
names a place or thing pulls footage of that place or thing.
"""
from __future__ import annotations

import re
from collections import Counter

import numpy as np

STOP = set("""a an the and or but so to of in on at for with from by as is are was were be been being it its it's this that
these those i we you he she they them us our your my me him her his their there here then than too very just also not no
do did does done got get getting go going went gone had has have having into onto out up down over off about after before
again all any each few more most other some such only own same can will would should could may might must one two
like really actually pretty quite back""".split())

TRANSITION = re.compile(r"^(once|then|after|afterwards|next|later|finally|so|first|by the time|when we|as soon as|"
                        r"on the way|back to|the next|that night|that evening|in the morning)\b", re.I)
MOVE = re.compile(r"\b(headed|head|got to|made (our|my) way|went to|arrived|landed|touched down|took (the|a)|"
                  r"jumped on|hopped|flew|drove|walked|back (home|to))\b", re.I)
PAYOFF = re.compile(r"\b(won|winning|we did it|finally|ended up (winning|getting|signing|making)|turns out|"
                    r"guess (who|what)|the result|it worked|signed (a|the|with)|got accepted|sold out|record|"
                    r"semi-?finals?|made it to)\b", re.I)


def content_words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in STOP and len(w) > 2]


def beats(words: list[dict], pause: float = 0.35) -> list[dict]:
    """Split the voiceover into clauses: break after . ? ! (always), after , ; : when the clause has some
    length, and on audible pauses. Each beat gets an intent."""
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(i)
        end = i == len(words) - 1
        nxt = words[i + 1] if not end else None
        brk = end or w["w"].endswith((".", "?", "!"))
        if not brk and w["w"].endswith((",", ";", ":")) and len(cur) >= 4:
            brk = True
        if not brk and nxt is not None and nxt["s"] - w["e"] > pause and len(cur) >= 3:
            brk = True
        if brk:
            out.append(cur)
            cur = []
    res = []
    for k, idx in enumerate(out):
        text = " ".join(words[i]["w"] for i in idx)
        intent = "action"
        if k == 0:
            intent = "hook"
        elif PAYOFF.search(text):
            intent = "payoff"
        elif TRANSITION.search(text) or MOVE.search(text):
            intent = "transition"
        elif text.count(",") >= 2:
            intent = "list"
        elif text.rstrip().endswith("?"):
            intent = "question"
        res.append({"i0": idx[0], "i1": idx[-1], "t0": words[idx[0]]["s"], "t1": words[idx[-1]]["e"], "text": text,
                    "intent": intent, "keys": content_words(text)})
    # a question is usually set-up for a reveal: the beat after it is the payoff
    for k in range(len(res) - 1):
        if res[k]["intent"] == "question" and res[k + 1]["intent"] not in ("payoff", "hook"):
            res[k + 1]["intent"] = "payoff"
    return res


def scenes(clips: dict[str, dict], cands: list[dict], notes: dict, gap_s: float = 300.0) -> list[dict]:
    """Group clips into scenes: a new scene starts after a gap in recording time (default 5 min) or when
    Claude's shot log says the setting changed. Clips arrive sorted by recording time."""
    order = list(clips.keys())
    by_clip: dict[str, list[dict]] = {}
    for c in cands:
        by_clip.setdefault(c["clip"], []).append(c)

    def setting(cid):
        # only Claude's settings split scenes: the free local model's per-shot guesses are too noisy for that
        s = Counter(notes.get(c["id"], {}).get("setting", "").strip().lower() for c in by_clip.get(cid, [])
                    if notes.get(c["id"], {}).get("_source") != "local")
        s.pop("", None)
        return s.most_common(1)[0][0] if s else ""

    groups: list[list[str]] = []
    prev_end, prev_setting = None, None
    for cid in order:
        info = clips[cid]
        start = info.get("created") or 0.0
        st = setting(cid)
        new = not groups
        if prev_end is not None and start - prev_end > gap_s:
            new = True
        if st and prev_setting and st != prev_setting and _different_place(st, prev_setting):
            new = True
        if new:
            groups.append([cid])
        else:
            groups[-1].append(cid)
        prev_end = start + info.get("duration", 0)
        prev_setting = st or prev_setting
    out = []
    for k, g in enumerate(groups):
        tags = Counter()
        label = Counter()
        for cid in g:
            for c in by_clip.get(cid, []):
                n = notes.get(c["id"], {})
                tags.update(t.lower() for t in n.get("tags", []))
                if n.get("setting") and n.get("_source") != "local":
                    label[n["setting"]] += 1
        out.append({"id": f"S{k + 1}", "clips": g, "label": label.most_common(1)[0][0] if label else f"scene {k + 1}",
                    "tags": [t for t, _ in tags.most_common(25)],
                    "time": float(clips[g[0]].get("created") or 0.0),
                    "shots": [c["id"] for cid in g for c in by_clip.get(cid, [])]})
    return out


def _different_place(a: str, b: str) -> bool:
    wa, wb = set(content_words(a)), set(content_words(b))
    return not (wa & wb)


def align(bts: list[dict], scs: list[dict], vo_dur: float, notes: dict, cands: list[dict], sem=None) -> list[int]:
    """Monotonic beat -> scene alignment (dynamic programming). Cost = distance from the proportional
    position in the day + a bonus when the beat's words match the scene's tags/log + a bonus when the
    local vision model sees the line in that scene's shots (sem: (beat index, shot id) -> z-score)."""
    if not scs:
        return [0] * len(bts)
    S, B = len(scs), len(bts)
    shot_text = {}
    for c in cands:
        n = notes.get(c["id"], {})
        shot_text[c["id"]] = set(content_words(" ".join([n.get("what", ""), n.get("setting", ""), " ".join(n.get("tags", []))])))
    scene_words = [set(sc["tags"]) | set(content_words(sc["label"])) | set().union(*[shot_text.get(x, set()) for x in sc["shots"]]) if sc["shots"] else set()
                   for sc in scs]
    # where each scene sits on a 0..1 "day" axis: when it was filmed (time of day), blended with its place in
    # the order of scenes. NOT how much footage it has - a long dinner shoot mustn't take over the story.
    times = np.array([sc.get("time", 0.0) for sc in scs], float)
    rank = (np.arange(S) + 0.5) / S
    span = times.max() - times.min() if S > 1 else 0.0
    by_time = (times - times.min()) / span if span > 0 else rank
    centers = 0.5 * by_time + 0.5 * rank
    cost = np.zeros((B, S))
    for i, b in enumerate(bts):
        pos = ((b["t0"] + b["t1"]) / 2) / max(vo_dur, 1e-6)
        for j in range(S):
            match = len(set(b["keys"]) & scene_words[j])
            cost[i, j] = abs(pos - centers[j]) * 2.0 - 0.6 * min(match, 3)
            if sem:
                zs = sorted((sem.get((i, x), 0.0) for x in scs[j]["shots"]), reverse=True)[:2]
                if zs:
                    cost[i, j] -= 0.25 * float(np.clip(np.mean(zs), -1.0, 3.0))
    # DP: scene index never goes backwards (the hook beat is free to borrow from anywhere later)
    INF = 1e9
    dp = np.full((B, S), INF)
    bk = np.zeros((B, S), int)
    dp[0] = cost[0]
    for i in range(1, B):
        best = INF
        arg = 0
        for j in range(S):
            if dp[i - 1, j] < best:
                best, arg = dp[i - 1, j], j
            dp[i, j] = best + cost[i, j]
            bk[i, j] = arg
    j = int(np.argmin(dp[-1]))
    path = [j]
    for i in range(B - 1, 0, -1):
        j = int(bk[i, j])
        path.append(j)
    return path[::-1]


def strong_words(words: list[dict]) -> set[int]:
    """Indices of content words (nouns/verbs/names) - the words a cut can land on so the picture changes
    exactly when the thing is named."""
    return {i for i, w in enumerate(words) if re.sub(r"[^a-z0-9']", "", w["w"].lower()) not in STOP
            and len(re.sub(r"[^a-z0-9']", "", w["w"])) > 2}
