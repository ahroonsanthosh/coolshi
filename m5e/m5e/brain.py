"""The AI editor: Claude logs every shot, plans the cut against the voiceover and watches the render.

m5e reaches Claude only through Claude Code logged in with your Claude subscription (Pro/Max), so the AI steps
run on your plan's included usage and never on pay-per-token API billing:
  - API keys, auth tokens, custom endpoints and cloud-provider switches are removed from Claude Code's
    environment, and its settings files are ignored, so the only way in is your claude.ai login;
  - before the first request, `claude auth status` has to say you're logged in with a Claude subscription,
    and every request's start-up message has to say no API key is in use;
  - the moment Claude Code reports a usage limit, or that it would start drawing on usage credits / extra
    usage, m5e ends that request and doesn't call Claude again until the limit resets (remembered in
    ~/.m5e/claude_limit.json). The edit carries on with the free local editor (see.py + director.py).
Without Claude Code, or without a subscription login, everything runs on the free local editor.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ValidationError

from .style import BURST, HOUSE_RULES, MAX_SHOT, MIN_SHOT, PLAYBOOK, SFX_RULES

EDIT_MODEL = os.environ.get("M5E_MODEL", "opus")         # directing and reviewing (a Claude Code model alias)
LOG_MODEL = os.environ.get("M5E_LOG_MODEL", "sonnet")    # logging shots: many images, so the lighter model
BATCH = 15            # candidate strips per "look at these shots" request
STATE_DIR = Path.home() / ".m5e"
LIMIT_FILE = STATE_DIR / "claude_limit.json"
log = print           # project.py points this at its own log


def _env_on() -> bool:
    return os.environ.get("M5E_CLAUDE", "on").strip().lower() not in ("0", "off", "false", "no")


enabled = _env_on()


def configure(on: bool = True, log_fn=None) -> None:
    """Per folder: "claude": false in m5e.json (or M5E_CLAUDE=off, or --no-claude) keeps m5e fully local."""
    global enabled, log
    enabled = bool(on) and _env_on()
    if log_fn is not None:
        log = log_fn


class BrainError(RuntimeError):
    pass


class LimitHit(BrainError):
    """Claude Code reported a usage limit, or that it would start using paid usage credits."""


# How Claude Code words its limit notices and its "now using paid credits" notices (taken from its own code),
# plus the older wording "Claude AI usage limit reached|<reset time>".
_LIMIT_START = ("You've hit your", "You've reached your", "You're out of usage credits", "Your org is out of usage",
                "Your seat type doesn't include", "Your usage allocation has been disabled",
                "Your group's usage limit", "You're out of extra usage")
_PAID_START = ("You're now using usage credits", "You're now using your usage allocation",
               "Now using your usage allocation", "Now using usage credits", "Now using credits",
               "You're now using extra usage", "Now using extra usage")
_LIMIT_RE = re.compile(r"usage limit reached|hit your [\w' -]{0,40}limit|requires usage credits|out of (extra )?usage|"
                       r"spend limit|reached your [\w' -]{0,40}limit", re.I)
_FAMILIES = ("opus", "sonnet", "haiku", "fable")


def _is_limit(text: str) -> bool:
    t = (text or "").strip()
    return t.startswith(_LIMIT_START + _PAID_START) or bool(_LIMIT_RE.search(t))


def _family(model: str) -> str:
    return next((f for f in _FAMILIES if f in model.lower()), model.lower())


# ------------------------------------------------------------------------------------------- limits

_session: dict[str, dict] = {}     # limits seen by this process: scope ("*" or a model family) -> {until, why}


def _blocks() -> dict[str, dict]:
    """Limits still in force: from this run and from earlier runs (until they reset)."""
    now = time.time()
    try:
        saved = json.loads(LIMIT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    out = {k: v for k, v in saved.items() if isinstance(v, dict) and float(v.get("until", 0)) > now}
    out.update({k: v for k, v in _session.items() if v["until"] > now})
    return out


def _block(scope: str, why: str, until: float | None) -> None:
    until = float(until) if until and float(until) > time.time() else time.time() + 3600
    _session[scope] = {"until": until, "why": why}
    try:
        saved = json.loads(LIMIT_FILE.read_text(encoding="utf-8")) if LIMIT_FILE.exists() else {}
    except (OSError, ValueError):
        saved = {}
    saved = {k: v for k, v in saved.items() if isinstance(v, dict) and float(v.get("until", 0)) > time.time()}
    saved[scope] = {"until": until, "why": why}
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        LIMIT_FILE.write_text(json.dumps(saved, indent=1), encoding="utf-8")
    except OSError:
        pass


def _until_text(b: dict) -> str:
    return time.strftime("%H:%M on %a %d %b", time.localtime(b["until"]))


_LIMIT_NAMES = {"five_hour": "5-hour", "seven_day": "weekly", "seven_day_opus": "weekly Opus",
                "seven_day_sonnet": "weekly Sonnet", "overage": "usage-credit"}


def _limit_name(info: dict) -> str:
    kind = str(info.get("rateLimitType") or "")
    return _LIMIT_NAMES.get(kind, kind.replace("_", " "))


def _hit(info: dict, why: str, model: str):
    """Claude Code says a limit is reached (or paid usage would start): stop using Claude until it resets."""
    paid = bool(info.get("isUsingOverage")) or (why or "").strip().startswith(_PAID_START)
    kind = str(info.get("rateLimitType") or "")
    m = re.search(r"\b(Opus|Sonnet|Haiku|Fable)\b[^.\n]{0,30}\b(limit|requires usage credits)", why or "")
    scope = "*"
    if not paid:
        scope = next((f for f in _FAMILIES if f in kind.lower()), None) or (m.group(1).lower() if m else "*")
    until = info.get("resetsAt") or info.get("resets_at")
    old = re.search(r"\|(\d{9,})", why or "")
    if not until and old:
        until = int(old.group(1))
    if paid:
        why = ("your plan's included usage is used up and Claude Code would start using paid usage credits, so m5e "
               "stopped")
    _block(scope, (why or "usage limit reached").strip(), until)
    raise LimitHit(why)


def _extra_usage_on(info: dict) -> bool:
    return info.get("overageStatus") in ("allowed", "allowed_warning") and not info.get("overageDisabledReason")


def _model_for(preferred: str) -> str:
    """The model to use: the preferred one, or the other included one when only the preferred model's own limit
    is reached. Raises LimitHit when Claude is at its limit."""
    b = _blocks()
    if "*" in b:
        raise LimitHit(f"{b['*']['why']} (m5e uses Claude again after {_until_text(b['*'])})")
    if _family(preferred) not in b:
        return preferred
    for alt in ("opus", "sonnet"):
        if alt not in b:
            log(f"  Claude: the {_family(preferred)} limit on your plan is reached; using {alt} (still your plan)")
            return alt
    first = min(b.values(), key=lambda v: v["until"])
    raise LimitHit(f"{first['why']} (m5e uses Claude again after {_until_text(first)})")


# ------------------------------------------------------------------------------------------- Claude Code

def _exe() -> str | None:
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for c in (home / ".local" / "bin" / "claude", home / ".claude" / "local" / "claude",
              Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude"),
              home / ".local" / "bin" / "claude.exe", home / "AppData" / "Roaming" / "npm" / "claude.cmd"):
        if c.exists():
            return str(c)
    return None


def _env() -> dict:
    """Claude Code's environment with every way to bill per token removed: API keys, auth tokens, custom
    endpoints and gateways (all ANTHROPIC_*), cloud-provider switches, and anything left over from another
    Claude Code session (all other CLAUDE* variables). Your claude.ai login (or a subscription token from
    `claude setup-token`) is what's left."""
    keep = ("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH")
    return {k: v for k, v in os.environ.items()
            if not (k.startswith("ANTHROPIC_") or k == "AWS_BEARER_TOKEN_BEDROCK"
                    or (k.startswith("CLAUDE") and k not in keep))}


