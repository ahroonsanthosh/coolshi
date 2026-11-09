"""The AI editor. Claude looks at every candidate shot, plans the cut against the voiceover,
then watches the render and sends back fixes.

Needs an Anthropic API key (ANTHROPIC_API_KEY, or `ant auth login`). Without one, m5e falls
back to the rule-based editor in plan.py.
"""
from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from .style import BURST, HOUSE_RULES, MAX_SHOT, MIN_SHOT, PLAYBOOK, SFX_RULES

MODEL = os.environ.get("M5E_MODEL", "claude-opus-5-5")
BATCH = 15  # candidate strips per "look at these shots" request


class BrainError(RuntimeError):
    pass


KEY_FILE = Path.home() / ".m5e" / "anthropic_key"   # written by install.command / install.bat


def _load_saved_key() -> None:
    """Use the key the installer saved, unless one is already set in the environment."""
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return
    try:
        key = KEY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key


def available() -> bool:
    import importlib.util
    if importlib.util.find_spec("anthropic") is None:
        return False
    _load_saved_key()
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return (Path.home() / ".config" / "anthropic").exists()


_client = None


def _client_():
    global _client
    if _client is None:
        import anthropic
        _load_saved_key()
        _client = anthropic.Anthropic(max_retries=4, timeout=600)
    return _client


def _ask(content: list, schema: type[BaseModel], system: str, effort: str = "high", max_tokens: int = 16000):
    import anthropic
    try:
        resp = _client_().beta.messages.parse(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_format=schema,
            output_config={"effort": effort},
            # if a request is ever declined by a safety classifier, re-run it on Anthropic's
            # recommended fallback model instead of failing the edit
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as e:
        raise BrainError("Anthropic API key missing or invalid (set ANTHROPIC_API_KEY).") from e
    except anthropic.RateLimitError as e:
        raise BrainError("Rate limited by the Anthropic API even after retries; try again in a minute.") from e
    except anthropic.APIStatusError as e:
        raise BrainError(f"Anthropic API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise BrainError("Could not reach the Anthropic API (network).") from e
    if resp.stop_reason == "refusal":
        raise BrainError("The request was declined by the model.")
    if resp.stop_reason == "max_tokens":
        raise BrainError("The model ran out of output space; try fewer clips.")
    if resp.parsed_output is None:
        raise BrainError("The model returned no usable answer.")
    return resp.parsed_output


def _img(path: Path) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(path.read_bytes()).decode()}}


# --------------------------------------------------------------------------------------------
# 1. Understand the footage
# --------------------------------------------------------------------------------------------

class ShotNote(BaseModel):
    id: str
    what: str              # one plain sentence: who is doing what, where
    people: str            # who's visible and how (e.g. "two founders, faces to camera", "none")
    setting: str           # place
    shot_type: Literal["face close-up", "talking to camera", "reaction", "group", "medium", "wide/establishing",
                       "walking away / back of head", "pov / hands", "detail / object", "screen / product",
                       "transport / transition", "other"]
    energy: int            # 1 calm .. 5 hype
    hook: int              # 1..5: would this stop the scroll as the very first shot?
    focus_ok: bool         # subject sharp in all three frames
    framing_ok: bool       # subject well framed for a vertical reel (not cut off, not tilted badly)
    filler: bool           # nothing happening worth showing
    best_part: Literal["start", "middle", "end", "any"]
    action: bool           # something physically happens (a movement worth cutting on)
    photo_moment: bool     # someone takes/poses for a photo (a shutter sound fits)
    tags: list[str]        # nouns/actions someone might say in a voiceover: "plane", "kebab", "laptop", "laughing"


class ShotNotes(BaseModel):
    shots: list[ShotNote]


DESCRIBE_SYSTEM = """You are the assistant editor on a short-form vertical video team (Instagram Reels).
You log footage: for each candidate shot you get three frames (start, middle, end) side by side and, when there
is a face, a fourth square tile showing that face cropped from the full-resolution frame. Use that crop to judge
whether the camera actually focused on the person (eyes, eyelashes, hair edges crisp) or behind them.
Describe what is actually happening, precisely and concretely, so the editor can match shots to a voiceover
without seeing them. Be strict about focus and framing: if a face or the subject is soft in any frame, focus_ok
is false. Mark filler honestly (corridors, floors, car seats, blurry transitions, backs of heads with nothing
happening). Tags should be the words a person would naturally say about this shot."""


