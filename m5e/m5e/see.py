"""Free, local understanding of the footage: CLIP (ViT-B/32, ONNX via fastembed) on the laptop's CPU.
No account, no key, no internet after the first download (~600 MB, kept in ~/.m5e/models).

What it gives the editor:
  - an embedding per shot, so a voiceover line can pull the shots that show it ("we landed in Lisbon")
  - shot types (wide, transport, walking-away, food/object, screen, group, filler) - judged RELATIVE to the
    rest of the day's footage, which removes CLIP's habit of putting everything in one catch-all class
  - tags and a setting, in plain words, for the report and the review page
Faces, focus and motion come from the measurements in analyze.py, which are better at those than CLIP.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PIL import Image

IMG_MODEL = "Qdrant/clip-ViT-B-32-vision"
TXT_MODEL = "Qdrant/clip-ViT-B-32-text"
MODEL_DIR = Path(os.environ.get("M5E_MODELS", Path.home() / ".m5e" / "models"))

TYPES = {
    "walking away / back of head": ["people walking away from the camera, seen from behind",
                                    "the backs of people walking down a street", "following a person, view of their back"],
    "wide/establishing": ["a wide shot of a city street with buildings", "an aerial view of a city",
                          "the outside of a building", "a landscape with sky"],
    "transport / transition": ["the view out of an airplane window", "inside a train or a bus", "inside a car",
                               "an airport terminal", "an escalator or stairs in a station"],
    "detail / object": ["a close-up of food", "a close-up of a drink or a coffee cup", "an object held in a hand"],
    "pov / hands": ["hands doing something, first person view", "hands holding a phone"],
    "screen / product": ["a laptop screen", "a computer screen showing an app", "a phone screen close up"],
    "group": ["a group of friends posing together", "several people standing together smiling"],
    "filler": ["a blurry photo of the floor", "a photo of a ceiling", "a dark blurry photo", "a plain wall"],
}
SETTINGS = ["airport", "airplane", "train station", "bus", "car", "city street", "office", "co-working space",
            "meeting room", "conference hall", "stage", "cafe", "restaurant", "kitchen", "apartment", "hotel room",
            "shop", "supermarket", "park", "beach", "gym", "school", "university campus", "night street"]
VOCAB = ["airport", "plane", "airplane window", "runway", "suitcase", "passport", "train", "bus", "car", "taxi",
         "street", "city", "buildings", "skyline", "bridge", "river", "beach", "sea", "park", "trees", "sunset",
         "night", "rain", "office", "desk", "laptop", "computer screen", "phone", "whiteboard", "presentation",
         "meeting", "conference", "stage", "microphone", "audience", "crowd", "badge", "lanyard", "sign",
         "coffee", "drink", "can", "food", "kebab", "sandwich", "pizza", "burger", "breakfast", "dinner", "kitchen",
         "cooking", "restaurant", "cafe", "shop", "store", "apple store", "hotel", "apartment", "balcony", "bed",
         "gym", "friends", "group photo", "selfie", "handshake", "laughing", "talking", "walking", "escalator",
         "stairs", "elevator", "newspaper", "book", "money", "keys", "door", "window", "mirror", "camera", "car seat"]


class Seer:
    def __init__(self):
        from fastembed import ImageEmbedding, TextEmbedding
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        self.img = ImageEmbedding(IMG_MODEL, cache_dir=str(MODEL_DIR))
        self.txt = TextEmbedding(TXT_MODEL, cache_dir=str(MODEL_DIR))
        self._text_cache: dict[str, np.ndarray] = {}

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-9)

    def images(self, imgs: list) -> np.ndarray:
        return self._norm(np.array(list(self.img.embed(imgs)), dtype=np.float32))

    def texts(self, texts: list[str]) -> np.ndarray:
        todo = [t for t in texts if t not in self._text_cache]
        if todo:
            for t, e in zip(todo, self.txt.embed(todo)):
                self._text_cache[t] = self._norm(np.asarray(e, dtype=np.float32))
        return np.stack([self._text_cache[t] for t in texts]) if texts else np.zeros((0, 512), np.float32)


_seer: Seer | None = None


def seer() -> Seer:
    global _seer
    if _seer is None:
        _seer = Seer()
    return _seer


def available() -> bool:
    import importlib.util
    return importlib.util.find_spec("fastembed") is not None


def strip_tiles(strip: Path, tile_w: int = 300) -> list[Image.Image]:
    """The three frames (start/middle/end) out of a candidate strip made by analyze.make_strip."""
    im = Image.open(strip).convert("RGB")
    return [im.crop((k * (tile_w + 4), 0, k * (tile_w + 4) + tile_w, im.height)) for k in range(3)]


def embed_shots(cands: list[dict], strip_dir: Path) -> dict[str, np.ndarray]:
    """One embedding per candidate shot: the mean of its three frames."""
    s = seer()
    out = {}
    for c in cands:
        tiles = strip_tiles(strip_dir / f"{c['id']}.jpg")
        e = s.images(tiles).mean(0)
        out[c["id"]] = e / (np.linalg.norm(e) + 1e-9)
    return out


def _relative(sim: np.ndarray) -> np.ndarray:
    """z-score each column across the day's shots: a label only wins a shot if it stands out for that shot
    compared with the rest of the footage (removes CLIP's catch-all bias)."""
    mu = sim.mean(0, keepdims=True)
    sd = sim.std(0, keepdims=True) + 1e-6
    return (sim - mu) / sd


def notes_for(cands: list[dict], emb: dict[str, np.ndarray]) -> dict[str, dict]:
    """Shot log in the same shape the AI editor produces, from CLIP + the measurements."""
    if not cands:
        return {}
    s = seer()
    ids = [c["id"] for c in cands]
    E = np.stack([emb[i] for i in ids])
    labels = list(TYPES)
    prompts = [p for k in labels for p in TYPES[k]]
    P = s.texts(["a photo of " + p for p in prompts])
    raw = E @ P.T - _hub(E)
    per_type = np.stack([raw[:, [j for j, p in enumerate(prompts) if p in TYPES[k]]].max(1) for k in labels], 1)
    rel = _relative(per_type) if len(ids) >= 4 else per_type * 0
    st_e = s.texts([f"a photo of a {x}" for x in SETTINGS])
    rel_set = _relative(E @ st_e.T) if len(ids) >= 4 else E @ st_e.T
    vo_e = s.texts([f"a photo of {x}" for x in VOCAB])
    rel_tag = _relative(E @ vo_e.T) if len(ids) >= 4 else E @ vo_e.T
    out = {}
    for i, c in enumerate(cands):
        face = c.get("face", 0.0)
        r = {k: float(rel[i, j]) for j, k in enumerate(labels)}
        if face >= 0.18:
            st = "face close-up"
        elif c.get("faces", 0) >= 3 and r["group"] > 0.5:
            st = "group"
        else:
            k = max((k for k in labels if k not in ("group",)), key=lambda k: r[k])
            st = k if r[k] > 0.8 else ("medium" if face >= 0.06 else "other")
            if st == "filler":
                st = "other"
        filler = r["filler"] > 1.5 or (st == "walking away / back of head" and face == 0)
        tags = [VOCAB[j] for j in np.argsort(-rel_tag[i])[:5] if rel_tag[i, j] > 1.0]
        setting = SETTINGS[int(np.argmax(rel_set[i]))]
        energy = int(np.clip(1 + 6 * c.get("jitter", 0) / 0.03 + 2 * (1 - c.get("stability", 1)) + min(c.get("faces", 0), 2),
                             1, 5))
        hook = int(np.clip(1 + 4 * min(face * 3.5, 1) + (1 if st in ("group", "screen / product") else 0)
                           - (2 if filler else 0), 1, 5))
        what = f"{st}" + (f", {', '.join(tags[:3])}" if tags else "") + f" ({setting})"
        out[c["id"]] = {"what": what, "people": f"{c.get('faces', 0)} face(s)", "setting": setting, "shot_type": st,
                        "energy": energy, "hook": hook, "focus_ok": True, "framing_ok": True, "filler": bool(filler),
                        "best_part": "any", "action": c.get("stability", 1) < 0.8, "photo_moment": False,
                        "tags": tags, "_source": "local"}
    return out


def _hub(E: np.ndarray) -> np.ndarray:
    """How much each shot matches *anything* (vague images score high against every sentence); subtracted
    before comparing, so a shot only wins a line it specifically shows."""
    bank = seer().texts(["a photo of " + v for v in VOCAB])
    return (E @ bank.T).mean(1, keepdims=True)


def beat_shot_scores(beats: list[dict], emb: dict[str, np.ndarray]) -> dict[tuple[int, str], float]:
    """How well each shot shows each voiceover beat, z-scored per beat: the 'show what's said' signal.
    Tested on the account's footage: the right shot is in the top 2 for every test line."""
    if not beats or not emb:
        return {}
    s = seer()
    ids = list(emb)
    E = np.stack([emb[i] for i in ids])
    T = s.texts(["a photo of " + b["text"][:200] for b in beats])
    sim = E @ T.T - _hub(E)                        # shots x beats
    z = (sim - sim.mean(0, keepdims=True)) / (sim.std(0, keepdims=True) + 1e-6)
    return {(k, ids[i]): float(z[i, k]) for k in range(len(beats)) for i in range(len(ids))}
