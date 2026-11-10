# m5e (montage)

Drop a folder of clips and a voiceover in, get a finished vertical reel out. m5e cuts the way the
@kriosfounders reels are cut, measured from the account's own reels, and then tightens it. It uses
London-style captions and renders at the highest quality Instagram will take.

**It's free.** Everything runs on your laptop: the focus checks, speech-to-text, a local vision model that
understands the shots, the editor and the render. No account, no API key, nothing billed. If you have Claude Code
logged in with your Claude Pro/Max plan, m5e also asks Claude for help, on your plan's included usage only. It
stops by itself when you hit the plan's limit (see [Claude and your plan](#claude-and-your-plan)).

## What it does, in order

1. **Checks every frame like an assistant editor.** It finds focus (including focus hunting and motion blur),
   shake, whip pans, under-exposure, faces and duplicate re-takes. Anything soft, shaky, murky or repeated is set
   aside, and the report says why.
2. **Understands the footage.** A free vision model (CLIP, running on your laptop) looks at every usable shot.
   It works out the shot type (wide, transport, food/detail, screen, group, walking-away filler) and the
   setting, and which shots show what the voiceover is saying ("we landed in Lisbon" pulls the plane-window
   shot). With Claude on, Claude also logs each shot: who's in it, what's happening, the energy, whether it
   would hook, and whether the camera focused on the person (it gets a full-resolution face crop for that).
3. **Works out the story.**
   - The voiceover is split into **beats** (hook, transition, action, list, payoff).
   - The footage is grouped into **scenes** by when and where it was filmed.
   - Each beat is matched to the right part of the day. The day's order is the backbone, but it's flexible:
     the hook can be a cold open from later, and a beat that names a thing pulls footage of that thing.
4. **Cuts like an editor.**
   - **Rhythm:** follows your editing profile (opens fast with a ~0.7s first shot, settles to ~1.6-1.9s,
     holds the ending), or a reference reel's rhythm if you add one.
   - **Timing:** cuts land on new thoughts and content words, with the picture 2 frames ahead of the word. With
     music, cuts and bursts also sit on the beat.
   - **Bursts:** 3-4 different shots, ~0.3s each, when the story arrives somewhere new. Used sparingly.
   - **Variety:** shot size and subject change at every cut, and never two near-identical framings back to back.
   - **Ending:** the closing face/payoff is chosen first and saved, so it's there at the end.
5. **Sound design, subtle and purposeful.** Every sound measures 6-12 dB under the voice. Hard cuts only, no
   flashy transitions.
   - **click/pop** on burst cuts
   - **whoosh** (peaking on the cut) on real location changes, max 2
   - **riser** into a genuine reveal, ending on the reveal frame, then a soft **hit**, max 1
   - **shutter** on photo moments
   - **ambience**: the clips' own sound, tucked under the voice so it breathes in the pauses
   - **music**, ducked under the voice
6. **Watches its own cut and fixes it** *(with Claude)*. The reviewer looks at the render plus objective checks
   (rhythm vs. your profile, cuts on words and on the beat, day order, opening and ending, filler, repeats) and
   sends fixes. m5e re-cuts, up to 2 passes.
7. **Renders at maximum clarity.**
   - Lossless per-shot intermediates, then one near-transparent H.264 encode.
   - High-quality 3K → 1080×1920 downscale, with a light sharpen only when downscaling.
   - HDR/HLG tone-mapped, log footage via your LUT.
   - Audio mix at -14 LUFS / -1 dBTP.
8. **DaVinci Resolve timeline** (`.fcpxml`) linked to your camera originals, plus `captions.srt`.

Without Claude, the free director makes the same kinds of decisions (story, rhythm, bursts, sound). It works from
the measurements and what the local vision model sees, and it checks every cut against the same quality checks.
The only thing it skips is step 6, the watch-and-fix passes.

## Get it on your computer

m5e runs **on your laptop**, not on a server. A day of Pocket 4P 3K footage is several GB, so uploading it would
take longer than the edit, and decoding 3K HEVC, speech-to-text and rendering need a real CPU. Your laptop already
has the footage and DaVinci.

