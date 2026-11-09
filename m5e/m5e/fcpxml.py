"""Export the cut as an FCPXML 1.9 timeline that DaVinci Resolve (free) can import:
File > Import > Timeline > select the .fcpxml. Clips are linked to the original camera files,
so nothing is re-encoded and you can tweak every cut, crop and the voiceover in Resolve.
Captions come as a separate .srt (File > Import > Subtitle)."""
from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import quoteattr

from .style import FPS, HEIGHT, WIDTH


def _t(frames: int) -> str:
    return f"{frames}/{FPS}s" if frames else "0s"


def _src_t(sec: float, info: dict) -> str:
    num, den = info.get("fps_num", FPS), info.get("fps_den", 1)
    n = round(sec * num / den)
    return f"{n * den}/{num}s" if n else "0s"


def export(timeline: list[dict], clips: dict[str, dict], out: Path, name: str,
           vo: tuple[Path, float] | None = None) -> Path:
    fmts, assets = [], []
    fmts.append(f'<format id="r0" name="FFVideoFormat{WIDTH}x{HEIGHT}p{FPS}" frameDuration="1/{FPS}s" '
                f'width="{WIDTH}" height="{HEIGHT}" colorSpace="1-1-1 (Rec. 709)"/>')
    ids = {}
    for k, (cid, info) in enumerate(sorted(clips.items())):
        if not any(cid in (s["clip"], s.get("v_clip")) for s in timeline):
            continue
        fid, aid = f"f{k + 1}", f"a{k + 1}"
        ids[cid] = (aid, fid)
        num, den = info.get("fps_num", FPS), info.get("fps_den", 1)
        fmts.append(f'<format id="{fid}" frameDuration="{den}/{num}s" width="{info["w"]}" height="{info["h"]}"/>')
        dur_frames = int(info["duration"] * num / den)
        assets.append(
            f'<asset id="{aid}" name={quoteattr(Path(info["path"]).name)} start="0s" '
            f'duration="{dur_frames * den}/{num}s" hasVideo="1" hasAudio="{1 if info.get("has_audio") else 0}" '
            f'format="{fid}" audioSources="1" audioChannels="2" audioRate="48000">'
            f'<media-rep kind="original-media" src={quoteattr(Path(info["path"]).resolve().as_uri())}/></asset>')
    if vo:
        assets.append(f'<asset id="avo" name={quoteattr(vo[0].name)} start="0s" duration="{round(vo[1] * 48000)}/48000s" '
                      f'hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000">'
                      f'<media-rep kind="original-media" src={quoteattr(vo[0].resolve().as_uri())}/></asset>')
    total = max((s["f0"] + s["frames"]) for s in timeline)
    spine = []
    for i, s in enumerate(timeline):
        vclip = s.get("v_clip", s["clip"])
        aid, fid = ids[vclip]
        info = clips[vclip]
        inner = '<adjust-conform type="fill"/>'
        lcut = vclip != s["clip"] or abs(s.get("v_src_in", s["src_in"]) - s["src_in"]) > 1e-3
        if s.get("audio") != "clip" or lcut:
            inner += '<adjust-volume amount="-96dB"/>'
        v_in = s.get("v_src_in", s["src_in"])
        # a connected clip's offset is measured in its parent's source time: align it with the parent's in-point
        anchor = _src_t(v_in, info)
        if lcut and s.get("audio") == "clip":
            a_aid, _ = ids[s["clip"]]
            inner += (f'<asset-clip ref="{a_aid}" lane="-1" offset="{anchor}" '
                      f'start="{_src_t(s["src_in"], clips[s["clip"]])}" duration="{_t(s["frames"])}" '
                      f'name="sound" audioRole="dialogue"/>')
        if i == 0 and vo:
            inner += (f'<asset-clip ref="avo" lane="-1" offset="{anchor}" start="0s" duration="{_t(total)}" '
                      f'name="voiceover" audioRole="dialogue"/>')
        spine.append(f'<asset-clip ref="{aid}" offset="{_t(s["f0"])}" start="{_src_t(v_in, info)}" '
                     f'duration="{_t(s["frames"])}" name={quoteattr(s.get("shot") or s["clip"])} format="{fid}" '
                     f'tcFormat="NDF">{inner}</asset-clip>')
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    {chr(10).join('    ' + f for f in fmts).strip()}
    {chr(10).join('    ' + a for a in assets).strip()}
  </resources>
  <library>
    <event name="m5e">
      <project name={quoteattr(name)}>
        <sequence format="r0" duration="{_t(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            {chr(10).join('            ' + x for x in spine).strip()}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""
    out.write_text(xml, encoding="utf-8")
    return out
