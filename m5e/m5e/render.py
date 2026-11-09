"""Render the timeline: lossless per-shot intermediates -> one high-quality final encode with captions."""
from __future__ import annotations

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


def final(video: Path, ass: Path | None, voice: Path | None, out: Path, total: float, music: str | None = None,
          voice_is_vo: bool = True) -> Path:
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", str(video)]
    fc = []
    vin = "[0:v]"
    if ass:
        fc.append(f"{vin}subtitles=filename='{ass.as_posix()}':fontsdir='{FONTS_DIR.as_posix()}'[v]")
        vin = "[v]"
    amap = None
    if voice:
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
