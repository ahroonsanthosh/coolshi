"""London-style captions: Poppins Bold, white, soft shadow, words appear as they're spoken.

Layout is done here (not by libass) so lines sit exactly where they do in the published reels:
each chunk is wrapped once, then every reveal step draws the full layout with the words that
haven't been said yet made invisible. That's why a half-revealed line sits left of centre,
exactly like the originals.
"""
from __future__ import annotations

from pathlib import Path

from PIL import ImageFont

from .style import CAPTION, FONTS_DIR, HEIGHT, WIDTH

# PIL em-size that matches libass size 1 for Poppins (measured: libass 137 == PIL 77.0)
_PIL_PER_ASS = 77.0 / 137.0
_font_cache: dict[int, ImageFont.FreeTypeFont] = {}


def _font():
    size = round(CAPTION["size"] * _PIL_PER_ASS)
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(str(FONTS_DIR / "Poppins-Bold.ttf"), size)
    return _font_cache[size]


def text_width(s: str) -> float:
    return _font().getlength(s) + CAPTION["spacing"] * max(len(s) - 1, 0)


def wrap(words: list[str]) -> list[list[int]]:
    """Greedy wrap -> list of lines, each a list of word indices (top line longest, like the originals)."""
    lines, cur = [], []
    for i, w in enumerate(words):
        trial = " ".join([words[j] for j in cur] + [w])
        if cur and text_width(trial) > CAPTION["max_line_px"]:
            lines.append(cur)
            cur = [i]
        else:
            cur.append(i)
    if cur:
        lines.append(cur)
    return lines


def chunk(words: list[dict]) -> list[list[dict]]:
    """Group words into caption blocks: break at sentence ends, at clause commas, on pauses,
    and before a block would need more than max_lines."""
    out, cur = [], []
    for i, w in enumerate(words):
        if cur:
            prev = cur[-1]
            gap = w["s"] - prev["e"]
            chars = len(" ".join(x["w"] for x in cur))
            new = False
            if prev["w"].endswith((".", "?", "!")):
                new = True
            elif prev["w"].endswith((",", ";", ":")) and chars >= 18:
                new = True
            elif gap > CAPTION["pause_break_s"]:
                new = True
            elif len(wrap([x["w"] for x in cur] + [w["w"]])) > CAPTION["max_lines"] or chars + len(w["w"]) + 1 > CAPTION["max_chars"]:
                new = True
            if new:
                out.append(cur)
                cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def _ts(t: float) -> str:
    t = max(t, 0)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def _esc(s: str) -> str:
    return s.replace("\\", "/").replace("{", "(").replace("}", ")")


def build_ass(words: list[dict], out: Path, end_time: float | None = None) -> Path:
    c = CAPTION
    shadow_a = f"{c['shadow_alpha']:02X}"
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{c['font']},{c['size']},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,{-1 if c['bold'] else 0},0,0,0,100,100,{c['spacing']},0,1,0,0,8,0,0,0,1
Style: Shd,{c['font']},{c['size']},&H{shadow_a}000000,&H{shadow_a}000000,&H00000000,&H00000000,{-1 if c['bold'] else 0},0,0,0,100,100,{c['spacing']},0,1,0,0,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    chunks = chunk(words)
    for ci, ch in enumerate(chunks):
        texts = [_esc(w["w"]) for w in ch]
        lines = wrap(texts)
        nxt = chunks[ci + 1][0]["s"] if ci + 1 < len(chunks) else None
        stop = ch[-1]["e"] + c["linger_s"]
        if nxt is not None:
            stop = min(stop, nxt) if nxt - ch[-1]["e"] > c["linger_s"] else nxt
        if end_time is not None:
            stop = min(stop, end_time)
        for k in range(len(ch)):
            t0 = ch[k]["s"]
            t1 = ch[k + 1]["s"] if k + 1 < len(ch) else stop
            if t1 - t0 < 0.02:
                continue
            for li, line in enumerate(lines):
                parts = []
                for j in line:
                    if j <= k:
                        parts.append(texts[j])
                    else:
                        parts.append("{\\alpha&HFF&}" + texts[j] + "{\\alpha&H00&}")
                body = " ".join(parts)
                if all(j > k for j in line):
                    continue
                y = c["top_y"] + li * c["line_pitch"]
                dx, dy = c["shadow_offset"]
                ev.append(f"Dialogue: 0,{_ts(t0)},{_ts(t1)},Shd,,0,0,0,,"
                          f"{{\\pos({WIDTH // 2 + dx},{y + dy})\\blur{c['shadow_blur']}\\1a&H{shadow_a}&}}"
                          + body.replace("{\\alpha&H00&}", f"{{\\alpha&H{shadow_a}&}}"))
                ev.append(f"Dialogue: 1,{_ts(t0)},{_ts(t1)},Cap,,0,0,0,,{{\\pos({WIDTH // 2},{y})}}" + body)
    out.write_text(head + "\n".join(ev) + "\n", encoding="utf-8")
    return out


def build_srt(words: list[dict], out: Path) -> Path:
    def ts(t):
        h, r = divmod(max(t, 0), 3600)
        m, s = divmod(r, 60)
        return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s % 1) * 1000)) % 1000:03d}"
    rows = []
    chunks = chunk(words)
    for i, ch in enumerate(chunks):
        end = ch[-1]["e"] + CAPTION["linger_s"]
        if i + 1 < len(chunks):
            end = min(end, chunks[i + 1][0]["s"])
        rows.append(f"{i + 1}\n{ts(ch[0]['s'])} --> {ts(end)}\n{' '.join(w['w'] for w in ch)}\n")
    out.write_text("\n".join(rows), encoding="utf-8")
    return out


def read_srt_words(path: Path) -> list[dict]:
    """If the user edits captions.srt (fix a word, merge lines), use their text. Word timings inside each
    cue are spread evenly by character count."""
    words = []
    blocks = path.read_text(encoding="utf-8").strip().split("\n\n")
    for b in blocks:
        lines = [x for x in b.strip().splitlines() if x.strip()]
        if len(lines) < 3 or "-->" not in lines[1]:
            continue

        def sec(x):
            h, m, s = x.strip().replace(",", ".").split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
        a, z = (sec(x) for x in lines[1].split("-->"))
        toks = " ".join(lines[2:]).split()
        total = sum(len(t) + 1 for t in toks) or 1
        t = a
        span = max(z - a - 0.15, 0.1)
        for tok in toks:
            d = span * (len(tok) + 1) / total
            words.append({"w": tok, "s": round(t, 3), "e": round(t + d, 3)})
            t += d
    return words
