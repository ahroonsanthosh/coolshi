"""Subtle, clean sound effects, synthesised (no sample packs, no licensing questions), placed with
sample accuracy on the cuts.

  click   - crisp UI tick (burst cuts)
  pop     - soft bubble pop, falling pitch (start of a burst / a "pop-in" moment)
  whoosh  - filtered air sweep that PEAKS ON THE CUT (location change)
  riser   - noise + tone rising together, ENDING ON THE REVEAL frame (build into a payoff)
  hit     - soft sub thump when the reveal lands
  shutter - camera click (photo moments)

Your own sounds win: put files named click*.wav, pop*.wav, whoosh*.wav, riser*.wav, hit*.wav,
shutter*.wav (wav/mp3/m4a) in a `sfx/` folder next to your clips, or in ~/.m5e/sfx.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

from .style import SFX_LEVELS_DB

SR = 48000
TYPES = ("click", "pop", "whoosh", "riser", "hit", "shutter")


def _rng(seed):
    return np.random.default_rng(seed)


def _stft_filter(x: np.ndarray, gain_fn, n=1024, hop=256) -> np.ndarray:
    """Time-varying filter: gain_fn(t_seconds, freqs) -> gains per bin, applied frame by frame (overlap-add)."""
    win = np.hanning(n).astype(np.float32)
    pad = np.concatenate([np.zeros(n, np.float32), x.astype(np.float32), np.zeros(n, np.float32)])
    out = np.zeros_like(pad)
    norm = np.zeros_like(pad)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    for start in range(0, len(pad) - n, hop):
        seg = pad[start:start + n] * win
        spec = np.fft.rfft(seg)
        t = (start + n / 2 - n) / SR
        spec *= gain_fn(t, freqs)
        out[start:start + n] += np.fft.irfft(spec, n).astype(np.float32) * win
        norm[start:start + n] += win * win
    out = out / np.maximum(norm, 1e-6)
    return out[n:n + len(x)]


def _norm(x: np.ndarray, peak=0.9) -> np.ndarray:
    m = float(np.max(np.abs(x))) or 1.0
    return (x / m * peak).astype(np.float32)


def _fade(x: np.ndarray, a_ms=1.0, r_ms=8.0) -> np.ndarray:
    a, r = int(SR * a_ms / 1000), int(SR * r_ms / 1000)
    y = x.copy()
    if a > 0:
        y[:a] *= np.linspace(0, 1, a, dtype=np.float32)
    if r > 0:
        y[-r:] *= np.linspace(1, 0, r, dtype=np.float32)
    return y


def click(var: int = 0) -> np.ndarray:
    n = int(SR * 0.04)
    t = np.arange(n) / SR
    rng = _rng(11 + var)
    noise = rng.standard_normal(n).astype(np.float32) * np.exp(-t / 0.0025)
    noise = _stft_filter(noise, lambda _t, f: np.exp(-((np.log(f + 1) - np.log(4500)) ** 2) / 0.35), n=256, hop=64)
    tone = np.sin(2 * np.pi * (2300 + 120 * (var % 3)) * t) * np.exp(-t / 0.0028)
    return _fade(_norm(0.75 * noise / (np.max(np.abs(noise)) + 1e-9) + 0.4 * tone)[:int(SR * 0.025)], 0.3, 4)


def pop(var: int = 0) -> np.ndarray:
    n = int(SR * 0.11)
    t = np.arange(n) / SR
    f0, f1 = 1350 + 60 * (var % 3), 380
    f = f1 + (f0 - f1) * np.exp(-t / 0.011)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * (1 - np.exp(-t / 0.0008)) * np.exp(-t / 0.022)
    rng = _rng(23 + var)
    tick = rng.standard_normal(n) * np.exp(-t / 0.0012) * 0.25
    return _fade(_norm(body + tick), 0.2, 10)


def whoosh(length: float = 0.55, peak_at: float = 0.65, var: int = 0) -> np.ndarray:
    n = int(SR * length)
    rng = _rng(37 + var)
    # pinkish noise
    w = rng.standard_normal(n).astype(np.float32)
    spec = np.fft.rfft(w)
    spec /= np.sqrt(np.maximum(np.fft.rfftfreq(n, 1 / SR), 20.0))
    noise = np.fft.irfft(spec, n).astype(np.float32)
    p = peak_at * length

    def centre(t):  # band sweeps up into the cut, then falls away after it
        if t <= p:
            return 350 * (2600 / 350) ** (max(t, 0) / p)
        return 2600 * (700 / 2600) ** min((t - p) / max(length - p, 1e-3), 1)

    mono = _stft_filter(noise, lambda t, f: np.exp(-((np.log(f + 1) - np.log(centre(t))) ** 2) / 0.5))
    t = np.arange(n) / SR
    env = np.where(t <= p, (t / p) ** 2.2, np.exp(-(t - p) / (0.18 * (length - p) + 1e-3)))
    mono = _norm(mono * env)
    pan = np.clip((t / length) * 0.6 + 0.2, 0, 1)            # drifts slightly left -> right across the cut
    return np.stack([mono * np.sqrt(1 - pan), mono * np.sqrt(pan)], 1).astype(np.float32)


def riser(length: float = 2.0, var: int = 0) -> np.ndarray:
    n = int(SR * length)
    t = np.arange(n) / SR
    x = t / length
    rng = _rng(53 + var)
    noise = rng.standard_normal(n).astype(np.float32)
    noise = _stft_filter(noise, lambda tt, f: 1.0 / (1.0 + (f / (300 * (9000 / 300) ** min(max(tt / length, 0), 1))) ** 4))
    f = 170 * (1150 / 170) ** x * (1 + 0.004 * np.sin(2 * np.pi * 5.5 * t))
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.35 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    env = x ** 2.4
    mix = _norm(0.75 * _norm(noise) + 0.45 * _norm(tone)) * env
    return _fade(_norm(mix), 30, 12)                          # sharp end: the reveal frame is where it stops


def hit(var: int = 0) -> np.ndarray:
    """Soft impact that still reads on a phone speaker (which can't play much below ~150 Hz):
    a sub thump for headphones + a 110-180 Hz body + a short mid 'thud'."""
    n = int(SR * 0.5)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(52 + 40 * np.exp(-t / 0.04)) / SR) * np.exp(-t / 0.12)
    body = np.sin(2 * np.pi * np.cumsum(165 + 95 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.085)
    body += 0.35 * np.sin(2 * np.pi * np.cumsum(2 * (165 + 95 * np.exp(-t / 0.03))) / SR) * np.exp(-t / 0.05)
    rng = _rng(71 + var)
    thud = _stft_filter(rng.standard_normal(n).astype(np.float32) * np.exp(-t / 0.012),
                        lambda _t, fr: np.exp(-((np.log(fr + 1) - np.log(650)) ** 2) / 0.45))
    return _fade(_norm(0.3 * sub + 0.8 * body + 0.5 * _norm(thud)), 0.5, 60)


def shutter(var: int = 0) -> np.ndarray:
    def snap(seed, dur=0.03):
        m = int(SR * dur)
        tt = np.arange(m) / SR
        z = _rng(seed).standard_normal(m).astype(np.float32) * np.exp(-tt / 0.003)
        return _stft_filter(z, lambda _t, f: np.exp(-((np.log(f + 1) - np.log(2800)) ** 2) / 0.6), n=256, hop=64)
    a, b = snap(91 + var), snap(97 + var) * 0.6
    gap = np.zeros(int(SR * 0.07), np.float32)
    return _fade(_norm(np.concatenate([a, gap, b])), 0.2, 4)


SYNTH = {"click": click, "pop": pop, "whoosh": whoosh, "riser": riser, "hit": hit, "shutter": shutter}


def _load(path: Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, np.float32).reshape(-1, 2)


def library(dirs: list[Path]) -> dict[str, list[Path]]:
    lib: dict[str, list[Path]] = {k: [] for k in TYPES}
    for d in dirs:
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in (".wav", ".mp3", ".m4a", ".aif", ".aiff", ".flac"):
                for k in TYPES:
                    if f.stem.lower().startswith(k):
                        lib[k].append(f)
    return lib


def sound(kind: str, var: int, lib: dict[str, list[Path]], length: float | None = None) -> np.ndarray:
    files = lib.get(kind) or []
    if files:
        x = _load(files[var % len(files)])
        if kind == "riser" and length:
            x = x[-int(SR * length):]          # keep the END of a riser: that's what lands on the reveal
        return x
    if kind == "riser":
        y = riser(length or 2.0, var)
    elif kind == "whoosh":
        y = whoosh(length or 0.55, var=var)
    else:
        y = SYNTH[kind](var)
    if y.ndim == 1:
        y = np.stack([y, y], 1)
    return y


def anchor(kind: str, x: np.ndarray) -> int:
    """Sample in the sound that must sit exactly on the event time."""
    if kind == "riser":
        return len(x)                           # its end is the reveal
    if kind == "whoosh":
        return int(np.argmax(np.abs(x).sum(1)))  # its peak is the cut
    mono = np.abs(x).sum(1)
    return int(np.argmax(mono > 0.5 * mono.max()))   # transients: the attack sits on the cut


def build_track(events: list[dict], total: float, ref_peak: float, lib_dirs: list[Path], out: Path) -> Path | None:
    """Render all sound effects into one stereo track, levels relative to the voice's peak level."""
    if not events:
        return None
    lib = library(lib_dirs)
    track = np.zeros((int(SR * total) + SR, 2), np.float32)
    for i, e in enumerate(events):
        x = sound(e["type"], e.get("var", i), lib, e.get("len"))
        x = x / (np.max(np.abs(x)) + 1e-9)
        if e["type"] in ("whoosh", "riser"):   # sustained sounds: set by RMS so they sit under the voice
            rms = float(np.sqrt(np.mean(x[np.abs(x).sum(1) > 0.01] ** 2))) or 1.0
            x = x * (0.25 / rms)
        x = x * ref_peak * 10 ** (SFX_LEVELS_DB.get(e["type"], -14) / 20) * e.get("gain", 1.0)
        start = int(round(e["t"] * SR)) - anchor(e["type"], x)
        if e["type"] == "riser":
            start -= int(SR * 0.08)             # a breath (~2-3 frames) of near-silence right before the reveal
        a = max(start, 0)
        x = x[a - start:]
        b = min(a + len(x), len(track))
        track[a:b] += x[:b - a]
    track = track[:int(SR * total)]
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                          "-c:a", "pcm_s24le", str(out)], stdin=subprocess.PIPE)
    p.communicate(track.astype(np.float32).tobytes())
    return out
