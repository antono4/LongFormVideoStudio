"""Offline neural text-to-speech using Piper, with espeak-ng as a fallback."""

import shutil
import subprocess
import wave
from pathlib import Path

from . import config

_voice_cache: dict = {}


def _model_path(voice_key: str) -> Path:
    voice = config.VOICES.get(voice_key, config.VOICES[config.DEFAULT_VOICE])
    return config.MODELS_DIR / f"{voice['model']}.onnx"


def _load_voice(voice_key: str):
    if voice_key in _voice_cache:
        return _voice_cache[voice_key]
    from piper import PiperVoice

    path = _model_path(voice_key)
    if not path.exists():
        raise FileNotFoundError(f"voice model not found: {path}")
    voice = PiperVoice.load(str(path))
    _voice_cache[voice_key] = voice
    return voice


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def _synth_piper(text: str, voice_key: str, out_path: Path) -> bool:
    try:
        voice = _load_voice(voice_key)
        with wave.open(str(out_path), "wb") as wf:
            voice.synthesize_wav(text, wf)
        return out_path.exists() and out_path.stat().st_size > 1000
    except Exception:
        return False


def _synth_espeak(text: str, voice_key: str, out_path: Path) -> bool:
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    if not exe:
        return False
    lang = config.VOICES.get(voice_key, config.VOICES[config.DEFAULT_VOICE])["lang"]
    voice_arg = "id" if lang == "id" else "en-us"
    try:
        subprocess.run(
            [exe, "-v", voice_arg, "-s", "165", "-w", str(out_path), text],
            check=True, capture_output=True, timeout=120,
        )
        return out_path.exists() and out_path.stat().st_size > 1000
    except Exception:
        return False


def synthesize(text: str, voice_key: str, out_path: Path) -> dict:
    """Synthesize narration to a wav file. Returns {'path', 'duration', 'engine'}."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if _synth_piper(text, voice_key, out_path):
        engine = "piper"
    elif _synth_espeak(text, voice_key, out_path):
        engine = "espeak-ng"
    else:
        raise RuntimeError("no text-to-speech engine available")
    return {"path": out_path, "duration": _wav_duration(out_path), "engine": engine}


def available_voices() -> list:
    out = []
    for key, meta in config.VOICES.items():
        out.append({
            "key": key,
            "label": meta["label"],
            "lang": meta["lang"],
            "ready": _model_path(key).exists(),
        })
    return out
