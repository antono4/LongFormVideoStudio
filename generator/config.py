"""Central configuration: paths, voice catalog, and render defaults."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
OUTPUT_DIR = BASE_DIR / "output"
TMP_DIR = BASE_DIR / "tmp"

OUTPUT_DIR.mkdir(exist_ok=True)
TMP_DIR.mkdir(exist_ok=True)

# --- Video render defaults -------------------------------------------------
FPS = 25
WIDTH = 1280
HEIGHT = 720
CRF = 23
PRESET = "veryfast"
SCENE_PAD_SECONDS = 0.7  # breathing room after each scene's narration

# --- Voice catalog (Piper, fully offline) ----------------------------------
# name -> onnx file stem, language code, human label
VOICES = {
    "en_male": {
        "model": "en_US-lessac-medium",
        "lang": "en",
        "label": "English - Male (Lessac)",
    },
    "en_female": {
        "model": "en_US-amy-medium",
        "lang": "en",
        "label": "English - Female (Amy)",
    },
    "id_female": {
        "model": "id_ID-news_tts-medium",
        "lang": "id",
        "label": "Bahasa Indonesia - Female (News)",
    },
}
DEFAULT_VOICE = "en_female"

# --- Free AI services (no API key required) --------------------------------
TEXT_API = "https://text.pollinations.ai/"
IMAGE_API = "https://image.pollinations.ai/prompt/"
TEXT_MODEL = os.environ.get("SCRIPT_MODEL", "openai-fast")
HTTP_TIMEOUT = 120
IMAGE_RETRIES = 3

# Optional: a Hugging Face token unlocks extra free ZeroGPU quota for the
# FLUX image fallback. Everything works without it.
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")

WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
