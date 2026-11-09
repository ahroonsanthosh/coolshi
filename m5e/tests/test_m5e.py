"""Checks for the editing logic: python -m unittest discover -s tests
Most need no video files; the music and sound-effect tests synthesise their own audio (ffmpeg required)."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from m5e import captions, director, metrics, plan, render, sfx, story  # noqa: E402
from m5e import profile as profiles  # noqa: E402
from m5e.style import BURST, CAPTION, MAX_SHOT, MIN_SHOT  # noqa: E402


def words_from(text, start=0.0, rate=0.3, pause_after_sentence=0.5):
    out, t = [], start
    for w in text.split():
        out.append({"w": w, "s": round(t, 3), "e": round(t + rate * 0.8, 3), "p": 0.95})
        t += rate + (pause_after_sentence if w.endswith(".") else 0)
    return out


VO = words_from("Here's the day in the life of a group of teenagers from Ireland flying to London to meet an investor. "
                "Our journey starts at about 7am. We touched down in Stansted and then had to take a one hour bus "
                "to make it to central London. In case you don't know, we're a group of teenagers based in Cork, "
                "and we're building the future of sales training. Once we got to London, the first thing we did was "
                "get some food. Then we headed to the Apple store and we ended up winning the pitch.")
VO_DUR = VO[-1]["e"] + 0.3


def footage(n_places=10, clips_per_place=3, run=(0.2, 7.8), seed=0):
    rng = np.random.default_rng(seed)
    cands, metrics_, order, clips = [], {}, {}, {}
    k = 0
    for place in range(n_places):
        for j in range(clips_per_place):
            k += 1
            cid = f"c{k:02d}"
            order[cid] = k
            clips[cid] = {"created": 1e9 + place * 3600 + j * 60, "duration": run[1] + 0.2, "path": cid}
            face = 0.2 if (k % 3 == 0) else 0.0
            t = [i / 6 for i in range(int(run[1] * 6) + 1)]
            metrics_[cid] = {"t": t, "blur": [0.3] * len(t), "motion": [0.004] * len(t), "face": [face] * len(t),
                             "face_cx": [0.5] * len(t)}
            mid = (run[0] + run[1]) / 2
            for q, (a, b) in enumerate([(run[0], mid), (mid, run[1])]):
                cands.append({"id": f"{cid}s{q + 1:02d}", "clip": cid, "start": a, "end": b, "dur": b - a,
                              "run": list(run), "score": 0.55 + 0.1 * rng.random(), "flags": [], "face": face,
                              "face_cx": 0.5, "hash": int(rng.integers(0, 2 ** 62))})
    return cands, metrics_, order, clips


def overlaps(tl):
    pics = [(s.get("v_clip", s["clip"]), s.get("v_src_in", s["src_in"]), s["dur"]) for s in tl]
    return [(a, b) for i, a in enumerate(pics) for b in pics[i + 1:]
            if a[0] == b[0] and a[1] < b[1] + b[2] - 0.02 and b[1] < a[1] + a[2] - 0.02]


def cut(cands, metrics_, order, clips, banned=(), template=None, music=None, first=0.7):
    pace_at = plan.pace_curve(VO_DUR, 1.4, template)
    d = director.direct(VO, VO_DUR, cands, {}, metrics_, clips, order, pace_at, first, banned, (), music)
    tl, warns = plan.build_vo_timeline(d["seq"], VO, VO_DUR, cands, {}, metrics_, banned, 1.4, template)
    tl = render.frame_round(tl)
    return tl, warns, d, director.snap_sfx(d["sfx"], tl)


class TestDirector(unittest.TestCase):
    def test_structure(self):
        tl, warns, _, _ = cut(*footage())
        self.assertFalse(warns)
        self.assertEqual(tl[0]["f0"], 0)
        self.assertAlmostEqual((tl[-1]["f0"] + tl[-1]["frames"]) / 30, VO_DUR, delta=1 / 30)
        for a, b in zip(tl, tl[1:]):
            self.assertEqual(a["f0"] + a["frames"], b["f0"])        # no gaps
            self.assertNotEqual(a["shot"], b["shot"])                # never the same shot twice in a row
        for s in tl:
            d = s["frames"] / 30
            if s.get("burst_part"):
                self.assertGreaterEqual(d, BURST["min_shot"] - 1 / 30)
            else:
                self.assertGreaterEqual(d, MIN_SHOT - 1 / 30)
            self.assertLessEqual(d, MAX_SHOT + 1 / 30)
        self.assertEqual(overlaps(tl), [])                           # no frame shown twice
        ons = plan.onsets(VO)
        cuts = [s for s in tl[1:] if not s.get("burst_part")]
        on_word = sum(1 for s in cuts if min(abs(s["f0"] / 30 - o) for o in ons) <= 1.01 / 30)
        self.assertGreaterEqual(on_word / len(cuts), 0.9)            # cuts land on words

    def test_profile_rhythm_opens_fast(self):
        prof = profiles.load("krios")
        tl, _, _, _ = cut(*footage(), template={"curve": prof["curve"]}, first=prof["first_shot"])
        d = [s["frames"] / 30 for s in tl if not s.get("burst_part")]
        first_third = d[: len(d) // 3]
        rest = d[len(d) // 3:]
        self.assertLess(np.mean(first_third), np.mean(rest))
        self.assertLessEqual(tl[0]["frames"] / 30, 1.0)

    def test_bursts_are_distinct_and_clicked(self):
        tl, _, d, fx = cut(*footage())
        groups, cur = [], []
        for s in tl:
            if s.get("burst_part"):
                cur.append(s)
            elif cur:
                groups.append(cur)
                cur = []
        self.assertTrue(groups, "a transition into a new place should get a burst")
        for g in groups:
            ids = [s["shot"] for s in g]
            self.assertEqual(len(ids), len(set(ids)))
            self.assertTrue(3 <= len(g) <= 4)
        burst_cuts = {s["f0"] / 30 for s in tl if s.get("burst_part")}
        for x in fx:
            if x["type"] in ("click", "pop"):
                self.assertTrue(any(abs(x["t"] - b) < 0.02 for b in burst_cuts), "clicks only on burst cuts")
        self.assertLessEqual(sum(1 for x in fx if x["type"] == "whoosh"), 2)

    def test_riser_only_into_payoff_with_hit(self):
        _, _, _, fx = cut(*footage())
        risers = [x for x in fx if x["type"] == "riser"]
        self.assertLessEqual(len(risers), 1)
        for r in risers:
            self.assertTrue(any(h["type"] == "hit" and abs(h["t"] - r["t"]) < 0.02 for h in fx))

    def test_chronology_and_ending(self):
        tl, _, _, _ = cut(*footage())
        m = metrics.measure(tl, VO, footage()[0], {}, footage()[2])
        self.assertGreater(m["chronology"], 0.7)
        self.assertTrue(m["ends_on_face"])
        self.assertTrue(m["opens_on_face"])

    def test_short_takes_never_leave_gaps(self):
        tl, _, _, _ = cut(*footage(n_places=14, run=(0.0, 0.9)))
        self.assertAlmostEqual((tl[-1]["f0"] + tl[-1]["frames"]) / 30, VO_DUR, delta=1 / 30)

    def test_not_enough_footage_warns_and_spreads_reuse(self):
        tl, warns, _, _ = cut(*footage(n_places=1, clips_per_place=2))
        self.assertTrue(any("clean footage" in w for w in warns))
        self.assertTrue(all(a["shot"] != b["shot"] for a, b in zip(tl, tl[1:])))

    def test_banned_shots_never_used(self):
        f = footage()
        banned = {c["id"] for c in f[0][::3]}
        tl, _, _, _ = cut(*f, banned=banned)
        self.assertFalse(banned & {s["shot"] for s in tl})

    def test_music_puts_bursts_on_the_beat(self):
        beats = list(np.arange(0.25, VO_DUR + 2, 0.6))   # 100 BPM
        tl, _, _, _ = cut(*footage(), music=beats)
        grid = np.sort(np.concatenate([beats, np.array(beats[:-1]) + 0.3]))
        parts = [s for s in tl if s.get("burst_part")]
        self.assertTrue(parts)
        for s in parts:
            self.assertLessEqual(float(np.min(np.abs(grid - s["f0"] / 30))), 1.01 / 30)


class TestStory(unittest.TestCase):
    def test_beats_and_intents(self):
        bts = story.beats(VO)
        self.assertEqual(bts[0]["intent"], "hook")
        intents = {b["text"].split()[0]: b["intent"] for b in bts}
        self.assertEqual(intents.get("Once"), "transition")
        self.assertTrue(any(b["intent"] == "payoff" and "winning" in b["text"] for b in bts))
        self.assertFalse(any(b["intent"] == "payoff" and "got in" in b["text"] for b in bts))


class TestSound(unittest.TestCase):
    def _env(self, path):
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "-"],
                           capture_output=True, check=True)
        return np.abs(np.frombuffer(r.stdout, np.float32))

    def test_effects_land_exactly(self):
        events = [{"t": 1.0, "type": "click"}, {"t": 3.0, "type": "whoosh"}, {"t": 6.0, "type": "riser", "len": 2.0},
                  {"t": 6.0, "type": "hit"}]
        with tempfile.TemporaryDirectory() as d:
            env = self._env(sfx.build_track(events, 8.0, 0.7, [], Path(d) / "fx.wav"))
        sr = 48000
        w = env[int(0.9 * sr):int(1.1 * sr)]
        self.assertLess(abs((np.argmax(w > 0.3 * w.max()) + int(0.9 * sr)) / sr - 1.0), 0.002)   # click attack
        w = np.convolve(env[int(2.5 * sr):int(3.5 * sr)], np.ones(480) / 480, "same")
        self.assertLess(abs((np.argmax(w) + int(2.5 * sr)) / sr - 3.0), 0.03)                  # whoosh peaks on cut
        pre = env[int(4.0 * sr):int(5.99 * sr)]
        self.assertGreater(pre[-int(0.3 * sr):].mean(), pre[:int(0.3 * sr)].mean() * 3)      # riser rises
        self.assertLess(env[int(5.93 * sr):int(5.995 * sr)].max(), 0.05)                       # breath before reveal

    def test_audible_on_phone_speakers(self):
        for k in ("click", "pop", "whoosh", "riser", "hit", "shutter"):
            x = sfx.sound(k, 0, {}).mean(1)
            sp = np.abs(np.fft.rfft(x)) ** 2
            f = np.fft.rfftfreq(len(x), 1 / 48000)
            self.assertGreater(sp[f >= 150].sum() / sp.sum(), 0.7, k)


class TestMusic(unittest.TestCase):
    def test_tempo_and_beats(self):
        from m5e import music
        sr = 48000
        for bpm in (95, 140):
            rng = np.random.default_rng(0)
            n = int(20 * sr)
            x = 0.03 * rng.standard_normal(n)
            period = 60 / bpm
            truth = np.arange(0.4, 19.5, period)
            tt = np.arange(int(0.15 * sr)) / sr
            kick = np.sin(2 * np.pi * np.cumsum(60 + 90 * np.exp(-tt / 0.02)) / sr) * np.exp(-tt / 0.08)
            for k, t in enumerate(truth):
                i = int(t * sr)
                x[i:i + len(tt)] += 0.8 * kick
                if k % 2:
                    x[i:i + len(tt)] += 0.4 * rng.standard_normal(len(tt)) * np.exp(-tt / 0.05)
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / "m.wav"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f64le", "-ar", str(sr), "-ac", "1", "-i", "-",
                                str(p)], input=x.astype(np.float64).tobytes(), check=True)
                r = music.track(str(p))
            self.assertLess(abs(r["bpm"] - bpm) / bpm, 0.03)
            b = np.array(r["beats"])
            err = [np.min(np.abs(b - t)) for t in truth[2:-2]]
            self.assertLess(np.median(err), 0.015)


class TestCaptions(unittest.TestCase):
    def test_chunks_break_at_sentences_and_fit_three_lines(self):
        for ch in captions.chunk(VO):
            self.assertLessEqual(len(captions.wrap([w["w"] for w in ch])), CAPTION["max_lines"])
            for w in ch[:-1]:
                self.assertFalse(w["w"].endswith((".", "?", "!")), "a sentence end must close its block")

    def test_ass_and_srt(self):
        with tempfile.TemporaryDirectory() as d:
            ass = captions.build_ass(VO, Path(d) / "c.ass")
            srt = captions.build_srt(VO, Path(d) / "c.srt")
            self.assertIn("Poppins", ass.read_text())
            self.assertIn("\\alpha&HFF&", ass.read_text())   # unspoken words invisible: word-by-word reveal
            self.assertEqual(len(captions.read_srt_words(srt)), len(VO))


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
