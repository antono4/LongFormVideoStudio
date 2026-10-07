"""Fetch a still image for each scene.

Tries several free providers in order and always returns an image:
  1. Pollinations (fast when the free tier is available)
  2. Hugging Face FLUX.1-schnell Space (high quality, limited free GPU quota)
  3. A locally drawn stylised card (always works, used as the last resort)
"""

import colorsys
import random
import re
import time
import urllib.parse
from pathlib import Path

import requests

from . import config

try:
    from PIL import Image, ImageDraw
except Exception:  # pragma: no cover
    Image = None

_hf_client = None
_hf_cooldown_until = 0.0
HF_SPACE = "black-forest-labs/FLUX.1-schnell"


def _looks_like_image(content: bytes) -> bool:
    return (
        content[:3] == b"\xff\xd8\xff"
        or content[:8] == b"\x89PNG\r\n\x1a\n"
        or content[:4] == b"RIFF"
    )


def _fit_to_jpeg(source, out_path: Path, width: int, height: int) -> bool:
    """Open any image source and save a cropped 16:9 JPEG."""
    if Image is None:
        return False
    try:
        img = Image.open(source).convert("RGB")
        src_ratio = img.width / img.height
        dst_ratio = width / height
        if src_ratio > dst_ratio:
            new_w = int(img.height * dst_ratio)
            left = (img.width - new_w) // 2
            img = img.crop((left, 0, left + new_w, img.height))
        else:
            new_h = int(img.width / dst_ratio)
            top = (img.height - new_h) // 2
            img = img.crop((0, top, img.width, top + new_h))
        img = img.resize((width, height), Image.LANCZOS)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path, "JPEG", quality=90)
        return True
    except Exception:
        return False


# --- Provider 1: Pollinations ---------------------------------------------
def _pollinations(prompt: str, out_path: Path, width: int, height: int, seed: int) -> bool:
    url = (
        config.IMAGE_API + urllib.parse.quote(prompt)
        + f"?width={width}&height={height}&nologo=true&seed={seed}"
    )
    try:
        resp = requests.get(url, timeout=config.HTTP_TIMEOUT)
        if resp.status_code == 200 and _looks_like_image(resp.content):
            out_path.write_bytes(resp.content)
            return _fit_to_jpeg(out_path, out_path, width, height)
    except Exception:
        pass
    return False


# --- Provider 2: Hugging Face FLUX Space ----------------------------------
def _get_hf_client():
    global _hf_client
    if _hf_client is None:
        from gradio_client import Client

        kwargs = {}
        if config.HF_TOKEN:
            kwargs["token"] = config.HF_TOKEN
        _hf_client = Client(HF_SPACE, verbose=False, **kwargs)
    return _hf_client


def _hf_flux(prompt: str, out_path: Path, width: int, height: int, seed: int) -> bool:
    global _hf_cooldown_until
    if time.time() < _hf_cooldown_until:
        return False
    try:
        client = _get_hf_client()
        result = client.predict(
            prompt=prompt, seed=seed, randomize_seed=True,
            width=width, height=height, num_inference_steps=4, api_name="/infer",
        )
        source = result[0] if isinstance(result, (list, tuple)) else result
        return _fit_to_jpeg(source, out_path, width, height)
    except Exception as exc:
        message = str(exc).lower()
        if "quota" in message or "zerogpu" in message:
            _hf_cooldown_until = time.time() + 90
        else:
            _hf_client = None  # reconnect on next attempt
        return False


# --- Provider 3: Wikimedia Commons (real, keyword-relevant photos) --------
_STYLE_WORDS = {
    "cinematic", "highly", "detailed", "lighting", "16:9", "photorealistic",
    "anime", "3d", "render", "watercolor", "documentary", "shot", "style",
}


def _keywords(prompt: str, limit: int = 6) -> str:
    words = re.findall(r"[a-zA-Z]+", prompt.lower())
    keep = [w for w in words if w not in _STYLE_WORDS and len(w) > 2]
    return " ".join(keep[:limit])


def _wikimedia_search(query: str, width: int):
    params = {
        "action": "query", "generator": "search",
        "gsrsearch": f"filetype:bitmap {query}", "gsrnamespace": 6, "gsrlimit": 5,
        "prop": "imageinfo", "iiprop": "url|mime|size", "iiurlwidth": width, "format": "json",
    }
    resp = requests.get(
        config.WIKIMEDIA_API, params=params,
        headers={"User-Agent": "LongFormVideoStudio/1.0 (educational)"}, timeout=60,
    )
    return resp.json().get("query", {}).get("pages", {})


def _wikimedia(prompt: str, out_path: Path, width: int, height: int, seed: int) -> bool:
    words = _keywords(prompt).split()
    if not words:
        return False
    # Try the full phrase, then progressively shorter phrases.
    for size in (len(words), max(1, len(words) - 2), 1):
        query = " ".join(words[:size])
        try:
            pages = _wikimedia_search(query, width)
        except Exception:
            continue
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            url = info.get("thumburl") or info.get("url")
            if not url or info.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
                continue
            try:
                img = requests.get(url, timeout=60,
                                   headers={"User-Agent": "LongFormVideoStudio/1.0"})
                if img.status_code == 200 and len(img.content) > 5000:
                    tmp = out_path.with_suffix(".src")
                    tmp.write_bytes(img.content)
                    ok = _fit_to_jpeg(tmp, out_path, width, height)
                    tmp.unlink(missing_ok=True)
                    if ok:
                        return True
            except Exception:
                continue
    return False


# --- Provider 4: Picsum (always-available stock photo) --------------------
def _picsum(prompt: str, out_path: Path, width: int, height: int, seed: int) -> bool:
    try:
        resp = requests.get(f"https://picsum.photos/{width}/{height}?random={seed}",
                            timeout=60)
        if resp.status_code == 200 and _looks_like_image(resp.content):
            tmp = out_path.with_suffix(".src")
            tmp.write_bytes(resp.content)
            ok = _fit_to_jpeg(tmp, out_path, width, height)
            tmp.unlink(missing_ok=True)
            return ok
    except Exception:
        pass
    return False


# --- Provider 5: local stylised card --------------------------------------
def _local_card(prompt: str, out_path: Path, width: int, height: int, seed: int) -> bool:
    if Image is None:
        return False
    rng = random.Random(seed)
    hue = rng.random()
    top = tuple(int(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.55, 0.28))
    bottom = tuple(int(c * 255) for c in colorsys.hsv_to_rgb((hue + 0.08) % 1.0, 0.65, 0.10))
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    cx, cy = int(width * (0.3 + 0.4 * rng.random())), int(height * 0.4)
    for radius in range(min(width, height) // 2, 0, -6):
        shade = int(255 * (1 - radius / (min(width, height) / 2)) * 0.22)
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                     outline=(shade, shade, shade))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "JPEG", quality=88)
    return True


PROVIDERS = [
    ("pollinations", _pollinations),
    ("huggingface-flux", _hf_flux),
    ("wikimedia", _wikimedia),
    ("picsum", _picsum),
]


def fetch_image(prompt: str, out_path: Path, width: int = config.WIDTH,
                height: int = config.HEIGHT, seed: int = 0) -> dict:
    """Download one scene image. Always returns {'path', 'source'}."""
    out_path = Path(out_path)
    for name, provider in PROVIDERS:
        if provider(prompt, out_path, width, height, seed):
            if out_path.exists() and out_path.stat().st_size > 2000:
                return {"path": out_path, "source": name}
    _local_card(prompt, out_path, width, height, seed)
    return {"path": out_path, "source": "local"}