def describe(cands: list[dict], strip_dir: Path, clip_order: dict[str, int], context: str = "") -> dict[str, dict]:
    notes: dict[str, dict] = {}
    for i in range(0, len(cands), BATCH):
        batch = cands[i:i + BATCH]
        content: list = []
        if context:
            content.append({"type": "text", "text": f"Context about this shoot: {context}"})
        for c in batch:
            content.append({"type": "text", "text": (
                f"Shot {c['id']} — clip #{clip_order[c['clip']]} in shooting order, {c['dur']:.1f}s usable. "
                f"Measured: focus {c['focus']:.2f}/1, stability {c['stability']:.2f}/1, "
                f"{c.get('faces', 0)} face(s), largest {c['face']:.2f} of frame height{', flags: ' + ', '.join(c['flags']) if c['flags'] else ''}.")})
            content.append(_img(strip_dir / f"{c['id']}.jpg"))
        content.append({"type": "text", "text": f"Log all {len(batch)} shots above, using their ids."})
        out = _ask(content, ShotNotes, DESCRIBE_SYSTEM, effort="medium")
        for n in out.shots:
            notes[n.id] = n.model_dump()
    return notes


# --------------------------------------------------------------------------------------------
# 2. Plan the edit
# --------------------------------------------------------------------------------------------

class VOSeg(BaseModel):
    from_word: int     # index of the voiceover word this shot starts on
    shot: str          # candidate id
    offset: float      # seconds into the candidate where the shot begins
    why: str           # short reason (what in the VO it matches / why it's here)


class VOPlan(BaseModel):
    segments: list[VOSeg]
    hook_note: str      # how the first second grabs attention
    vo_feedback: str    # honest note on the voiceover itself (hook strength, flat ending) — the editor can't fix the script


class DirCut(BaseModel):
    from_word: int     # the voiceover word this shot starts on (the picture lands with it)
    shot: str
    offset: float      # seconds into the shot where it begins (pick its strongest moment)
    why: str


class DirBurst(BaseModel):
    from_word: int     # where the burst starts
    shots: list[str]   # 3-4 DIFFERENT shots, ~0.3s each
    why: str


class DirSfx(BaseModel):
    at_word: int       # the cut on this word (riser: the reveal word it builds into)
    type: Literal["click", "pop", "whoosh", "riser", "hit", "shutter"]
    why: str


class DirectorPlan(BaseModel):
    story: str          # 2-3 sentences: the arc you're building (hook -> ... -> payoff)
    cuts: list[DirCut]
    bursts: list[DirBurst]
    sfx: list[DirSfx]
    hook_note: str
    ending_note: str
    vo_feedback: str    # honest note on the voiceover itself (the editor can't fix the script)


class TalkSeg(BaseModel):
    clip: str
    start: float        # seconds in the clip
    end: float
    why: str


class TalkPlan(BaseModel):
    segments: list[TalkSeg]
    hook_note: str


PLAN_SYSTEM = f"""You are a senior short-form editor who cuts Instagram Reels for a startup founders' account.
You get a logged shot list and either a voiceover transcript with word timings, or the spoken lines found in the
clips. You decide the cut.

What great reels editing looks like:
- The first second earns the second second. Lead with the strongest image.
- Every shot is in focus, stable enough, and shows something. Cut anything soft, shaky, or empty.
- The picture follows the words: when a thing, place or person is mentioned, it's on screen.
- Rhythm: vary shot lengths with the energy of the line; quick cuts through lists and travel, holds on faces,
  reactions and payoffs. Never two near-identical shots back to back.
- Respect chronology for a day-in-the-life story unless breaking it makes a stronger hook.
- End on a face or a payoff.

{HOUSE_RULES}

Hard rules for your answer:
- Shots last between {MIN_SHOT}s and {MAX_SHOT}s.
- A shot's offset + its on-screen duration must fit inside that shot's usable length.
- Use each shot once unless there is truly nothing else.
- Never use a shot marked banned. Always use the shots marked must-use.
"""


def _shot_table(cands: list[dict], notes: dict[str, dict], clip_order: dict[str, int], banned: set, must: set) -> str:
    rows = []
    for c in cands:
        n = notes.get(c["id"], {})
        mark = " [BANNED]" if c["id"] in banned else (" [MUST-USE]" if c["id"] in must else "")
        rows.append(
            f"{c['id']}{mark} | clip#{clip_order[c['clip']]} @{c['start']:.1f}s | usable {c['dur']:.1f}s | "
            f"focus {c['focus']:.2f} stab {c['stability']:.2f} face {c['face']:.2f}"
            f"{' | ' + ','.join(c['flags']) if c['flags'] else ''} | "
            f"{n.get('shot_type', '?')}, energy {n.get('energy', '?')}, hook {n.get('hook', '?')}, "
            f"focus {'ok' if n.get('focus_ok', True) else 'SOFT'}, best {n.get('best_part', 'any')}"
            f"{', FILLER' if n.get('filler') else ''} | {n.get('what', '')} | tags: {', '.join(n.get('tags', []))}")
    return "\n".join(rows)


