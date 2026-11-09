"""The whole pipeline for one folder of clips."""
from __future__ import annotations

import hashlib
import html
import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import analyze, audio, brain, captions, fcpxml, media, plan, reference, render, style, transcribe

WORK = "m5e_project"
OUT = "m5e_out"
DEFAULT_CONTEXT = ("Footage for @kriosfounders on Instagram: the three teenage founders of Krios, an AI sales-training "
                   "startup from Cork, Ireland (Ahroon, Michael and Abraham), filming their day.")


class Project:
    def __init__(self, folder: str | Path, log=print):
        self.folder = Path(folder).expanduser().resolve()
        if not self.folder.is_dir():
            raise SystemExit(f"Not a folder: {self.folder}")
        self.work = self.folder / WORK
        self.out = self.folder / OUT
        for d in (self.work, self.work / "clips", self.work / "strips", self.work / "shots", self.work / "review", self.out):
            d.mkdir(parents=True, exist_ok=True)
        self.log = log
        self.cfg = self._config()
        self.state_path = self.work / "project.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.state.setdefault("ban", [])
        self.state.setdefault("must", [])
        self.state.setdefault("notes", {})
        self.ref, self.style_ref, self.notes = {}, "", {}

    # ------------------------------------------------------------------ setup
    def _config(self) -> dict:
        p = self.folder / "m5e.json"
        cfg = {"pace": style.PACE, "whisper": "small", "context": DEFAULT_CONTEXT, "brief": "", "lut": None,
               "grade": style.GRADE, "max_len": 60, "review_passes": 2, "tighten_vo": True, "stabilize": False,
               "vocab": style.VOCAB, "fixes": {}, "name": self.folder.name}
        self._user_cfg = json.loads(p.read_text()) if p.exists() else {}
        cfg.update(self._user_cfg)
        if cfg.get("lut"):
            lut = Path(cfg["lut"]).expanduser()
            cfg["lut"] = str(lut if lut.is_absolute() else (self.folder / lut))
            if not Path(cfg["lut"]).exists():
                raise SystemExit(f"LUT not found: {cfg['lut']}")
        return cfg

    def save(self):
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def scan(self, vo_path: str | None = None, music: str | None = None, ref: str | None = None):
        files = []
        for p in sorted(self.folder.rglob("*")):
            if not p.is_file() or WORK in p.parts or OUT in p.parts or p.name.startswith("."):
                continue
            if p.suffix.lower() in media.VIDEO_EXT | media.AUDIO_EXT:
                files.append(p)
        vo = Path(vo_path).resolve() if vo_path else None
        mus = Path(music).resolve() if music else None
        ref = ref or self.cfg.get("reference")
        refp = Path(ref).expanduser().resolve() if ref else None
        clips = []
        for p in files:
            stem = p.stem.lower()
            if refp is None and (stem.startswith("ref") or stem.startswith("reference")):
                refp = p
                continue
            if p == refp:
                continue
            if vo is None and (stem.startswith("vo") or "voiceover" in stem or stem.startswith("voice")):
                vo = p
                continue
            if mus is None and stem.startswith("music"):
                mus = p
                continue
            if p in (vo, mus):
                continue
            info = media.probe(p)
            if not info["has_video"]:
                if vo is None and info["has_audio"]:
                    vo = p
                continue
            if info["duration"] < 0.8:
                continue
            clips.append(info)
        if not clips:
            raise SystemExit("No video clips found in the folder.")
        clips.sort(key=lambda c: (c["created"], c["path"]))
        self.clips = {f"c{i + 1:02d}": c for i, c in enumerate(clips)}
        self.clip_order = {cid: i + 1 for i, cid in enumerate(self.clips)}
        self.vo = str(vo) if vo else None
        self.music = str(mus) if mus else None
        self.ref_path = str(refp) if refp else None
        self.log(f"Found {len(self.clips)} clips"
                 f"{', voiceover: ' + Path(self.vo).name if self.vo else ', no voiceover'}"
                 f"{', music: ' + Path(self.music).name if self.music else ''}"
                 f"{', reference: ' + Path(self.ref_path).name if self.ref_path else ''}")
        hdr = [c for c in self.clips.values() if c.get("hdr")]
        if hdr:
            self.log(f"  {len(hdr)} HDR clip(s): converting to SDR with tone-mapping")

    # ------------------------------------------------------------------ analysis
    def analyze(self):
        self.log("Checking every clip for focus, shake, exposure, faces and duplicates...")
        results = {}

        def one(item):
            cid, info = item
            return cid, analyze.analyze_clip(cid, info, self.work / "clips")

        workers = max(1, min(4, (os.cpu_count() or 2) // 2))
        with ThreadPoolExecutor(workers) as ex:
            for cid, res in ex.map(one, self.clips.items()):
                results[cid] = res
                info = self.clips[cid]
                rej = ", ".join(f"{v / analyze.SAMPLE_FPS:.1f}s {k}" for k, v in res["rejected_frames"].items())
                self.log(f"  {cid} {Path(info['path']).name}: {info['duration']:.1f}s -> "
                         f"{len(res['candidates'])} usable shot(s){'; dropped ' + rej if rej else ''}")
        self.metrics = {cid: r["metrics"] for cid, r in results.items()}
        cands = [c for r in results.values() for c in r["candidates"]]
        for c in cands:
            if render.upscale_needed(self.clips[c["clip"]]) > 1 / style.MIN_SOURCE_SCALE:
                if "low-res crop" not in c["flags"]:
                    c["flags"].append("low-res crop")
        analyze.mark_duplicates(cands)
        self.cands = cands
        for c in cands:
            strip = self.work / "strips" / f"{c['id']}.jpg"
            if not strip.exists() or strip.stat().st_mtime < os.path.getmtime(self.clips[c["clip"]]["path"]):
                analyze.make_strip(self.clips[c["clip"]], c, strip, metrics=self.metrics[c["clip"]])
        dups = sum("duplicate" in c["flags"] for c in cands)
        self.log(f"  {len(cands)} candidate shots ({dups} near-duplicates set aside)")

    def understand(self):
        """AI looks at every candidate shot and logs what's actually in it."""
        if not brain.available():
            self.log("No Anthropic API key found: using the rule-based editor (focus/faces/chronology only).")
            self.notes = {}
            return
        def key(c):
            return hashlib.sha1(json.dumps([c["id"], c["start"], c["end"], self.clips[c["clip"]]["path"]]).encode()).hexdigest()[:12]
        todo = [c for c in self.cands if "duplicate" not in c["flags"]
                and self.state["notes"].get(c["id"], {}).get("_key") != key(c)]
        if todo:
            self.log(f"AI is looking at {len(todo)} shots to understand what's in them...")
            notes = brain.describe(todo, self.work / "strips", self.clip_order, self.cfg.get("context", ""))
            for c in todo:
                if c["id"] in notes:
                    self.state["notes"][c["id"]] = {**notes[c["id"]], "_key": key(c)}
            self.save()
        self.notes = {k: v for k, v in self.state["notes"].items() if any(c["id"] == k for c in self.cands)}

    # ------------------------------------------------------------------ reference
    def study_reference(self):
        self.ref, self.style_ref = {}, ""
        if not self.ref_path:
            return
        self.ref = reference.load(self.ref_path, self.work, lambda p: transcribe.transcribe(
            p, self.cfg["whisper"], self.cfg["vocab"], self.cfg["fixes"]), self.log)
        self.style_ref = reference.style_text(self.ref)
        if "pace" not in self._user_cfg:
            self.cfg["pace"] = float(min(max(self.ref["rhythm"]["median"], 0.6), 3.0))
            self.log(f"  cutting at the reference's pace: {self.cfg['pace']:.2f}s median shot")
        if self.ref.get("look") and "grade" not in self._user_cfg:
            looks = []
            for cid, info in self.clips.items():
                lk = self.state.setdefault("looks", {}).get(cid)
                if not lk:
                    lk = reference.look(info["path"], info)
                    self.state["looks"][cid] = lk
                looks.append(lk)
            self.save()
            self.cfg["grade"] = reference.grade_towards(self.ref["look"], looks, style.GRADE)
            self.log(f"  look matched towards the reference: {self.cfg['grade'].split(',')[0]}")

    # ------------------------------------------------------------------ voice
    def prepare_voice(self):
        self.mode = "vo" if self.vo else "talk"
        self.words, self.vo_tight, self.vo_dur = [], None, 0.0
        if self.vo:
            self.log("Transcribing the voiceover...")
            raw = transcribe.transcribe(self.vo, self.cfg["whisper"], self.cfg["vocab"], self.cfg["fixes"])
            if not raw:
                raise SystemExit("Couldn't hear any speech in the voiceover file.")
            self.vo_tight, self.words, self.vo_dur = audio.tighten(self.vo, raw, self.work / "vo_tight.wav",
                                                                   self.cfg["tighten_vo"])
            raw_dur = media.probe(self.vo)["duration"]
            self.log(f"  voiceover {raw_dur:.1f}s -> {self.vo_dur:.1f}s after tightening pauses; "
                     f"\"{' '.join(w['w'] for w in self.words[:12])}...\"")
            return
        self.log("No voiceover file: looking for people talking in the clips...")
        self.clip_words = {}
        cache = self.state.setdefault("clip_words", {})
        for cid, info in self.clips.items():
            if not info["has_audio"]:
                continue
            k = f"{info['path']}|{os.path.getmtime(info['path'])}"
            if cache.get(cid, {}).get("k") != k:
                cache[cid] = {"k": k, "w": transcribe.transcribe(info["path"], self.cfg["whisper"], self.cfg["vocab"],
                                                                  self.cfg["fixes"])}
            if cache[cid]["w"]:
                self.clip_words[cid] = cache[cid]["w"]
        self.save()
        if not self.clip_words:
            self.mode = "montage"
            self.log("  nobody talking either: making a montage (add music.mp3 to the folder for a soundtrack)")

    # ------------------------------------------------------------------ planning
    def plan(self, revision_notes: str = ""):
        ban, must = set(self.state["ban"]), set(self.state["must"])
        pace = float(self.cfg["pace"])
        use_ai = bool(self.notes) and brain.available()
        if self.mode in ("vo", "montage"):
            words, dur = self.words, self.vo_dur
            if self.mode == "montage":
                usable = sum(c["dur"] for c in plan.eligible(self.cands, self.notes, ban))
                dur = min(float(self.cfg.get("montage_len", 20)), usable * 0.8)
                words = [{"w": "", "s": round(t * pace / 2, 3), "e": round(t * pace / 2 + 0.1, 3)}
                         for t in range(int(dur / (pace / 2)))]
                self.vo_dur = dur
            segs = None
            if use_ai:
                try:
                    self.log("AI editor is planning the cut against the voiceover...")
                    p = brain.plan_vo(words, dur, [c for c in self.cands if "duplicate" not in c["flags"]],
                                      self.notes, self.clip_order, pace, ban, must, revision_notes, self.cfg["brief"],
                                      self.style_ref)
                    segs = plan.vo_plan_to_seq([s.model_dump() for s in p.segments], words)
                    self.state["ai_notes"] = {"hook": p.hook_note, "vo_feedback": p.vo_feedback}
                except brain.BrainError as e:
                    self.log(f"  AI editor unavailable ({e}); using the rule-based editor.")
            if segs is None:
                template = self.ref["rhythm"]["shots"] if self.ref else None
                segs = plan.heuristic_vo(words, dur, self.cands, self.notes, self.metrics, self.clip_order, pace, ban,
                                         must, template)
            self.timeline, warns = plan.build_vo_timeline(segs, words, dur, self.cands, self.notes, self.metrics,
                                                          ban, pace, self.ref["rhythm"]["shots"] if self.ref else None)
            for w in warns:
                self.log(f"  note: {w}")
            self.state["warnings"] = warns
            self.cap_words = self.words if self.mode == "vo" else []
        else:
            utts = plan.utterances(self.clip_words)
            segs = None
            if use_ai:
                try:
                    self.log("AI editor is choosing the best moments and lines...")
                    p = brain.plan_talk(utts, [c for c in self.cands if "duplicate" not in c["flags"]], self.notes,
                                        self.clip_order, float(self.cfg["max_len"]), ban, must, revision_notes,
                                        self.cfg["brief"], self.style_ref)
                    segs = [s.model_dump() for s in p.segments]
                    self.state["ai_notes"] = {"hook": p.hook_note}
                except brain.BrainError as e:
                    self.log(f"  AI editor unavailable ({e}); using the rule-based editor.")
            if segs is None:
                segs = plan.heuristic_talk(utts, self.cands, self.notes, self.clip_order, float(self.cfg["max_len"]), ban)
            self.timeline, self.cap_words = plan.build_talk_timeline(segs, self.clip_words, self.cands, self.notes,
                                                                     self.metrics, banned=ban)
            if not self.timeline:
                raise SystemExit("Nothing usable to cut: no clean footage and no clear speech.")
            self.vo_dur = self.timeline[-1]["t1"]
        plan.fill_face_positions(self.timeline, self.metrics, self.cands)
        self.timeline = render.frame_round(self.timeline)
        self.state["timeline"] = self.timeline
        self.state["cap_words"] = self.cap_words
        self.save()
        self.log(f"  {len(self.timeline)} shots, {self.timeline[-1]['t1']:.1f}s, "
                 f"average {self.timeline[-1]['t1'] / max(len(self.timeline), 1):.2f}s per shot")

    # ------------------------------------------------------------------ render
    def _shot_cache_key(self, s):
        info = self.clips[s.get("v_clip", s["clip"])]
        return hashlib.sha1(json.dumps([info["path"], os.path.getmtime(info["path"]), s.get("v_src_in", s["src_in"]),
                                        s["frames"],
                                        s.get("face_cx"), self.cfg["lut"], self.cfg["grade"],
                                        self.cfg["stabilize"], style.WIDTH, style.FPS]).encode()).hexdigest()[:16]

    def render(self, final_name: str | None = None) -> Path:
        self.log("Rendering shots (lossless)...")
        files, todo = [], []
        for s in self.timeline:
            f = self.work / "shots" / f"{self._shot_cache_key(s)}.mp4"
            files.append(f)
            if not f.exists():
                todo.append((s, f))
        tmp = self.work / "shots" / "tmp"
        if todo:
            made = render.render_shots([t[0] for t in todo], self.clips, tmp, self.cfg["lut"], self.cfg["grade"],
                                       self.cfg["stabilize"], log=lambda m: None)
            for (s, f), m in zip(todo, made):
                shutil.move(str(m), f)
        video = render.concat_video(files, self.work / "video.mp4")
        total = (self.timeline[-1]["f0"] + self.timeline[-1]["frames"]) / style.FPS
        ass = None
        srt_path = self.out / "captions.srt"
        if self.cap_words:
            words = self.cap_words
            if srt_path.exists() and self.state.get("captions_mtime") and \
                    srt_path.stat().st_mtime > self.state["captions_mtime"] + 1 and self.mode == "vo":
                self.log("  using your edited captions.srt")
                words = captions.read_srt_words(srt_path)
            else:
                captions.build_srt(words, srt_path)
                self.state["captions_mtime"] = srt_path.stat().st_mtime
            ass = captions.build_ass(words, self.work / "captions.ass", end_time=total)
        voice = Path(self.vo_tight) if self.mode == "vo" else (
            render.talk_audio(self.timeline, self.clips, self.work) if self.mode == "talk" else None)
        name = final_name or self.cfg["name"]
        out = self.out / f"{name}.mp4"
        self.log("Final encode (captions burned in)...")
        render.final(video, ass, voice, out, total, self.music, voice_is_vo=self.mode == "vo")
        fcpxml.export(self.timeline, self.clips, self.out / f"{name}.fcpxml", name,
                      (Path(self.vo_tight), self.vo_dur) if self.mode == "vo" else None)
        self.save()
        self.log(f"  -> {out}")
        return out

    # ------------------------------------------------------------------ review loop
    def edl_text(self) -> str:
        rows = []
        for i, s in enumerate(self.timeline):
            t0, t1 = s["f0"] / style.FPS, (s["f0"] + s["frames"]) / style.FPS
            said = " ".join(w["w"] for w in self.cap_words if t0 - 0.05 <= w["s"] < t1 - 0.05)
            n = self.notes.get(s.get("shot") or "", {})
            rows.append(f"{i}: {t0:5.2f}-{t1:5.2f}s ({t1 - t0:.2f}s) shot {s.get('shot')} [{n.get('what', '')}] "
                        f"| said: \"{said}\"")
        return "\n".join(rows)

    def review_loop(self, out: Path) -> Path:
        passes = int(self.cfg.get("review_passes", 2))
        if not brain.available() or not self.notes or passes <= 0:
            return out
        history = []
        for k in range(passes):
            sheets = render.contact_sheets(out, self.work / "review")
            self.log(f"AI reviewer is watching the cut (pass {k + 1}/{passes})...")
            try:
                rv = brain.review(sheets, self.edl_text(), self.style_ref)
            except brain.BrainError as e:
                self.log(f"  review unavailable ({e})")
                break
            history.append(rv.model_dump())
            self.state["reviews"] = history
            self.save()
            self.log(f"  score {rv.score}/10" + (" - ship it" if rv.ship_it else f", {len(rv.fixes)} fixes"))
            for f in rv.fixes:
                self.log(f"    seg {f.segment}: {f.problem} -> {f.fix}")
            if rv.ship_it or not rv.fixes:
                break
            notes = "\n".join(f"- segment {f.segment}: {f.problem}. Fix: {f.fix}" for f in rv.fixes)
            self.plan(revision_notes=notes)
            out = self.render()
        return out

    # ------------------------------------------------------------------ report
    def report(self) -> Path:
        rows = []
        for i, s in enumerate(self.timeline):
            n = self.notes.get(s.get("shot") or "", {})
            t0, t1 = s["f0"] / style.FPS, (s["f0"] + s["frames"]) / style.FPS
            said = " ".join(w["w"] for w in self.cap_words if t0 - 0.05 <= w["s"] < t1 - 0.05)
            strip = f"../{WORK}/strips/{s['shot']}.jpg" if s.get("shot") else ""
            rows.append(f"<tr><td>{i}</td><td>{t0:.2f}-{t1:.2f}s<br>{t1 - t0:.2f}s</td>"
                        f"<td>{'<img src=' + html.escape(strip) + '>' if strip else ''}</td>"
                        f"<td><b>{html.escape(s.get('shot') or s['clip'])}</b> {html.escape(Path(self.clips[s['clip']]['path']).name)} "
                        f"@{s['src_in']:.2f}s<br>{html.escape(n.get('what', ''))}<br><i>{html.escape(s.get('why', ''))}</i></td>"
                        f"<td>{html.escape(said)}</td></tr>")
        rej = []
        used = {s.get("shot") for s in self.timeline}
        for c in self.cands:
            if c["id"] in used:
                continue
            n = self.notes.get(c["id"], {})
            why = ", ".join(c["flags"]) or ("soft focus (AI)" if n and not n.get("focus_ok", True) else "")
            rej.append(f"<div class=c><img src='../{WORK}/strips/{c['id']}.jpg'><br><b>{c['id']}</b> "
                       f"score {c['score']:.2f} {html.escape(why)}<br>{html.escape(n.get('what', ''))}</div>")
        reviews = "".join(f"<li>Pass {i + 1}: {r['score']}/10 - " + "; ".join(html.escape(f"seg {f['segment']}: {f['problem']}")
                          for f in r["fixes"]) + "</li>" for i, r in enumerate(self.state.get("reviews", [])))
        ai = self.state.get("ai_notes", {})
        doc = f"""<!doctype html><meta charset=utf-8><title>m5e report</title>
<style>body{{font:14px system-ui;margin:16px;background:#111;color:#eee}}img{{height:90px}}td{{border-top:1px solid #333;
padding:6px;vertical-align:top}}.c{{display:inline-block;width:330px;margin:4px;vertical-align:top}}</style>
<h1>{html.escape(self.cfg['name'])}</h1><p>mode: {self.mode} · {len(self.timeline)} shots ·
{self.timeline[-1]['t1']:.1f}s</p><p>{html.escape(ai.get('hook', ''))}</p><p>{html.escape(ai.get('vo_feedback', ''))}</p>
<ul>{reviews}</ul><h2>Cut</h2><table>{''.join(rows)}</table><h2>Not used</h2>{''.join(rej)}"""
        p = self.out / "report.html"
        p.write_text(doc, encoding="utf-8")
        return p

    # ------------------------------------------------------------------ all
    def make(self, vo=None, music=None, ref=None, review=True) -> Path:
        t = time.time()
        self.scan(vo, music, ref)
        self.analyze()
        self.study_reference()
        self.understand()
        self.prepare_voice()
        self.plan()
        out = self.render()
        if review:
            out = self.review_loop(out)
        self.report()
        self.log(f"Done in {time.time() - t:.0f}s: {out}")
        return out
