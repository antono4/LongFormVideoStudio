# Long-Form AI Video Studio

Turn a topic into a narrated, subtitled video **longer than 30 seconds** — fully
automatic and with no API keys required.

The app writes the script with a free LLM, narrates it with offline neural
text-to-speech, sources a relevant image for every scene, and renders everything
into a single MP4 with ffmpeg (Ken Burns motion + burned-in subtitles).

## Features

- AI-written, scene-by-scene script in English or Bahasa Indonesia.
- Offline neural voiceover with Piper (natural voices, no internet needed).
- A provider chain for scene visuals that always returns an image:
  1. Pollinations image API
  2. Hugging Face FLUX.1-schnell Space (optional, higher quality)
  3. Wikimedia Commons (real, keyword-relevant photos)
  4. Picsum stock photos
  5. A locally drawn stylised card (never fails)
- 720p H.264 render with slow zoom and subtitles.
- Web UI with live progress, in-browser preview, download, and job history.

## Requirements

- Python 3.9+
- `ffmpeg` on the PATH (`sudo apt-get install -y ffmpeg`)
- `espeak-ng` is used only as a TTS fallback (`sudo apt-get install -y espeak-ng`)

## Quick start

```bash
./scripts/download_models.sh   # fetch the Piper voice models (~60 MB)
pip install -r requirements.txt
./run.sh                       # serves on http://localhost:8000
```

Then open the URL, type a topic, pick a duration of 30 seconds or more, and
press **Generate video**.

## How it works

| Stage | Module | What happens |
|-------|--------|--------------|
| Script | `generator/scriptwriter.py` | Calls a free LLM, asks for strict JSON, and normalises the scenes. Falls back to a safe offline script if the API is unavailable. |
| Voiceover | `generator/tts.py` | Piper synthesises each scene to WAV; espeak-ng is the fallback engine. |
| Visuals | `generator/visuals.py` | Walks the provider chain above and crops each result to 16:9. |
| Render | `generator/renderer.py` | Builds one segment per scene (zoompan + drawtext), concatenates, then muxes the padded narration track. |
| Orchestration | `generator/pipeline.py` | Runs the stages in a background thread and reports progress. |
| Web | `app.py` + `templates/` + `static/` | Flask JSON API and the single-page UI. |

## Configuration

Environment variables:

- `PORT` — server port (default `8000`).
- `SCRIPT_MODEL` — Pollinations text model (default `openai-fast`).
- `HF_TOKEN` — optional Hugging Face token; unlocks extra free ZeroGPU quota
  for the FLUX image fallback.

## Notes

- The free text endpoint is rate-limited; the scriptwriter retries across
  several models and always produces a usable script.
- The HF FLUX provider is best-effort: the shared free GPU quota is per IP, so
  the app degrades gracefully to Wikimedia/Picsum/local cards.
