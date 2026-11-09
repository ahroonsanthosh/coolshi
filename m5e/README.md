# m5e (montage)

Drop a folder of clips and a voiceover in, get a finished vertical reel out, cut in the
@kriosfounders style with London-style captions, at the highest quality Instagram will take.

m5e:

1. **Checks every clip like an assistant editor.** It measures focus (including focus hunting and
   motion blur), shake, whip pans, exposure, faces and near-duplicate re-takes, frame by frame.
   Anything soft, shaky, murky or repeated is set aside, and the report says why.
2. **Understands the footage** *(needs an Anthropic API key)*. Claude looks at every usable shot,
   including a full-resolution crop of any face so it can tell whether the camera actually focused
   on the person, and logs who's in it, what's happening, the energy, and whether it would make a good opener.
3. **Cuts it like an editor.** The AI editor matches shots to what the voiceover is saying and opens
   on the strongest image. Cuts land on word onsets and the pace follows the energy of each line. No
   frame is shown twice and no shot runs too long.
4. **Watches its own cut and fixes it.** A reviewer pass scores the render against top-tier reels
   editing (hook, focus, matching, rhythm, filler, ending) and sends back fixes. m5e re-cuts until it
   passes, up to 2 passes by default.
5. **Renders at maximum clarity.** Lossless per-shot intermediates, then one near-transparent H.264
   encode. DJI 3K is downscaled to 1080×1920 with a high-quality scaler, a light sharpen is applied only when
   downscaling, HDR/HLG is tone-mapped properly, loudness is set to -14 LUFS, and captions are burned in.
6. **Gives you a DaVinci Resolve timeline** (`.fcpxml`) linked to your original camera files, plus
   `captions.srt`, so you can fine-tune anything in Resolve.

Without an API key everything still works except step 2 and the reviewer. A rule-based editor
(focus, faces, chronology) does the cut instead, which is good but can't match shots to words.

## Install (once)

1. **Python 3.10+**: <https://www.python.org/downloads/>
2. **ffmpeg**: Mac `brew install ffmpeg`, Windows `winget install Gyan.FFmpeg`.
3. In this folder:

```bash
pip install -r requirements.txt
```

4. **Anthropic API key** (for the AI editor): create one at <https://console.anthropic.com>, then

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

(Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."`)

## Use

Put everything for one reel in a folder:

```
lisbon-day1/
  DJI_0001.MP4 ... DJI_0042.MP4    all the footage, in any order (sorted by recording time)
  vo.m4a                            your DJI Mic voiceover (any file named vo*/voiceover*, or any audio file)
  music.mp3                         optional: music bed, automatically ducked under the voice
  reference.mp4                     optional: a reel to copy the editing rhythm/style from
  m5e.json                          optional settings (see below)
```

Then run this from the `m5e` folder:

```bash
python -m m5e make ~/Desktop/lisbon-day1
```

Or open the review page to see every shot, ban the ones you don't want, force the ones you do,
write a brief, and re-cut:

```bash
python -m m5e ui ~/Desktop/lisbon-day1
```

Results land in `lisbon-day1/m5e_out/`:

| File | What it is |
|---|---|
| `<name>.mp4` | the finished reel, ready to post |
| `<name>.fcpxml` | the same cut as a DaVinci Resolve timeline (File → Import → Timeline) linked to your originals |
| `captions.srt` | captions (Resolve: File → Import → Subtitle). **Edit this file and run `make` again to fix a word**: your text is used |
| `report.html` | every shot in the cut and why, plus every shot that wasn't used and why |

**No voiceover?** If nobody recorded a VO, m5e makes a *natural-sound* edit. It uses the spoken
lines from the clips themselves (jump-cutting the pauses), with clean moments between them that
keep their own sound. If a line was said while the camera was soft or shaky, the sound plays over
clean footage instead (an L-cut).

## Settings (`m5e.json`)

`python -m m5e init <folder>` writes a template. Everything is optional.

| Key | Default | |
|---|---|---|
| `name` | folder name | output file name |
| `brief` | `""` | instructions for the AI editor, e.g. "open on the pitch result, end on the group photo" |
| `context` | Krios founders | who's in the footage, so the AI can name people/places |
| `pace` | `1.4` | average shot length in seconds (London reels: 1.2, NYC: 1.8) |
| `lut` | none | **DJI D-Log M**: path to DJI's free "D-Log M to Rec.709" `.cube` LUT |
| `reference` | a file named `ref*` | reel to copy the rhythm/style from |
| `review_passes` | `2` | how many times the AI reviewer may send the cut back |
| `tighten_vo` | `true` | shorten long pauses in the voiceover |
| `stabilize` | `false` | extra stabilisation pass (not needed for gimbal footage) |
| `whisper` | `small` | speech-to-text model (`medium` is more accurate, slower) |
| `fixes` | `{}` | spelling fixes for captions, e.g. `{"\\bCreos\\b": "Krios"}` |
| `max_len` | `60` | longest reel in natural-sound mode, in seconds |

## For the sharpest result on Instagram

- Shoot DJI at 3K or 4K. m5e downsamples it properly to 1080×1920. Use the D-Log M LUT if you shoot in D-Log M.
- In Instagram: **Settings → Data usage and media quality → Upload at highest quality: ON.**
- Upload over Wi-Fi, and don't add text, stickers or filters in Instagram's editor. That triggers another re-encode.

## The caption style

Measured from the London reels (28 Sep / 2 Oct 2026): Poppins Bold, white, size 138 at
1080×1920, tracking -3.5, top of the first line 1475px down, 98px between lines, wrap at 800px,
at most 3 lines, and a soft shadow. Words appear as they're spoken; a block ends at each sentence or clause.
Everything lives in `m5e/style.py` if you ever want to change it.

## How the AI part works, and what it costs

m5e calls Claude (`claude-opus-5-5` by default; set `M5E_MODEL` to change it) to describe the
shots, plan the cut, and review the render. Server-side refusal fallbacks are switched on, so a
declined request is retried on Anthropic's recommended fallback model instead of failing the edit.
A typical 40s reel from ~60 candidate shots is very roughly 100-150k input tokens across all calls.
That's an estimate, not a measurement, so check your usage in the Anthropic console.

## Tests

```bash
python -m unittest discover -s tests
```

## Credits

- Poppins font: SIL Open Font License (`m5e/fonts/OFL.txt`).
- YuNet face detector: OpenCV Zoo, MIT License (`m5e/models/`).
- Speech-to-text: faster-whisper (runs locally; your audio never leaves your machine).
