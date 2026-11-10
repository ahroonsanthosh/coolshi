"""m5e (montage): turns a folder of clips + a voiceover into a finished reel in the @kriosfounders style."""
import os as _os
import shutil as _shutil

__version__ = "0.1.0"

# On a Mac, Homebrew's folder (/opt/homebrew/bin on Apple Silicon) isn't on the PATH of a program started by
# double-clicking, so ffmpeg/ffprobe wouldn't be found: add it when ffmpeg isn't already reachable.
if _shutil.which("ffmpeg") is None:
    for _d in ("/opt/homebrew/bin", "/usr/local/bin"):
        if _os.path.isfile(_os.path.join(_d, "ffmpeg")):
            _os.environ["PATH"] = _d + _os.pathsep + _os.environ.get("PATH", "")
            break