1. Download the code: on GitHub, open the repo, switch to the branch, press **Code -> Download ZIP**, and unzip
   it. Or with git:

```bash
git clone -b claude/funny-davinci-fwx5ce https://github.com/ahroonsanthosh/coolshi.git
```

2. Open the `m5e` folder inside it.

## Install (once)

- **Mac:** double-click **`install.command`**. The first time, right-click -> **Open** so macOS lets it run.
  It needs [Homebrew](https://brew.sh) and tells you if it's missing.
- **Windows:** double-click **`install.bat`**. If it installs ffmpeg or Python, it asks you to run it once more.

The installer sets up m5e's own Python environment (`.venv`), installs ffmpeg if needed, and downloads the
speech-to-text and vision models (~1 GB, one time, free).

Then it offers Claude (optional):
- it installs Claude Code if you want it;
- it asks you to log in with the Claude account that has your Max plan (a browser window opens).

Say no and m5e stays fully free and local. Run the installer again any time to add Claude.

## Use

1. Make a folder for the reel and copy in the day's clips (straight off the Pocket 4P), the voiceover from the
   DJI Mic as `vo.m4a`, and optionally `music.mp3`:

```
lisbon-day1/
  DJI_0001.MP4 ... DJI_0142.MP4    all the footage, any order (m5e sorts by recording time)
  vo.m4a                            the DJI Mic voiceover (vo*/voiceover*, or any audio file)
  music.mp3                         optional: one track under the voice; cuts sit on its beat
  reference.mp4                     optional: a reel whose rhythm/style to copy
  sfx/                              optional: your own click*/pop*/whoosh*/riser*/hit*/shutter*.wav
  m5e.json                          optional settings
```

2. Double-click **`m5e.command`** (Mac) or **`m5e.bat`** (Windows) and choose that folder.
3. Your browser opens the review page and m5e gets to work. The first run of a folder takes a few minutes,
   depending on how much footage there is. When it's done you'll see:
   - the reel
   - every shot, and why it was or wasn't used
   - the story and sound notes, and the quality checks

   Ban shots, force shots, write a brief, and press **Re-cut**. Leave the black window open while you work;
   close it to stop.
4. The finished reel is in `lisbon-day1/m5e_out/`. AirDrop it to your phone and post it.

`m5e_out/` also has the DaVinci timeline (`.fcpxml`), `captions.srt` (fix a word there and re-cut; your text is
used) and `report.html`.

No voiceover? m5e makes a **natural-sound** edit from the lines people say in the clips, with clean moments
between them. A line said over soft footage plays over clean footage instead (an L-cut).

### From the terminal (optional)

```bash
.venv/bin/python -m m5e make ~/Desktop/lisbon-day1
```

That renders straight to `m5e_out/` without the review page.

```bash
.venv/bin/python -m m5e ui ~/Desktop/lisbon-day1
```

That opens the review page. On Windows, use `.venv\Scripts\python` instead of `.venv/bin/python`.

## Osmo Pocket 4P

- **Shoot vertical 3K (1728×3072)**. It's native on the Pocket 4P, so nothing is cropped, and m5e downsamples it to
  1080×1920 with a little sharpening. 4K landscape works too; the vertical crop follows faces.
- **D-Log 2** looks grey until it's converted. Download DJI's D-Log 2 → Rec.709 `.cube` LUT and set `"lut"` in
  `m5e.json`. m5e warns you if footage looks like log and no LUT is set. HLG/HDR is tone-mapped automatically.
- 60fps is fine (output is 30fps, like the account's reels). Use the tele lens for detail cutaways; the director
  uses them for "show what's said" moments.

## Edit like you (editing profile)

The shipped profile, `m5e/profiles/krios.json`, was measured from 11 @kriosfounders voiceover reels, weighted by
likes:

- median shot 1.15s
- first shot ~0.77s
- shot length by tenth of the reel: 0.7 → 1.2 → 1.6 → ~1.7 … → 2.7s held ending
- about one burst every other reel
- music ~6.5 dB under the voice

As you post more, re-learn it from your exports:

```bash
python -m m5e learn ~/Desktop/my-best-reels --name mine
```

Then set `"profile": "mine"` in `m5e.json`. It works on any creator's reels whose editing you want to match.

## Settings (`m5e.json`)

`python -m m5e init <folder>` writes a template. Everything is optional.

| Key | Default | |
|---|---|---|
| `name` | folder name | output file name |
| `brief` | `""` | instructions for Claude as director, e.g. "open on the pitch result, end on the group photo" |
| `context` | Krios founders | who's in the footage, so Claude can name people and places |
| `claude` | `true` | `false` keeps this folder fully local (never asks Claude) |
| `profile` | `krios` | editing profile (rhythm, opening, ending, bursts) |
| `pace` | profile | force a flat average shot length instead of the profile's rhythm |
| `lut` | none | path to a `.cube` LUT (DJI D-Log 2 / D-Log M) |
| `sfx` | `true` | sound effects on/off |
| `ambience` | `true` | the clips' own sound under the voiceover |
| `reference` | a file named `ref*` | reel to copy the rhythm/style from |
| `review_passes` | `2` | how many times Claude's review may send the cut back |
| `tighten_vo` | `true` | shorten long pauses in the voiceover |
| `whisper` | `small` | speech-to-text model (`medium` is more accurate, slower) |
| `fixes` | `{}` | caption spelling fixes, e.g. `{"\\bCreos\\b": "Krios"}` |
| `max_len` | `60` | longest reel in natural-sound mode, seconds |

## For the sharpest result on Instagram

- In Instagram, turn on **Settings → Data usage and media quality → Upload at highest quality**.
- Upload over Wi-Fi.
- Don't add text, stickers or filters in Instagram's editor; that triggers another re-encode.

## The caption style

Measured from the London reels:

- Poppins Bold, white
- size 138 at 1080×1920, tracking -3.5
- first line starts 1475px down, 98px between lines, wraps at 800px, at most 3 lines
- soft shadow
- words appear as they're spoken; a block ends at each sentence or clause

All of it lives in `m5e/style.py`.

## Claude and your plan

m5e never uses pay-per-use billing. It reaches Claude only through **Claude Code logged in with your Claude
subscription**, so the AI steps come out of your plan's included usage:

- **Your login only.** API keys, auth tokens, custom endpoints and cloud providers are removed from Claude Code's
  environment, and its settings files are ignored. Before the first request, m5e checks that Claude Code is
  logged in with a Claude subscription. If Claude Code ever starts with an API key anyway, m5e stops it at
  start-up.
- **It stops at your limit.** When Claude Code reports that you've hit a limit (5-hour, weekly, or a model's
  own), m5e stops using Claude and finishes the edit with the free editor. It doesn't call Claude again until
  the limit resets; the reset time is kept in `~/.m5e/claude_limit.json`. If only the Opus limit is reached, it
  uses Sonnet instead, which is still your plan.
- **Never extra usage.** If Claude Code says it would start drawing on usage credits (extra usage), m5e stops at
  once. Claude Code only reports that after a request has run. So if your account has extra usage switched on,
  m5e stops earlier, at Claude Code's near-limit warning, so nothing gets billed. Keep **extra usage switched off**
  at <https://claude.ai/settings/usage> and the question never comes up.
- **What it uses.** Sonnet logs the shots (many images, lighter on the plan). Opus directs the cut and reviews
  the render. Shot notes are saved, so a re-cut only uses the director and review requests. As a rough estimate,
  not a measurement, a 40s reel from about 60 shots is 100-150k tokens, about one longer Claude Code session.
- **Turning it off.** Set `"claude": false` in `m5e.json`, run with `--no-claude`, or set `M5E_CLAUDE=off`.
  `M5E_MODEL` / `M5E_LOG_MODEL` pick other Claude Code model aliases.

## Tests

```bash
python -m unittest discover -s tests
```

## Credits

- Poppins: SIL Open Font License (`m5e/fonts/OFL.txt`).
- YuNet face detector: OpenCV Zoo, MIT License (`m5e/models/`).
- Speech-to-text: faster-whisper (local; audio never leaves your machine).
- Vision: OpenAI CLIP ViT-B/32 (MIT License), ONNX build by Qdrant, run with fastembed (Apache 2.0), all local.
- All sound effects are synthesised by m5e itself (no sample packs).