def plan_vo(words: list[dict], vo_dur: float, cands, notes, clip_order, pace: float, banned=(), must=(),
            revision_notes: str = "", brief: str = "", style_ref: str = "") -> VOPlan:
    wl = " ".join(f"{i}:{w['w']}@{w['s']:.2f}" for i, w in enumerate(words))
    text = (f"VOICEOVER ({vo_dur:.1f}s), as index:word@start-seconds:\n{wl}\n\n"
            f"A shot that starts on word i runs until the next shot's start word (the last one runs to {vo_dur:.1f}s).\n"
            f"Target average shot length: {pace:.1f}s (about {max(1, round(vo_dur / pace))} shots).\n\n"
            f"SHOT LIST (id | shooting order | usable length | measurements | log):\n"
            f"{_shot_table(cands, notes, clip_order, set(banned), set(must))}\n")
    if brief:
        text += f"\nBRIEF FROM THE CREATOR: {brief}\n"
    if style_ref:
        text += f"\n{style_ref}\n"
    if revision_notes:
        text += f"\nREVIEW OF YOUR PREVIOUS CUT — fix every point:\n{revision_notes}\n"
    text += "\nReturn the full cut: segments ordered by from_word, the first starting at word 0."
    return _ask([{"type": "text", "text": text}], VOPlan, PLAN_SYSTEM, effort="high")


def plan_talk(utterances: list[dict], cands, notes, clip_order, target_len: float, banned=(), must=(),
              revision_notes: str = "", brief: str = "", style_ref: str = "") -> TalkPlan:
    ul = "\n".join(f"{u['clip']} {u['start']:.2f}-{u['end']:.2f}s: \"{u['text']}\"" for u in utterances)
    text = (f"There is no separate voiceover: the story is told by what people say in the clips.\n"
            f"SPOKEN LINES (clip start-end: text):\n{ul}\n\n"
            f"SHOT LIST (for picture quality and context):\n"
            f"{_shot_table(cands, notes, clip_order, set(banned), set(must))}\n\n"
            f"Build a natural-sound reel of up to {target_len:.0f}s: the best spoken lines plus the best clean moments "
            f"between them (use a shot's clean range from the shot list for those), in the order that tells the "
            f"strongest story with the strongest moment first. Trim lines tight (no dead air, no false starts).")
    if brief:
        text += f"\nBRIEF FROM THE CREATOR: {brief}\n"
    if style_ref:
        text += f"\n{style_ref}\n"
    if revision_notes:
        text += f"\nREVIEW OF YOUR PREVIOUS CUT — fix every point:\n{revision_notes}\n"
    return _ask([{"type": "text", "text": text}], TalkPlan, PLAN_SYSTEM, effort="high")


DIRECTOR_SYSTEM = f"""You are the editor for @kriosfounders' Instagram Reels: day-in-the-life videos of three teenage
founders. You cut the way the creator cuts - you have his editing profile, measured from his own reels - but better:
tighter, cleaner, more intentional. You decide what goes where, how long each cut holds, where a quick-cut burst
goes and where (sparingly) a sound effect helps. You think like an editor, not a template: the day's order is the
backbone, but you move a shot when it makes the story stronger (a cold-open hook, a payoff saved for the end).

{PLAYBOOK}

{HOUSE_RULES}

Hard rules for your answer (a validator enforces them; breaking them just loses your intent):
- cuts: one per shot change, ordered by from_word, the first at word 0. Ordinary shots last {MIN_SHOT}-{MAX_SHOT}s.
- bursts: at most {2}, each 3-4 DIFFERENT shots (~{BURST['shot']}s each); no burst on or right after a payoff.
- sfx: click/pop only on burst cuts; at most {SFX_RULES['max_whoosh']} whooshes (real location changes);
  at most {SFX_RULES['max_riser']} riser(s), each into a genuine reveal, with a hit on that same reveal word;
  shutter only on a photo moment. Never more than one sound per cut. Leave most cuts silent.
- A shot's offset + its time on screen must fit in its usable length. Use each moment once.
- Never use a shot marked banned. Always use the shots marked must-use.
"""


