#!/usr/bin/env bash
# Download the Piper voice models used by the generator.
set -e
cd "$(dirname "$0")/.."
mkdir -p models
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

fetch() { # $1 = relative path without extension
  local rel="$1" name
  name="$(basename "$rel")"
  for ext in onnx onnx.json; do
    if [ ! -f "models/${name}.${ext}" ]; then
      echo "Downloading ${name}.${ext}"
      curl -sSL -o "models/${name}.${ext}" "${BASE}/${rel}.${ext}"
    fi
  done
}

fetch "en/en_US/amy/medium/en_US-amy-medium"
fetch "en/en_US/lessac/medium/en_US-lessac-medium"
fetch "id/id_ID/news_tts/medium/id_ID-news_tts-medium"

echo "Voice models ready in ./models"
