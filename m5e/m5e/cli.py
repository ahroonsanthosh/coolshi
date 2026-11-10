"""Command line: python -m m5e make <folder>"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TEMPLATE = {
    "name": "my-reel",
    "brief": "",
    "context": "Footage for @kriosfounders: the three teenage founders of Krios (AI sales training, Cork) - Ahroon, "
               "Michael and Abraham.",
    "profile": "krios",
    "claude": True,
    "lut": None,
    "sfx": True,
    "ambience": True,
    "review_passes": 2,
    "tighten_vo": True,
    "stabilize": False,
    "whisper": "small",
    "fixes": {"\\bCreos\\b": "Krios"},
}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="m5e", description="m5e (montage): clips + voiceover -> finished reel")
    sub = ap.add_subparsers(dest="cmd", required=True)

    mk = sub.add_parser("make", help="analyse the clips, cut, render, review")
    mk.add_argument("folder")
    mk.add_argument("--vo", help="voiceover file (default: a file named vo*/voiceover* or any audio file in the folder)")
    mk.add_argument("--music", help="music bed, ducked under the voice (default: a file named music*)")
    mk.add_argument("--ref", help="reference reel to copy the editing style from (default: a file named ref*)")
    mk.add_argument("--pace", type=float, help="force an average shot length in seconds (overrides the profile)")
    mk.add_argument("--name", help="output file name")
    mk.add_argument("--no-sfx", action="store_true", help="no sound effects")
    mk.add_argument("--no-review", action="store_true", help="skip Claude's review/fix passes")
    mk.add_argument("--no-claude", "--no-ai", dest="no_claude", action="store_true",
                    help="don't use Claude: the free local editor makes every decision")

    ui = sub.add_parser("ui", help="open the review page: see every shot, ban/force shots, re-cut, render")
    ui.add_argument("folder")
    ui.add_argument("--port", type=int, default=8765)

    ini = sub.add_parser("init", help="write a settings file (m5e.json) into the folder")
    ini.add_argument("folder")

    ln = sub.add_parser("learn", help="learn an editing profile from a folder of finished reels (yours, or a "
                                      "creator whose editing you want to match)")
    ln.add_argument("folder")
    ln.add_argument("--name", default="mine", help="profile name (use it with \"profile\": \"<name>\" in m5e.json)")

    a = ap.parse_args(argv)
    if a.cmd == "init":
        p = Path(a.folder) / "m5e.json"
        if p.exists():
            sys.exit(f"{p} already exists")
        p.write_text(json.dumps(TEMPLATE, indent=2))
        print(f"wrote {p}")
        return
    if a.cmd == "learn":
        from . import media, profile, transcribe
        files = sorted(f for f in Path(a.folder).expanduser().iterdir() if f.suffix.lower() in media.VIDEO_EXT)
        if not files:
            sys.exit("No videos in that folder.")
        recs = []
        for f in files:
            print(f"measuring {f.name}...")
            r = profile.measure_reel(str(f), transcribe.transcribe)
            if r:
                r["path"] = f.name
                recs.append(r)
        prof = profile.build(recs, None, a.name)
        out = profile.PROFILES / f"{a.name}.json"
        out.write_text(json.dumps(prof, indent=1))
        print(profile.describe(prof))
        print(f"saved {out}")
        return
    if getattr(a, "no_claude", False):
        import os
        os.environ["M5E_CLAUDE"] = "off"
    from .project import Project
    if a.cmd == "make":
        pr = Project(a.folder)
        if a.pace:
            pr.cfg["pace"] = a.pace
            pr._user_cfg["pace"] = a.pace
        if a.name:
            pr.cfg["name"] = a.name
        if a.no_sfx:
            pr.cfg["sfx"] = False
        pr.make(a.vo, a.music, a.ref, review=not a.no_review)
    elif a.cmd == "ui":
        from .server import serve
        serve(a.folder, a.port)


if __name__ == "__main__":
    main()
