"""Local review page: python -m m5e ui <folder>  ->  http://localhost:8765

See the cut, every candidate shot (with why it was or wasn't used), ban shots, force shots, edit the
brief, and re-cut. Runs only on your machine; nothing is uploaded except what the AI editor sends to
the Anthropic API when a key is set.
"""
from __future__ import annotations

import json
import mimetypes
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .project import OUT, WORK, Project

HTML = (Path(__file__).parent / "ui.html").read_text(encoding="utf-8")


class Session:
    def __init__(self, folder: str):
        self.folder = Path(folder).expanduser().resolve()
        self.logs: list[str] = []
        self.busy = False
        self.lock = threading.Lock()
        self.project: Project | None = None
        self.output: str | None = None

    def log(self, m: str):
        print(m)
        self.logs.append(m)
        self.logs = self.logs[-400:]

    def run(self, what: str):
        def job():
            try:
                p = Project(self.folder, log=self.log)
                p.scan(p.cfg.get("vo"), p.cfg.get("music"), p.cfg.get("reference"))
                p.analyze()
                p.study_reference()
                p.understand()
                p.prepare_voice()
                if what in ("cut", "all"):
                    p.plan()
                    out = p.render()
                    out = p.review_loop(out)
                    p.report()
                    self.output = str(out)
                self.project = p
                self.log("Ready.")
            except SystemExit as e:
                self.log(f"Stopped: {e}")
            except Exception as e:  # keep the server alive and show what went wrong
                self.log(f"Error: {e}")
                self.log(traceback.format_exc(limit=3))
            finally:
                self.busy = False

        with self.lock:
            if self.busy:
                return False
            self.busy = True
        threading.Thread(target=job, daemon=True).start()
        return True

    def state(self) -> dict:
        p = self.project
        st = json.loads((self.folder / WORK / "project.json").read_text()) if (self.folder / WORK / "project.json").exists() else {}
        out_dir = self.folder / OUT
        videos = sorted(out_dir.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True) if out_dir.exists() else []
        cands = []
        if p is not None:
            used = {s.get("shot") for s in st.get("timeline", [])} | {s.get("v_clip") for s in st.get("timeline", [])}
            for c in p.cands:
                n = st.get("notes", {}).get(c["id"], {})
                cands.append({**{k: c[k] for k in ("id", "clip", "start", "end", "dur", "score", "flags", "focus", "face")},
                              "file": Path(p.clips[c["clip"]]["path"]).name, "note": n.get("what", ""),
                              "type": n.get("shot_type", ""), "focus_ok": n.get("focus_ok", True),
                              "filler": n.get("filler", False), "used": c["id"] in used})
        rejected = []
        if p is not None:
            for cid, info in p.clips.items():
                d = json.loads((self.folder / WORK / "clips" / f"{cid}.json").read_text())
                rejected.append({"clip": cid, "file": Path(info["path"]).name, "dur": round(info["duration"], 1),
                                 "dropped": {k: round(v / 6, 1) for k, v in d.get("rejected_frames", {}).items()},
                                 "shots": len(d.get("candidates", []))})
        cap = st.get("captions_mtime")
        words = st.get("cap_words", [])
        timeline = []
        for i, s in enumerate(st.get("timeline", [])):
            t0, t1 = s.get("f0", 0) / 30, (s.get("f0", 0) + s.get("frames", 0)) / 30
            said = " ".join(w["w"] for w in words if t0 - 0.05 <= w["s"] < t1 - 0.05)
            n = st.get("notes", {}).get(s.get("shot") or "", {})
            timeline.append({"i": i, "t0": round(t0, 2), "t1": round(t1, 2), "shot": s.get("shot"), "clip": s["clip"],
                             "why": s.get("why", ""), "said": said, "note": n.get("what", "")})
        cfg = p.cfg if p is not None else {}
        return {"folder": str(self.folder), "busy": self.busy, "logs": self.logs[-60:], "ban": st.get("ban", []),
                "must": st.get("must", []), "candidates": cands, "clips": rejected, "timeline": timeline,
                "video": f"/files/{OUT}/{videos[0].name}?v={int(videos[0].stat().st_mtime)}" if videos else None,
                "warnings": st.get("warnings", []), "reviews": st.get("reviews", []), "ai": st.get("ai_notes", {}),
                "quality": st.get("quality"), "sfx": st.get("sfx", []),
                "brief": cfg.get("brief", ""), "pace": p._user_cfg.get("pace") if p is not None else None,
                "mode": getattr(p, "mode", None),
                "captions_mtime": cap}

    def update(self, data: dict):
        sp = self.folder / WORK / "project.json"
        st = json.loads(sp.read_text()) if sp.exists() else {}
        for k in ("ban", "must"):
            if k in data:
                st[k] = sorted(set(data[k]))
        sp.write_text(json.dumps(st, indent=1))
        cfgp = self.folder / "m5e.json"
        cfg = json.loads(cfgp.read_text()) if cfgp.exists() else {}
        changed = False
        for k in ("brief", "pace"):
            if k in data:
                if data[k] in (None, ""):
                    if k == "pace" and "pace" in cfg:   # cleared: back to the profile's rhythm
                        del cfg["pace"]
                        changed = True
                    continue
                cfg[k] = float(data[k]) if k == "pace" else data[k]
                changed = True
        if changed:
            cfgp.write_text(json.dumps(cfg, indent=2))


def make_handler(sess: Session):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body: bytes, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                return self._send(200, HTML.encode(), "text/html; charset=utf-8")
            if u.path == "/api/state":
                return self._send(200, json.dumps(sess.state()).encode())
            if u.path.startswith("/files/"):
                rel = unquote(u.path[len("/files/"):])
                f = (sess.folder / rel).resolve()
                allowed = (sess.folder / WORK).resolve(), (sess.folder / OUT).resolve()
                if not any(str(f).startswith(str(a)) for a in allowed) or not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                return self._file(f)
            self._send(404, b"not found", "text/plain")

        def _file(self, f: Path):
            size = f.stat().st_size
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):  # video seeking
                a, _, b = rng[6:].partition("-")
                a = int(a or 0)
                b = int(b) if b else size - 1
                b = min(b, size - 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
                self.send_header("Content-Length", str(b - a + 1))
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(f, "rb") as fh:
                    fh.seek(a)
                    left = b - a + 1
                    while left > 0:
                        chunk = fh.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            with open(f, "rb") as fh:
                while chunk := fh.read(1 << 20):
                    self.wfile.write(chunk)

        def do_POST(self):
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
            if u.path == "/api/update":
                sess.update(data)
                return self._send(200, b'{"ok":true}')
            if u.path == "/api/recut":
                if data:
                    sess.update(data)
                ok = sess.run("cut")
                return self._send(200 if ok else 409, json.dumps({"ok": ok}).encode())
            self._send(404, b"{}")

    return H


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return   # the browser stopped a video download mid-way: normal, not an error
        super().handle_error(request, client_address)


def serve(folder: str, port: int = 8765, open_browser: bool = True):
    sess = Session(folder)
    have_cut = any((sess.folder / OUT).glob("*.mp4")) if (sess.folder / OUT).exists() else False
    sess.run("load" if have_cut else "all")
    srv = _Server(("127.0.0.1", port), make_handler(sess))
    url = f"http://localhost:{port}"
    print(f"m5e review page: {url}  (Ctrl+C to stop)")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
