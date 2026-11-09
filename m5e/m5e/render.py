"""Render the timeline: lossless per-shot intermediates -> one high-quality final encode with captions."""
from __future__ import annotations

import subprocess
from pathlib import Path

from . import audio, media
from .style import (AUDIO_AAC, DOWNSCALE_SHARPEN, FINAL_X264, FONTS_DIR, FPS, GRADE, HEIGHT, LOSSLESS_X264,
                    SCALE_FLAGS, SHARPEN_MIN_RATIO, TARGET_LUFS, WIDTH)


def crop_box(info: dict, face_cx: float | None) -> tuple[int, int, int, int]:
    """9:16 crop of the source (display orientation). Horizontal footage follows the face."""
    w, h = info["w"], info["h"]
    target = WIDTH / HEIGHT
    if w / h > target + 0.01:
        cw, ch = int(round(h * target / 2) * 2), h
        cx = (face_cx if face_cx is not None else 0.5) * w
        x = int(min(max(cx - cw / 2, 0), w - cw)) // 2 * 2
        return cw, ch, x, 0
    if w / h < target - 0.01:
        cw, ch = w, int(round(w / target / 2) * 2)
        y = int((h - ch) * 0.4) // 2 * 2   # keep a little more headroom than a centre crop
        return cw, ch, 0, y
    return w, h, 0, 0


def upscale_needed(info: dict) -> float:
    cw, _, _, _ = crop_box(info, None)
    return WIDTH / cw


def _vf(info: dict, face_cx, lut: str | None, grade: str, stab_trf: Path | None) -> str:
    cw, ch, x, y = crop_box(info, face_cx)
    parts = []
    if stab_trf:
        parts.append(f"vidstabtransform=input='{stab_trf.as_posix()}':smoothing=15:zoom=2:optzoom=0:interpol=bicubic")
    if (cw, ch) != (info["w"], info["h"]):
        parts.append(f"crop={cw}:{ch}:{x}:{y}")
    sdr = media.sdr_filter(info)
    if sdr:
        parts.append(sdr)
    if lut:
        parts.append(f"lut3d=file='{Path(lut).as_posix()}':interp=tetrahedral")
    parts.append(f"scale={WIDTH}:{HEIGHT}:flags={SCALE_FLAGS}")
    parts.append(f"fps={FPS}")
    if grade:
        parts.append(grade)
    if cw / WIDTH >= SHARPEN_MIN_RATIO and "unsharp" not in (grade or ""):
        parts.append(DOWNSCALE_SHARPEN)
    parts += ["setsar=1", "format=yuv420p"]
    return ",".join(parts)


def frame_round(timeline: list[dict]) -> list[dict]:
    """Snap every cut to a frame boundary so picture and sound can't drift."""
    out = []
    for s in timeline:
        f0, f1 = round(s["t0"] * FPS), round(s["t1"] * FPS)
        if f1 <= f0:
            continue
        out.append({**s, "f0": f0, "frames": f1 - f0})
    return out


def render_shots(timeline, clips, work: Path, lut=None, grade=GRADE, stabilize=False, log=print) -> list[Path]:
    work.mkdir(parents=True, exist_ok=True)
    files = []
    for i, s in enumerate(timeline):
        info = clips[s.get("v_clip", s["clip"])]          # picture source (differs from sound on an L-cut)
        src_in = s.get("v_src_in", s["src_in"])
        out = work / f"shot_{i:03d}.mp4"
        dur = s["frames"] / FPS
        trf = None
        if stabilize and media.has_filter("vidstabdetect"):
            trf = work / f"shot_{i:03d}.trf"
            media.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{src_in:.3f}", "-i", info["path"],
                       "-t", f"{dur + 0.1:.3f}", "-vf", f"vidstabdetect=result='{trf.as_posix()}':shakiness=5",
                       "-f", "null", "-"])
        vf = _vf(info, s.get("face_cx"), lut, grade, trf)
        media.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{src_in:.3f}", "-i", info["path"],
                   "-vf", vf, "-frames:v", str(s["frames"]), "-an", *LOSSLESS_X264, str(out)])
        files.append(out)
        log(f"  shot {i + 1}/{len(timeline)} rendered")
    return files


def concat_video(files: list[Path], out: Path) -> Path:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{f.resolve().as_posix()}'\n" for f in files))
    media.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
    return out