_flag_cache: dict[str, set] = {}


def _flags(exe: str) -> set[str]:
    """The options this Claude Code version understands (so m5e works with older and newer versions)."""
    if exe not in _flag_cache:
        try:
            out = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=60, env=_env(),
                                 encoding="utf-8", errors="replace").stdout
        except (OSError, subprocess.TimeoutExpired):
            out = ""
        _flag_cache[exe] = set(re.findall(r"(--[a-z][a-z-]+)", out))
    return _flag_cache[exe]


_login = {"t": 0.0, "ok": False, "why": "not checked"}


def _check_login() -> tuple[bool, str]:
    exe = _exe()
    if not exe:
        return False, "Claude Code isn't installed"
    try:
        r = subprocess.run([exe, "auth", "status", "--json"], capture_output=True, text=True, timeout=90,
                           env=_env(), cwd=tempfile.gettempdir(), encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"couldn't run Claude Code ({e})"
    out = r.stdout or ""
    try:
        st = json.loads(out[out.index("{"):])
    except ValueError:
        return False, "this Claude Code is too old to report its login (update it: claude update)"
    if not st.get("loggedIn"):
        return False, "Claude Code isn't logged in (run: claude auth login)"
    if st.get("authMethod") not in ("claude.ai", "oauth_token") or st.get("apiKeySource") \
            or st.get("apiProvider", "firstParty") != "firstParty":
        return False, ("Claude Code is set up with an API key, gateway or cloud provider, which bills per token; m5e "
                       "only uses a Claude subscription login (run: claude auth login --claudeai)")
    return True, f"your Claude {st.get('subscriptionType') or 'subscription'} plan"


def login(force: bool = False) -> tuple[bool, str]:
    """(ok, what): is Claude Code installed and logged in with a Claude subscription? Checked every few minutes."""
    if force or time.time() - _login["t"] > 300:
        ok, why = _check_login()
        _login.update(t=time.time(), ok=ok, why=why)
    return _login["ok"], _login["why"]


def available() -> bool:
    if not enabled:
        return False
    b = _blocks()
    if "*" in b or all(f in b for f in ("opus", "sonnet")):
        return False
    return login()[0]


def status() -> str:
    """One line for the log: is Claude helping with this edit, and if not, why not."""
    if not enabled:
        return "Claude is switched off for this folder (\"claude\": false); using the free local editor"
    b = _blocks()
    if "*" in b:
        return (f"Claude isn't used until {_until_text(b['*'])}: {b['*']['why']}. Using the free local editor")
    ok, why = login()
    if not ok:
        return f"Claude isn't used ({why}); using the free local editor"
    return f"Claude helps with this edit on {why} (it stops when the plan's usage limit is reached)"


def _inline(schema: dict) -> dict:
    """Pydantic's JSON schema with every $ref replaced by its definition (simplest form for structured output)."""
    defs = schema.get("$defs", {})

    def walk(x):
        if isinstance(x, dict):
            if "$ref" in x:
                return walk(defs[x["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in x.items() if k != "$defs"}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x
    return walk(schema)


def _text(message) -> str:
    if not isinstance(message, dict):
        return ""
    parts = message.get("content") or []
    if isinstance(parts, str):
        return parts
    return " ".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text").strip()


_warned: set = set()


def _watch(ev: dict, model: str) -> None:
    """Look at one line of Claude Code's output for anything that means: stop."""
    t = ev.get("type")
    if t == "system" and ev.get("subtype") == "init":
        if ev.get("apiKeySource") not in (None, "none"):
            _login.update(t=time.time(), ok=False, why="Claude Code started with an API key (pay per token)")
            raise BrainError("Claude Code started with an API key (billed per token), so m5e stopped it; m5e only "
                             "uses your Claude subscription login")
    elif t == "rate_limit_event":
        info = ev.get("rate_limit_info") or {}
        name = _limit_name(info) or "usage"
        if info.get("isUsingOverage"):
            _hit(info, "", model)
        if info.get("status") == "rejected":
            _hit(info, f"You've hit your plan's {name} limit", model)
        if _extra_usage_on(info) and "extra" not in _warned:
            _warned.add("extra")
            log("  Claude: extra usage (usage credits) is switched on for your account. m5e never uses it, but to "
                "be certain nothing is ever billed, switch it off at claude.ai -> Settings -> Usage.")
        if info.get("status") == "allowed_warning":
            u = info.get("utilization")
            used = f"{float(u) * 100:.0f}% of" if u is not None else "most of"
            if _extra_usage_on(info):
                # Claude Code only says it used paid credits after that request has run, so with extra usage
                # switched on m5e stops here, at the warning, instead of finding out from the bill
                _block("*", f"{used} your plan's {name} limit is used and extra usage is switched on, so m5e "
                            f"stopped early to make sure nothing is billed", info.get("resetsAt"))
                log(f"  Claude: {used} your plan's {name} limit used and extra usage is on: m5e stops using Claude "
                    f"now so nothing is billed (switch extra usage off to let m5e use the rest of your plan)")
            elif (name, int(float(u or 0) * 20)) not in _warned:
                _warned.add((name, int(float(u or 0) * 20)))
                log(f"  Claude: {used} your plan's {name} limit used; m5e stops using Claude when it's reached")
    elif t == "system":
        for v in ev.values():
            if isinstance(v, str) and v.strip().startswith(_PAID_START):
                _hit({}, v, model)
    elif t == "assistant" and ev.get("error"):
        text = _text(ev.get("message"))
        if ev["error"] in ("rate_limit", "billing_error") or _is_limit(text):
            _hit({}, text or "Claude Code reported a usage limit", model)
        if ev["error"] in ("authentication_failed", "oauth_org_not_allowed", "account_on_hold"):
            _login.update(t=time.time(), ok=False, why=text or ev["error"])
        raise BrainError(f"Claude Code: {text or ev['error']}")
    elif t == "result" and ev.get("is_error"):
        text = str(ev.get("result") or ev.get("subtype") or "")
        if _is_limit(text):
            _hit({}, text, model)
        raise BrainError(f"Claude Code: {text[:300]}")


def _run(cmd: list[str], content: list, cwd: str, timeout: float, model: str) -> dict:
    """Start Claude Code, send the request, watch its output line by line; returns the final result message."""
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
                                env=_env(), text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise BrainError(f"couldn't start Claude Code ({e})") from e
    lines: queue.Queue = queue.Queue()
    err: list[str] = []

    def feed():
        try:
            proc.stdin.write(msg)
            proc.stdin.close()
        except (OSError, ValueError):
            pass

    def read():
        for ln in proc.stdout:
            lines.put(ln)
        lines.put(None)

    def drain():
        for ln in proc.stderr:
            err.append(ln)

    workers = [threading.Thread(target=f, daemon=True) for f in (feed, read, drain)]
    for w in workers:
        w.start()
    deadline = time.monotonic() + timeout
    result = None
    try:
        while True:
            try:
                ln = lines.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                raise BrainError(f"Claude took longer than {timeout / 60:.0f} minutes, so m5e skipped this step")
            if ln is None:
                break
            try:
                ev = json.loads(ln)
            except ValueError:
                continue
            if isinstance(ev, dict):
                _watch(ev, model)
                if ev.get("type") == "result":
                    result = ev
                    break
    finally:
        if result is None and proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        for w in workers[1:]:
            w.join(timeout=5)
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
    if result is None:
        tail = "".join(err)[-800:]
        if _is_limit(tail):
            _hit({}, tail.strip().splitlines()[-1], model)
        if re.search(r"not logged in|please run /login|invalid api key|oauth token", tail, re.I):
            _login.update(t=time.time(), ok=False, why="Claude Code isn't logged in (run: claude auth login)")
            raise BrainError("Claude Code isn't logged in (run: claude auth login)")
        raise BrainError(f"Claude Code stopped without an answer: {tail.strip()[-300:] or 'no output'}")
    return result


def _ask(content: list, schema: type[BaseModel], system: str, model: str = EDIT_MODEL, effort: str = "high",
         timeout: float = 1500.0):
    """One request to Claude through Claude Code (your subscription); the answer is validated against schema."""
    if not enabled:
        raise BrainError("Claude is switched off")
    ok, why = login()
    if not ok:
        raise BrainError(why)
    for attempt in range(2):
        use = _model_for(model)
        try:
            return _ask_once(content, schema, system, use, effort, timeout)
        except LimitHit:
            b = _blocks()
            if attempt or "*" in b or _family(use) not in b:
                raise
            # only that model's own limit: _model_for picks the other included model


def _ask_once(content: list, schema: type[BaseModel], system: str, model: str, effort: str, timeout: float):
    exe = _exe()
    flags = _flags(exe)
    with tempfile.TemporaryDirectory(prefix="m5e-claude-") as tmp:
        cmd = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--model", model, "--json-schema", json.dumps(_inline(schema.model_json_schema())),
               "--max-turns", "4"]
        if "--system-prompt-file" in flags:
            sp = Path(tmp) / "system.md"
            sp.write_text(system, encoding="utf-8")
            cmd += ["--system-prompt-file", str(sp)]
        else:
            cmd += ["--system-prompt", system]
        if "--effort" in flags:
            cmd += ["--effort", effort]
        if "--tools" in flags:
            cmd += ["--tools", ""]                      # no tools: it only looks and answers
        for f in ("--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"):
            if f in flags:
                cmd.append(f)                           # ignore settings files, hooks, plugins, MCP servers
        res = _run(cmd, content, tmp, timeout, model)
    out = res.get("structured_output")
    if out is None:
        text = str(res.get("result") or "")
        try:
            out = json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError:
            raise BrainError("Claude gave no usable answer") from None
    try:
        return schema.model_validate(out)
    except ValidationError as e:
        raise BrainError(f"Claude's answer didn't fit the expected shape ({e.error_count()} problems)") from e


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


def describe(cands: list[dict], strip_dir: Path, clip_order: dict[str, int], context: str = "",
             on_notes=None) -> dict[str, dict]:
    """Log every shot, BATCH at a time. on_notes(batch_notes) is called after each batch, so what was logged is
    kept even if a usage limit stops the rest."""
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
        out = _ask(content, ShotNotes, DESCRIBE_SYSTEM, model=LOG_MODEL, effort="medium", timeout=900)
        got = {n.id: n.model_dump() for n in out.shots if n.id in {c["id"] for c in batch}}
        notes.update(got)
        if on_notes:
            on_notes(got)
    return notes


# --------------------------------------------------------------------------------------------
# 2. Plan the edit
# --------------------------------------------------------------------------------------------

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
    return _ask([{"type": "text", "text": text}], DirectorPlan, DIRECTOR_SYSTEM, effort="high")


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
    return _ask(content, RefProfile, REF_SYSTEM, model=LOG_MODEL, effort="medium", timeout=600)