def direct_vo(words, vo_dur, beats, scenes, beat_scene, cands, notes, clip_order, profile_text, pace_hint,
              music_beats=None, banned=(), must=(), revision_notes: str = "", brief: str = "",
              style_ref: str = "") -> DirectorPlan:
    wl = " ".join(f"{i}:{w['w']}@{w['s']:.2f}" for i, w in enumerate(words))
    bl = "\n".join(f"  beat {k} words {b['i0']}-{b['i1']} ({b['t0']:.1f}-{b['t1']:.1f}s) {b['intent']:10} "
                    f"[{scenes[beat_scene[k]]['id'] if scenes else '-'}] {b['text']}" for k, b in enumerate(beats))
    sl = "\n".join(f"  {sc['id']} {sc['label']} - clips {', '.join(sc['clips'])} - shots {', '.join(sc['shots'][:30])}"
                    for sc in scenes)
    text = (f"VOICEOVER ({vo_dur:.1f}s), as index:word@start-seconds:\n{wl}\n\n"
            f"STORY BEATS (my first read; scene in brackets is where the day's order puts it):\n{bl}\n\n"
            f"SCENES in the order they were filmed:\n{sl}\n\n"
            f"{profile_text}\nTarget rhythm: {pace_hint}\n\n"
            f"SHOT LIST (id | shooting order | usable length | measurements | log):\n"
            f"{_shot_table(cands, notes, clip_order, set(banned), set(must))}\n")
    if music_beats:
        text += f"\nMUSIC beats (s): {', '.join(f'{b:.2f}' for b in music_beats[:160])}\n"
    if brief:
        text += f"\nBRIEF FROM THE CREATOR: {brief}\n"
    if style_ref:
        text += f"\n{style_ref}\n"
    if revision_notes:
        text += f"\nREVIEW OF YOUR PREVIOUS CUT - fix every point:\n{revision_notes}\n"
    text += "\nReturn the full edit: story, cuts, bursts, sfx, and notes."
    return _ask([{"type": "text", "text": text}], DirectorPlan, DIRECTOR_SYSTEM, effort="high", max_tokens=32000)


# --------------------------------------------------------------------------------------------
# 3. Watch the render and critique it
# --------------------------------------------------------------------------------------------

class Fix(BaseModel):
    segment: int        # timeline segment number (0-based)
    problem: str
    fix: str


class Review(BaseModel):
    score: int          # 1-10 against top-tier short-form editing
    ship_it: bool
    strengths: list[str]
    fixes: list[Fix]


REVIEW_SYSTEM = f"""You are the most demanding short-form video editor reviewing a cut before it goes on Instagram
Reels. You get contact sheets of the rendered reel (frames every half second, timestamps burned in), the edit
decision list (with the sound effects), and objective measurements of the cut. Judge it against the best editing on the platform, not against "fine".

Check, in this order: the first second (would you stop scrolling?), focus and stability of every shot, whether
each shot matches what's being said at that moment, rhythm and energy (does it open fast and settle, are bursts in
the right places), filler, repeated or near-identical shots, sound design (purposeful and subtle, never on every
cut, riser landing on a real reveal), caption readability (captions are burned in; is anything important hidden
behind them?), and the ending.

{PLAYBOOK}

{HOUSE_RULES}

Score 1-10. ship_it only if it's 8 or more and nothing in it is soft, shaky or mismatched. Each fix names the
segment number and says concretely what to change (e.g. "segment 4: replace with c03s02, the plane window, because
the VO says 'we landed'")."""


def review(sheets: list[Path], edl_text: str, style_ref: str = "", metrics_text: str = "") -> Review:
    content: list = [{"type": "text", "text": f"EDIT DECISION LIST:\n{edl_text}"}]
    if metrics_text:
        content.append({"type": "text", "text": f"MEASURED (objective checks of this cut):\n{metrics_text}"})
    if style_ref:
        content.append({"type": "text", "text": style_ref + "\nAlso judge how closely the cut follows this reference."})
    for s in sheets:
        content.append(_img(s))
    content.append({"type": "text", "text": "Review this cut."})
    return _ask(content, Review, REVIEW_SYSTEM, effort="high")


# --------------------------------------------------------------------------------------------
# 4. Study a reference video
# --------------------------------------------------------------------------------------------

class RefProfile(BaseModel):
    summary: str        # two or three sentences: how this video is edited
    hook: str           # what happens in the first 1-2 seconds and why it works
    structure: str      # beats from start to end
    shot_mix: str       # proportions of face/reaction/b-roll/walking/detail etc.
    camera: str         # handheld/gimbal/static, distance to subject, movement
    energy_curve: str   # how the pace and energy change over time
    rules: list[str]    # 4-8 concrete editing rules someone could follow to cut new footage like this


REF_SYSTEM = """You are a senior short-form editor breaking down a reference reel so another editor can cut different
footage in the same style. You get one frame from the middle of each shot (numbered, with its length) plus measured
cut statistics and the transcript. Describe the editing, not the subject matter."""


def study_reference(sheet: Path, rhythm: dict, transcript: str) -> RefProfile:
    content = [
        {"type": "text", "text": (f"Measured: {rhythm['count']} shots in {rhythm['duration']}s, median shot "
                                  f"{rhythm['median']}s, by thirds {rhythm['by_third']}, shot lengths {rhythm['shots'][:60]}.\n"
                                  f"Transcript: {transcript or '(no speech)'}")},
        _img(sheet),
        {"type": "text", "text": "Break down how this reel is edited."},
    ]
    return _ask(content, RefProfile, REF_SYSTEM, effort="medium")