def talk_audio(timeline, clips, work: Path) -> Path:
    files = []
    for i, s in enumerate(timeline):
        info = clips[s["clip"]]
        d = s["frames"] / FPS
        f = work / f"aud_{i:03d}.wav"
        media.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{s['src_in']:.3f}", "-i", info["path"],
                   "-t", f"{d:.4f}", "-vn", "-af", f"afade=t=in:d=0.012,afade=t=out:st={max(d - 0.015, 0):.4f}:d=0.015,"
                   f"apad=whole_dur={d:.4f}", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", str(f)])
        files.append(f)
    out = work / "talk.wav"
    lst = work / "talk.txt"
    lst.write_text("".join(f"file '{f.resolve().as_posix()}'\n" for f in files))
    media.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
    return out


def ambience_track(timeline, clips, work: Path) -> Path | None:
    """Each shot's own sound (what you see is what you hear), with tiny fades at the cuts."""
    if not any(clips[s.get("v_clip", s["clip"])].get("has_audio") for s in timeline):
        return None
    files = []
    for i, s in enumerate(timeline):
        info = clips[s.get("v_clip", s["clip"])]
        d = s["frames"] / FPS
        f = work / f"amb_{i:03d}.wav"
        if info.get("has_audio"):
            media.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{s.get('v_src_in', s['src_in']):.3f}",
                       "-i", info["path"], "-t", f"{d:.4f}", "-vn",
                       "-af", f"afade=t=in:d=0.02,afade=t=out:st={max(d - 0.02, 0):.4f}:d=0.02,apad=whole_dur={d:.4f}",
                       "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", str(f)])
        else:
            media.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{d:.4f}",
                       "-c:a", "pcm_s24le", str(f)])
        files.append(f)
    out = work / "ambience.wav"
    lst = work / "ambience.txt"
    lst.write_text("".join(f"file '{f.resolve().as_posix()}'\n" for f in files))
    media.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
    return out


def _loudness(path: Path) -> float | None:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = [ln for ln in r.stderr.splitlines() if ln.strip().startswith("I:")]
    try:
        v = float(m[-1].split()[1])
        return v if v > -70 else None
    except (IndexError, ValueError):
        return None


def mix_audio(work: Path, total: float, voice: Path | None, voice_is_vo: bool = True, ambience: Path | None = None,
              music: str | None = None, sfx_track: Path | None = None) -> Path | None:
    """Voice at -14 LUFS; ambience tucked ~22 dB under it and ducked while it speaks (so it breathes in the
    pauses); music ~8 dB under it, ducked a further few dB under speech; sound effects on top; limiter;
    final two-pass loudness to -14 LUFS / -1 dBTP."""
    from .style import AMBIENCE_UNDER_VO_DB, MUSIC_UNDER_VO_DB
    if voice is None and music is None:
        return None
    stems = []
    vo = work / "stem_voice.wav"
    if voice is not None:
        chain = audio.vo_chain(str(voice)) if voice_is_vo else audio.loudnorm_filter(str(voice))
        media.run(["ffmpeg", "-v", "error", "-y", "-i", str(voice), "-af", chain + ",aformat=channel_layouts=stereo",
                   "-ar", "48000", "-t", f"{total:.3f}", "-c:a", "pcm_s24le", str(vo)])
        stems.append(("voice", vo))

    def bed(src, name, under, extra=""):
        out = work / f"stem_{name}.wav"
        lv = _loudness(Path(src))
        if lv is None:
            return None
        gain = (TARGET_LUFS - under) - lv
        loop = ["-stream_loop", "-1"] if name == "music" else []
        media.run(["ffmpeg", "-v", "error", "-y", *loop, "-i", str(src), "-t", f"{total:.3f}", "-af",
                   ",".join(filter(None, [extra, f"volume={gain:.2f}dB", "aformat=channel_layouts=stereo",
                                          f"afade=t=out:st={max(total - 1.2, 0):.3f}:d=1.2" if name == "music" else ""])),
                   "-ar", "48000", "-c:a", "pcm_s24le", str(out)])
        return out

    amb = bed(ambience, "ambience", AMBIENCE_UNDER_VO_DB if voice_is_vo else 0,
              "highpass=f=100,lowpass=f=10000") if (ambience is not None and voice_is_vo) else None
    mus = bed(music, "music", MUSIC_UNDER_VO_DB if voice is not None else 0) if music else None
    inputs, fc, mix_in = [], [], []
    for p_ in [vo if voice is not None else None, amb, mus, sfx_track]:
        if p_ is not None:
            inputs += ["-i", str(p_)]
    idx = 0
    labels = {}
    for name, p_ in [("voice", vo if voice is not None else None), ("amb", amb), ("mus", mus), ("sfx", sfx_track)]:
        if p_ is not None:
            labels[name] = f"[{idx}:a]"
            idx += 1
    keys = []
    if "voice" in labels:
        n_keys = sum(1 for k in ("amb", "mus") if k in labels)
        if n_keys:
            fc.append(f"{labels['voice']}asplit={n_keys + 1}[v0]" + "".join(f"[k{i}]" for i in range(n_keys)))
            keys = [f"[k{i}]" for i in range(n_keys)]
            mix_in.append("[v0]")
        else:
            mix_in.append(labels["voice"])
    ki = 0
    for name, thr, ratio in (("amb", 0.02, 4), ("mus", 0.025, 3.5)):
        if name in labels:
            if keys:
                fc.append(f"{labels[name]}{keys[ki]}sidechaincompress=threshold={thr}:ratio={ratio}:attack=15:release=280[{name}d]")
                ki += 1
                mix_in.append(f"[{name}d]")
            else:
                mix_in.append(labels[name])
    if "sfx" in labels:
        mix_in.append(labels["sfx"])
    fc.append("".join(mix_in) + f"amix=inputs={len(mix_in)}:normalize=0:duration=longest,"
              f"atrim=0:{total:.3f},alimiter=limit=0.89:level=false[mix]")
    pre = work / "mix_pre.wav"
    media.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", "[mix]",
               "-ar", "48000", "-c:a", "pcm_s24le", str(pre)])
    out = work / "mix.wav"
    media.run(["ffmpeg", "-v", "error", "-y", "-i", str(pre), "-af", audio.loudnorm_filter(str(pre)),
               "-ar", "48000", "-c:a", "pcm_s24le", str(out)])
    return out


