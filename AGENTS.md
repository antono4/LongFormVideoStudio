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
- `docs/` — the GitHub Pages build: a 100% client-side version of the same UI
  (no backend). `studio.js` runs the pipeline in the browser, `worker.js` fetches
  scene images off-thread, `tts-worker.js` runs eSpeak-NG WASM one-shot per
  utterance, `vendor/` holds the WASM bundle.

## Client memory limits (why Chrome used to crash)

- eSpeak-NG's wasm instance cannot be reused: `main` only writes `out.wav` on
  the first call, and `noExitRuntime` keeps the whole ~18 MB runtime resident.
  So `tts-worker.js` is a throwaway worker: create → synthesize → terminate.
  Never cache an eSpeak instance across utterances; memory then stays flat
  (~10 MB) no matter how long the video.
- `docs/studio.js` keeps history metadata in the `videos` store and blobs in a
  separate `blobs` store (`lfvs` DB v2), capped at `HISTORY_LIMIT`. Blobs are
  read on demand only when a history card is clicked — never bulk-loaded.
- `docs/worker.js` bounds every decoded bitmap to 1280 px on its long side.
  Wikimedia can return tall/wide photos whose raw bitmaps are ~20 MB each, and a
  50-scene video would otherwise pin hundreds of MB.
- Worker URLs carry a `?v=` cache-buster (`WORKER_VERSION` in `studio.js`); bump
  it whenever a worker's code changes so open tabs do not reuse stale copies.

## GitHub Pages

- Published at https://antono4.github.io/LongFormVideoStudio/ .
- Pages serves the repo root of `main`, so the root `index.html` redirects to
  `docs/`. The `/docs` path 404s if Pages is not pointed at `/docs`; the
  redirect keeps the app reachable either way.
- `.nojekyll` disables Jekyll so the wasm and other assets are served verbatim.
- Keep all asset URLs relative (`./worker.js`, `./vendor/`) so the app works
  from the `/LongFormVideoStudio/docs/` subpath.
- The client-side UI mirrors the server UI, including a "Recent videos" section
  backed by IndexedDB (browsers have no server-side history).
- The root `main` branch also contains the Flask app and its assets, so a Pages
  build publishes the whole tree. Large files make the build slow; give it a
  couple of minutes after a push.

## AI motion clips (LTX-Video)

- `motion=ai` animates each scene with `Lightricks/ltx-video-distilled` on HF
  Spaces instead of a Ken Burns pan. `kenburns` (default) stays the fast path.
- The Space is Gradio, not REST: `POST /gradio_api/upload` (multipart, field
  `files`) -> `POST /gradio_api/queue/join` with `{data, fn_index, session_hash}`
  -> read `GET /gradio_api/queue/data?session_hash=...` (SSE) until
  `msg: "process_completed"`. The `call/<name>` shortcut returns
  `event: error data: null`; use the queue API.
- `fn_index` comes from `GET /config` (`dependencies[].api_name`); it can shift
  when the Space is rebuilt, so resolve it at runtime rather than hardcoding.
- Result files are only reachable through `/gradio_api/file=<path>` (raw
  `/tmp/gradio/...` returns 403). That URL sends CORS headers, so the browser can
  draw the clip into a canvas without tainting it.
- Anonymous ZeroGPU quota is tiny and per-IP; a Hugging Face token raises it a
  lot. The client exposes an optional token field (`?hftoken=` also works) and
  the server reads `HF_TOKEN`/`HUGGINGFACE_TOKEN`.
- Never let AI-video failure break generation: a failed clip falls back to the
  still image, and the client stops trying after the first failure.

## Conventions

- Scripts return dicts with `text` + `visual` keys per scene; the pipeline adds
  `audio`, `audio_duration`, `image`, `image_source`, and optionally
  `clip` + `clip_source`.
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
