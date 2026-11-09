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
PACE = 1.4                # fallback average shot length (s); normally the editing profile's rhythm curve is used
PROFILE = "krios"         # editing profile measured from the account's reels (profiles/krios.json)
MIN_SHOT = 0.45
MAX_SHOT = 3.2
CUT_LEAD = 0.06           # the picture changes 2 frames before the word starts, so it lands WITH the word
# Quick-cut bursts: 3-4 shots in quick succession where the story arrives somewhere new.
BURST = {"shot": 0.32, "min_shot": 0.22, "max_shot": 0.45}

# ---- Sound design -------------------------------------------------------------
# One sound per purpose, never on every cut. Levels are relative to the voice (research: 6-12 dB under it).
SFX_RULES = {"max_whoosh": 2, "max_riser": 1, "min_gap": 1.5, "riser_max": 2.6}
# Peak levels relative to the voice's peak; calibrated so each effect MEASURES 6-12 dB under the voice over a 50 ms
# window (how the ear judges a short sound). Clicks are 25 ms long, so they need a much higher peak to be heard at all.
SFX_LEVELS_DB = {"click": -2, "pop": -13, "whoosh": -16, "riser": -14, "hit": -13, "shutter": -3}
MUSIC_UNDER_VO_DB = 13.0  # music bed this far under the voice (loudness); with ducking this measures like the
                          # account's own reels (bed ~4-6 dB under speech in the pauses)
AMBIENCE_UNDER_VO_DB = 22.0   # natural sound from the clips, tucked under the voice, rising a little in pauses

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

# How the best short-form / day-in-the-life editors cut (research summary), fed to the AI director and reviewer.
PLAYBOOK = """
Editing playbook (what top short-form / day-in-the-life editors do):
- Hook: the first 1-2 seconds earn the rest. Open on the strongest image (a face close to the lens, a reaction, a
  surprising object) or a cold open borrowed from later in the day; never on an establishing wide or a corridor.
- Give an ordinary day an arc: set-up -> movement -> moments -> payoff. Keep the day's order unless breaking it
  makes a better hook. Contrast busy and quiet moments; faster mid-day, a touch slower at night.
- Show what's said: when the voiceover names a place, thing, person or action, it is on screen as the word lands.
  The picture leads the word by a couple of frames; cut on phrase starts and content words, not mid-word.
- Shot length follows the energy of the line: quick on lists and travel, holds on faces, reactions and payoffs.
  Trim every b-roll shot to its strongest moment. Cut on movement when you can.
- Change something at every cut (shot size, angle, subject). Never two near-identical framings back to back.
- Quick-cut bursts: 3-4 different shots, ~0.25-0.4s each, when the story arrives somewhere new or lists things.
  Sparingly: one or two per reel.
- Sound design is subtle and purposeful - one sound per job, never on every cut:
  click = a quick cut inside a burst; pop = the start of a burst or something popping in; whoosh = a real
  location change (peak on the cut); riser = building into a genuine reveal/payoff, its end exactly on the reveal
  frame, at most one or two per reel; hit = the reveal landing (only after a riser); shutter = a photo moment.
  Effects sit 6-12 dB under the voice. No flashy transitions - hard cuts only.
- Ambience/natural sound under b-roll (silence under cutaways feels wrong), tucked under the voice. Music: one
  track, under the voice; cuts and bursts sit on its beat where the words allow.
- End on a face or the payoff, held long enough to land; never on filler.
""".strip()

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
