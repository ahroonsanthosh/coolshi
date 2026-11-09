"""House style for @kriosfounders reels.

Every number here was measured from the published London reels (28 Sep / 2 Oct 2026),
which are the caption look we're matching. Change values here, not in the renderer.
"""
from pathlib import Path

FONTS_DIR = Path(__file__).parent / "fonts"

# ---- Output -----------------------------------------------------------------
WIDTH, HEIGHT, FPS = 1080, 1920, 30
# Sharpness: per-shot intermediates are LOSSLESS, so the final encode is the only lossy step.
# Final encode is near-transparent H.264 tuned to keep fine detail, so Instagram's own
# re-encode starts from the cleanest possible source.
SCALE_FLAGS = "lanczos+accurate_rnd+full_chroma_int+full_chroma_inp"
FINAL_X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "15", "-tune", "film",
              "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p",
              "-x264-params", "aq-mode=3:aq-strength=0.9:deblock=-1,-1",
              "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
              "-movflags", "+faststart"]
LOSSLESS_X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p"]
AUDIO_AAC = ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"]
MIN_SOURCE_SCALE = 0.95   # a crop that would need upscaling by more than ~5% is flagged as soft
TARGET_LUFS = -14.0       # what Instagram normalises to; all the published reels sit at -14.1

# ---- Captions (London style) ------------------------------------------------
# Poppins Bold, white, centred, sentence case with punctuation, soft drop shadow.
# Words appear as they are spoken; the block resets at each sentence/clause.
CAPTION = {
    "font": "Poppins",
    "bold": True,
    "size": 138,            # libass size that reproduces the London glyph size at 1080x1920
    "spacing": -3.5,        # tight tracking, as in the originals
    "line_pitch": 98,       # px between line tops
    "top_y": 1475,          # top of the first line (text grows downward)
    "max_line_px": 800,     # wrap width
    "max_lines": 3,
    "max_chars": 52,        # ~3 lines; also break on . , ? ! and pauses
    "pause_break_s": 0.45,
    "shadow_alpha": 0x78,   # 00 = opaque, FF = invisible
    "shadow_blur": 7,
    "shadow_offset": (2, 4),
    "linger_s": 0.35,       # how long the last chunk stays after its last word
}

# ---- Cutting ----------------------------------------------------------------
PACE = 1.4                # target average shot length (s). London reels: 1.2, NYC: 1.8
MIN_SHOT = 0.45
MAX_SHOT = 3.2
CUT_LEAD = 0.04           # cut this much before the word onset, so the picture lands with the word

# ---- Voiceover (DJI Mic Mini) -----------------------------------------------
VO_FILTER = "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2"
VO_MAX_PAUSE = 0.30       # pauses longer than this get shortened to VO_KEEP_PAUSE
VO_KEEP_PAUSE = 0.16
VO_HEAD = 0.05            # silence kept before the first word

# ---- Look -------------------------------------------------------------------
# DJI D-Log M footage needs DJI's official "D-Log M to Rec.709" .cube LUT: set "lut" in m5e.json.
# Natural phone look: a touch of contrast/saturation.
GRADE = "eq=contrast=1.03:saturation=1.06"
# Light luma-only sharpen, applied ONLY when downscaling (e.g. DJI 3K -> 1080) to restore the crispness
# the resize takes away. Never on footage that's already 1080: it would just amplify compression noise,
# which Instagram's encoder then smears.
DOWNSCALE_SHARPEN = "unsharp=5:5:0.25:5:5:0.0"
SHARPEN_MIN_RATIO = 1.3   # source crop at least 1.3x wider than the output

# Words the speech-to-text gets wrong. Extend in m5e.json -> "fixes".
VOCAB = ["Krios", "Abraham", "Michael", "Ahroon", "Evan", "Cork", "Leaving Cert", "Web Summit", "Lisbon"]
FIXES = {
    r"\b(Creos|Krias|Kreos|Krious|Kreos|Kryos|Chris's)\b": "Krios",
    r"\bselling school\b": "still in school",
}

# What we learnt from the account's own numbers; fed to the AI editor as house rules.
HOUSE_RULES = """
House style learnt from the account's published reels (likes in brackets):
- Best performers had stakes or a contrast: "We might be going to NYC" (177), "founders of a 7 figure
  business making dinner" (103), "we pitched to millionaires" (106). Plain day-in-the-life recaps sat at 56-89.
- Open on the strongest, most intriguing image: a face close to the lens, a reaction, something odd.
  Never open on a wide establishing shot or the back of someone's head.
- Shots of people walking away from camera are filler: max ~0.7s each, never two in a row.
- Faces reacting to camera, hands doing something, and product/brand moments (Krios logo, laptop,
  newspaper clipping) hold attention; give them the longer holds.
- Average shot length 1.2-1.8s. Cut on word onsets. Faster cuts on lists/hype lines, hold on reactions
  and payoffs.
- Match what is said: when the voiceover names a place, object, person or action, show it at that moment.
- End on a face or a payoff, not on a corridor, a car seat or a blurry transition.
- No soft-focus, no shaky whip-pans, no near-identical consecutive shots.
""".strip()
