"""Fast checks for the editing logic (no video files needed): python -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from m5e import captions, plan  # noqa: E402
from m5e.style import CAPTION, MAX_SHOT, MIN_SHOT  # noqa: E402


def words_from(text, start=0.0, rate=0.3, pause_after_sentence=0.5):
    out, t = [], start
    for w in text.split():
        out.append({"w": w, "s": round(t, 3), "e": round(t + rate * 0.8, 3), "p": 0.95})
        t += rate + (pause_after_sentence if w.endswith(".") else 0)
    return out


VO = words_from("Here's the day in the life of a group of teenagers from Ireland flying to London to meet an investor. "
                "Our journey starts at about 7am. We touched down in Stansted and then had to take a one hour bus "
                "to make it to central London. In case you don't know, we're a group of teenagers based in Cork, "
                "and we're building the future of sales training. But back to the trip.")
VO_DUR = VO[-1]["e"] + 0.3


def footage(n_clips=20, run=(0.2, 7.8)):
    cands, metrics, order = [], {}, {}
    for k in range(n_clips):
        cid = f"c{k + 1:02d}"
        order[cid] = k + 1
        t = [i / 6 for i in range(48)]
        metrics[cid] = {"t": t, "blur": [0.3] * 48, "motion": [0.004] * 48, "face": [0.2] * 48, "face_cx": [0.5] * 48}
        for j, (a, b) in enumerate([(run[0], (run[0] + run[1]) / 2), ((run[0] + run[1]) / 2, run[1])]):
            cands.append({"id": f"{cid}s{j + 1:02d}", "clip": cid, "start": a, "end": b, "dur": b - a,
                          "run": list(run), "score": 0.6, "flags": [], "face": 0.2, "face_cx": 0.5})
    return cands, metrics, order


def overlaps(tl):
    pics = [(s.get("v_clip", s["clip"]), s.get("v_src_in", s["src_in"]), s["dur"]) for s in tl]
    return [(a, b) for i, a in enumerate(pics) for b in pics[i + 1:]
            if a[0] == b[0] and a[1] < b[1] + b[2] - 0.02 and b[1] < a[1] + a[2] - 0.02]


class TestVoiceoverCut(unittest.TestCase):
    def cut(self, cands, metrics, order, banned=(), template=None, pace=1.4):
        seq = plan.heuristic_vo(VO, VO_DUR, cands, {}, metrics, order, pace, banned, (), template)
        return plan.build_vo_timeline(seq, VO, VO_DUR, cands, {}, metrics, banned, pace, template)

    def test_structure(self):
        tl, warns = self.cut(*footage())
        self.assertFalse(warns)
        self.assertAlmostEqual(tl[0]["t0"], 0.0)
        self.assertAlmostEqual(tl[-1]["t1"], VO_DUR, places=2)
        for a, b in zip(tl, tl[1:]):
            self.assertAlmostEqual(a["t1"], b["t0"], places=3)      # no gaps
            self.assertNotEqual(a["shot"], b["shot"])                # never the same shot twice in a row
        for s in tl:
            self.assertGreaterEqual(s["t1"] - s["t0"], MIN_SHOT - 1e-6)
            self.assertLessEqual(s["t1"] - s["t0"], MAX_SHOT + 1e-6)
        self.assertEqual(overlaps(tl), [])                           # no frame shown twice
        ons = plan.onsets(VO)
        on_word = sum(1 for s in tl[1:] if min(abs(s["t0"] - o) for o in ons) < 0.02)
        self.assertGreaterEqual(on_word / max(len(tl) - 1, 1), 0.9)  # cuts land on words

    def test_short_shots_never_leave_gaps(self):
        tl, _ = self.cut(*footage(n_clips=40, run=(0.0, 0.9)))
        self.assertAlmostEqual(tl[-1]["t1"], VO_DUR, places=2)
        self.assertTrue(all(abs(a["t1"] - b["t0"]) < 1e-3 for a, b in zip(tl, tl[1:])))

    def test_not_enough_footage_warns_and_spreads_reuse(self):
        tl, warns = self.cut(*footage(n_clips=3))
        self.assertTrue(any("clean footage" in w for w in warns))
        self.assertTrue(all(a["shot"] != b["shot"] for a, b in zip(tl, tl[1:])))

    def test_banned_shots_never_used(self):
        cands, metrics, order = footage()
        banned = {c["id"] for c in cands[::3]}
        tl, _ = self.cut(cands, metrics, order, banned=banned)
        self.assertFalse(banned & {s["shot"] for s in tl})

    def test_follows_reference_rhythm(self):
        fast_then_slow = [0.6] * 12 + [2.6] * 8
        tl, _ = self.cut(*footage(), template=fast_then_slow)
        d = [s["t1"] - s["t0"] for s in tl]
        first = [x for s, x in zip(tl, d) if s["t0"] < VO_DUR / 3]
        last = [x for s, x in zip(tl, d) if s["t0"] > 2 * VO_DUR / 3]
        self.assertLess(sum(first) / len(first), sum(last) / len(last))

    def test_ai_plan_repairs(self):
        cands, metrics, _ = footage()
        bad = [{"from_word": 5, "shot": "c02s01", "offset": 9.0, "why": "x"},
               {"from_word": 0, "shot": "c01s01", "offset": -3, "why": "x"},
               {"from_word": 5, "shot": "c03s01", "offset": 0, "why": "duplicate start word"},
               {"from_word": 6, "shot": "c99s99", "offset": 0, "why": "unknown shot"},
               {"from_word": 7, "shot": "c04s01", "offset": 0, "why": "sliver"}]
        seq = plan.vo_plan_to_seq(bad, VO)
        tl, _ = plan.build_vo_timeline(seq, VO, VO_DUR, cands, {}, metrics, (), 1.4)
        self.assertNotIn("c99s99", {s["shot"] for s in tl})
        self.assertAlmostEqual(tl[-1]["t1"], VO_DUR, places=2)
        self.assertTrue(all(s["t1"] - s["t0"] >= MIN_SHOT - 1e-6 for s in tl))


class TestCaptions(unittest.TestCase):
    def test_chunks_break_at_sentences_and_fit_three_lines(self):
        chunks = captions.chunk(VO)
        for ch in chunks:
            lines = captions.wrap([w["w"] for w in ch])
            self.assertLessEqual(len(lines), CAPTION["max_lines"])
            for w in ch[:-1]:
                self.assertFalse(w["w"].endswith((".", "?", "!")), "a sentence end must close its block")

    def test_ass_and_srt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            ass = captions.build_ass(VO, Path(d) / "c.ass")
            srt = captions.build_srt(VO, Path(d) / "c.srt")
            txt = ass.read_text()
            self.assertIn("Poppins", txt)
            self.assertIn("\\alpha&HFF&", txt)          # unspoken words are invisible (word-by-word reveal)
            back = captions.read_srt_words(srt)
            self.assertEqual(len(back), len(VO))


class TestSpeechFilter(unittest.TestCase):
    def w(self, text, p=0.8):
        return [{"w": x, "s": i * 0.3, "e": i * 0.3 + 0.2, "p": p} for i, x in enumerate(text.split())]

    def test_hallucinations_dropped(self):
        self.assertFalse(plan.real_speech(self.w("Do -do -do -do -do -do -do")))
        self.assertFalse(plan.real_speech([{"w": "Thank", "s": 0, "e": .2, "p": 0.01}, {"w": "you.", "s": .3, "e": .5, "p": .9}]))
        self.assertFalse(plan.real_speech(self.w("Mmm!")))

    def test_real_lines_kept(self):
        self.assertTrue(plan.real_speech(self.w("Can you spread both?", p=0.3)))
        self.assertTrue(plan.real_speech(self.w("Wow, that's insane.", p=0.2)))


if __name__ == "__main__":
    unittest.main()
