"""Speech-to-text with word timestamps (faster-whisper, runs locally)."""
from __future__ import annotations

import re

from . import media, style

_model = None
_model_name = None


def _get_model(name: str):
    global _model, _model_name
    if _model is None or _model_name != name:
        from faster_whisper import WhisperModel
        _model = WhisperModel(name, device="auto", compute_type="int8")
        _model_name = name
    return _model


def fix_text(text: str, fixes: dict[str, str]) -> str:
    for pat, rep in fixes.items():
        text = re.sub(pat, rep, text, flags=re.IGNORECASE)
    return text


def transcribe(path: str, model: str = "small", vocab: list[str] | None = None,
               fixes: dict[str, str] | None = None, start: float = 0.0, duration: float | None = None) -> list[dict]:
    """Returns [{w, s, e}] with times in seconds of the source file."""
    audio = media.read_audio(path)
    if start or duration:
        a = int(start * 16000)
        b = int((start + duration) * 16000) if duration else None
        audio = audio[a:b]
    if audio.size < 16000 * 0.3:
        return []
    vocab = vocab or style.VOCAB
    fixes = {**style.FIXES, **(fixes or {})}
    segs, _ = _get_model(model).transcribe(
        audio, language="en", vad_filter=True, word_timestamps=True,
        initial_prompt="Names: " + ", ".join(vocab) + ".",
        condition_on_previous_text=False,
    )
    words = []
    for seg in segs:
        for w in seg.words or []:
            t = w.word.strip()
            if not t:
                continue
            words.append({"w": t, "s": round(w.start + start, 3), "e": round(w.end + start, 3),
                          "p": round(float(w.probability), 3)})
    # apply spelling fixes across the joined text, then re-split onto the same timings
    if words:
        joined = fix_text(" ".join(w["w"] for w in words), fixes).split(" ")
        if len(joined) == len(words):
            for w, t in zip(words, joined):
                w["w"] = t
        else:
            for w in words:
                w["w"] = fix_text(w["w"], fixes)
    return words
