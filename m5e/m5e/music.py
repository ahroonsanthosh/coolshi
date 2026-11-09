"""Beat tracking for a music bed (numpy only): onset envelope -> tempo -> beat times (Ellis-style DP).
Used to land cuts and burst clicks on the beat when a music track is in the folder."""
from __future__ import annotations

import numpy as np

from . import media

SR = 22050
N, HOP = 1024, 256


def onset_envelope(x: np.ndarray) -> np.ndarray:
    frames = 1 + (len(x) - N) // HOP
    if frames < 8:
        return np.zeros(0)
    win = np.hanning(N)
    idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * win, axis=1))
    logspec = np.log1p(100 * spec)
    # flux per log-spaced band, each band normalised: a kick's low thump votes as much as a snare's noise
    freqs = np.fft.rfftfreq(N, 1 / SR)
    edges = np.geomspace(30, SR / 2, 13)
    flux = np.zeros(frames)
    for lo, hi in zip(edges[:-1], edges[1:]):
        band = (freqs >= lo) & (freqs < hi)
        if not band.any():
            continue
        f = np.maximum(0, np.diff(logspec[:, band].mean(1)))
        flux[1:] += f / (f.std() + 1e-9)
    # remove slow trend, normalise
    k = 16
    trend = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0, flux - trend)
    return env / (env.std() + 1e-9)


def tempo(env: np.ndarray, lo_bpm=70, hi_bpm=180) -> float:
    fps = SR / HOP
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    best, best_v = 120.0, -1e9
    for bpm in np.arange(lo_bpm, hi_bpm + 0.1, 0.5):
        lag = fps * 60 / bpm
        i = int(round(lag))
        if i >= len(ac) - 1:
            continue
        v = ac[i] + 0.5 * ac[min(2 * i, len(ac) - 1)]
        v *= np.exp(-0.5 * (np.log2(bpm / 120) / 1.0) ** 2)   # mild preference for ~120 BPM
        if v > best_v:
            best, best_v = bpm, v
    return float(best)


LATENCY = 0.029   # measured: the flux frame lags the true onset by ~29 ms (verified on drum tracks)


def _double_time(env: np.ndarray, bpm: float, fps: float) -> bool:
    """Octave check: if the half-beats are nearly as strong as the beats, the real tempo is double."""
    if bpm * 2 > 180:
        return False
    period = fps * 60 / bpm
    best = None
    for phase in np.arange(0, period, 1):
        on = env[np.round(np.arange(phase, len(env), period)).astype(int).clip(0, len(env) - 1)].mean()
        off = env[np.round(np.arange(phase + period / 2, len(env), period)).astype(int).clip(0, len(env) - 1)].mean()
        if best is None or on > best[0]:
            best = (on, off)
    return best is not None and best[1] >= 0.6 * best[0]


def track(path: str, max_seconds: float | None = None) -> dict:
    x = media.read_audio(path, SR)
    if max_seconds:
        x = x[:int(max_seconds * SR)]
    env = onset_envelope(x)
    if len(env) < 32:
        return {"bpm": None, "beats": []}
    fps = SR / HOP
    bpm = tempo(env)
    if _double_time(env, bpm, fps):
        bpm *= 2
    period = fps * 60 / bpm
    alpha = 100.0
    score = env.copy()
    back = -np.ones(len(env), int)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    for t in range(hi, len(env)):
        prev = np.arange(t - hi, t - lo + 1)
        pen = -alpha * np.log((t - prev) / period) ** 2
        cand = score[prev] + pen
        j = int(np.argmax(cand))
        score[t] = env[t] + cand[j]
        back[t] = prev[j]
    t = int(np.argmax(score[-int(period * 2):])) + len(env) - int(period * 2)
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    beats = np.array(sorted(beats)) * HOP / SR + LATENCY
    return {"bpm": round(bpm, 1), "beats": [round(float(b), 3) for b in beats if b + LATENCY >= 0]}