def final(video: Path, ass: Path | None, voice: Path | None, out: Path, total: float, music: str | None = None,
          voice_is_vo: bool = True, mixed: Path | None = None) -> Path:
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", str(video)]
    fc = []
    vin = "[0:v]"
    if ass:
        fc.append(f"{vin}subtitles=filename='{ass.as_posix()}':fontsdir='{FONTS_DIR.as_posix()}'[v]")
        vin = "[v]"
    amap = None
    if mixed is not None:
        cmd += ["-i", str(mixed)]
        amap = "1:a"
    elif voice:
        cmd += ["-i", str(voice)]
        chain = audio.vo_chain(str(voice)) if voice_is_vo else audio.loudnorm_filter(str(voice))
        fc.append(f"[1:a]{chain},aformat=channel_layouts=stereo,apad[vo]")
        amap = "[vo]"
        if music:
            cmd += ["-stream_loop", "-1", "-i", music]
            fc.append(f"[2:a]loudnorm=I={TARGET_LUFS - 16}:TP=-6,aformat=channel_layouts=stereo[mu]")
            fc.append("[vo]asplit=2[vo1][vo2]")
            fc.append("[mu][vo2]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck]")
            fc.append("[vo1][duck]amix=inputs=2:normalize=0:duration=first[mix]")
            amap = "[mix]"
    if fc:
        cmd += ["-filter_complex", ";".join(fc)]
    cmd += ["-map", vin if ass else "0:v"]
    if amap:
        cmd += ["-map", amap, *AUDIO_AAC]
    cmd += [*FINAL_X264, "-r", str(FPS), "-t", f"{total:.3f}", str(out)]
    media.run(cmd)
    return out


def contact_sheets(video: Path, work: Path, every: float = 0.5, cols: int = 8, rows: int = 4) -> list[Path]:
    """Frames every half second with timestamps: what the AI reviewer (and you) look at."""
    info = media.probe(video)
    per = cols * rows
    n = int(info["duration"] / every) + 1
    sheets = []
    font = (FONTS_DIR / "Poppins-Bold.ttf").as_posix()
    for k in range(0, n, per):
        start = k * every
        out = work / f"sheet_{k // per:02d}.jpg"
        media.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-ss", f"{start:.3f}", "-i", str(video),
                   "-vf", f"setpts=PTS+{start}/TB,fps={1 / every},scale=180:320,drawtext=fontfile='{font}':"
                          f"text='%{{pts\\:hms}}':x=4:y=4:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6,"
                          f"tile={cols}x{rows}:padding=2",
                   "-frames:v", "1", "-q:v", "3", str(out)])
        sheets.append(out)
    return sheets
