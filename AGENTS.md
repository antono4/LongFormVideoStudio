# AGENTS.md

Repository memory for the Long-Form AI Video Studio.

## What this project is

A Flask app that turns a topic into a narrated, subtitled MP4 longer than 30
seconds. It uses free AI services and fully offline TTS/rendering.

## Layout

- `app.py` — Flask server, JSON API, honors `PORT`.
- `generator/` — pipeline modules: `config`, `scriptwriter`, `tts`, `visuals`,
  `renderer`, `pipeline`.
- `templates/index.html`, `static/` — single-page UI.
- `scripts/download_models.sh` — fetches Piper voice models into `models/`.
- `models/` — Piper `.onnx` + `.onnx.json` (gitignored, re-downloadable).
- `output/`, `tmp/` — generated artifacts (gitignored).

## Conventions

- Scripts return dicts with `text` + `visual` keys per scene; the pipeline adds
  `audio`, `audio_duration`, `image`, `image_source`.
- `visuals.fetch_image` must always return `{'path', 'source'}` and never raise.
- Keep the app runnable without API keys; treat paid endpoints as optional.

## Environment gotchas

- The sandbox blocks some AI domains via DNS (e.g. `models.inference.ai.azure.com`
  does not resolve, and `models.github.ai` is intercepted by a proxy that returns
  a fake `OK`). Do not rely on GitHub Models here.
- `text.pollinations.ai` only serves the free tier to the `openai-fast` model for
  anonymous callers; other models return HTTP 402. The free tier is rate-limited,
  so retry with backoff.
- `openai-fast` is a reasoning model: send `reasoning_effort: "low"` and read the
  answer from `message.content`, falling back to `message.reasoning`.
- Pollinations image API is frequently 402; the Wikimedia/Picsum/local fallbacks
  keep image generation working.
- Hugging Face ZeroGPU Spaces (FLUX, LLMs) share a per-IP quota (~90s); expect
  `ZeroGPU quota exceeded` after a couple of calls.

## Commands

```bash
./scripts/download_models.sh
pip install -r requirements.txt
PORT=8000 ./run.sh
```
