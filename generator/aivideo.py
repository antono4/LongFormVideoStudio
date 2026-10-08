"""Generate short AI motion clips via the free LTX-Video Hugging Face Space.

The Space is a Gradio app; we drive it with the official `gradio_client`
protocol (queue join + SSE stream). No API key is required, but anonymous
ZeroGPU quota is limited. When a clip cannot be produced the caller is expected
to fall back to a Ken Burns pan of the still image, so generation never fails
outright.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import config

# LTX-Video distilled (Lightricks) — text-to-video and image-to-video.
SPACE_ID = "Lightricks/ltx-video-distilled"
SPACE_URL = "https://lightricks-ltx-video-distilled.hf.space"

MIN_CLIP_SECONDS = 0.3
MAX_CLIP_SECONDS = 8.5
DEFAULT_CLIP_SECONDS = 2.0

NEGATIVE_PROMPT = "worst quality, inconsistent motion, blurry, jittery, distorted, watermark, text"


def is_available() -> bool:
    return _client_module() is not None


def _client_module():
    try:
        import gradio_client  # noqa: F401
        return gradio_client
    except Exception:
        return None


def _token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")


def _make_client():
    module = _client_module()
    if module is None:
        raise RuntimeError("gradio_client is not installed")
    kwargs = {"verbose": False}
    if _token():
        kwargs["token"] = _token()
    return module.Client(SPACE_ID, **kwargs)


def _clamp_duration(seconds: float) -> float:
    return max(MIN_CLIP_SECONDS, min(MAX_CLIP_SECONDS, float(seconds)))


def _predict(client, image_path: Path | None, prompt: str, duration: float, seed: int,
             width: int, height: int):
    module = _client_module()
    handle_file = module.handle_file
    duration = _clamp_duration(duration)
    common = dict(
        prompt=prompt,
        negative_prompt=NEGATIVE_PROMPT,
        height_ui=height,
        width_ui=width,
        duration_ui=duration,
        ui_frames_to_use=9,
        seed_ui=seed,
        randomize_seed=False,
        ui_guidance_scale=1,
        improve_texture_flag=True,
    )
    if image_path is not None:
        result = client.predict(
            input_image_filepath=handle_file(str(image_path)),
            input_video_filepath=None,
            mode="image-to-video",
            api_name="/image_to_video",
            **common,
        )
    else:
        result = client.predict(
            input_image_filepath=None,
            input_video_filepath=None,
            mode="text-to-video",
            api_name="/text_to_video",
            **common,
        )
    return result


def _extract_video_path(result) -> Path:
    data = result[0] if isinstance(result, (tuple, list)) else result
    if isinstance(data, dict):
        data = data.get("video", data)
    if isinstance(data, dict):
        data = data.get("path") or data.get("url")
    if not data:
        raise RuntimeError("space returned no video")
    path = Path(str(data))
    if not path.exists():
        raise RuntimeError(f"space video not found: {path}")
    return path


def generate_clip(image_path: Path | None, prompt: str, out_path: Path,
                  duration: float = DEFAULT_CLIP_SECONDS, seed: int = 42,
                  width: int = 704, height: int = 512) -> dict:
    """Generate one motion clip. Returns {'path','source','duration'}.

    Raises on failure so callers can fall back to a still-image pan.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    client = _make_client()
    result = _predict(client, image_path, prompt, duration, seed, width, height)
    produced = _extract_video_path(result)
    shutil.copyfile(produced, out_path)
    return {
        "path": out_path,
        "source": "ltx-video",
        "duration": _clamp_duration(duration),
    }


def generate_motion_clips(scenes: list, work_dir: Path, on_progress=None) -> list:
    """Attach an AI motion clip to each scene, falling back to the still image.

    Each scene dict gets 'clip' (path or None) and 'clip_source'. Never raises;
    a missing clip simply means the renderer uses the Ken Burns path.
    """
    work_dir = Path(work_dir)
    clips: list = []
    total = len(scenes)
    client = None
    try:
        client = _make_client()
    except Exception:
        client = None

    for i, scene in enumerate(scenes):
        scene["clip"] = None
        scene["clip_source"] = "kenburns"
        if client is not None:
            duration = min(MAX_CLIP_SECONDS, max(DEFAULT_CLIP_SECONDS,
                                                 float(scene.get("audio_duration", DEFAULT_CLIP_SECONDS)) + 1.0))
            clip_path = work_dir / f"clip_{i}.mp4"
            try:
                result = _predict(
                    client, Path(scene["image"]), scene.get("visual", ""),
                    duration, seed=1000 + i, width=704, height=512,
                )
                shutil.copyfile(_extract_video_path(result), clip_path)
                scene["clip"] = str(clip_path)
                scene["clip_source"] = "ltx-video"
            except Exception as exc:  # quota, timeout, space error — keep going
                scene["clip_source"] = f"kenburns ({exc})"[:120]
        clips.append(scene["clip"])
        if on_progress:
            on_progress(f"Motion clip {i + 1}/{total}")
    return clips
