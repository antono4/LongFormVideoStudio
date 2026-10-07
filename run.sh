#!/usr/bin/env bash
# Start the Long-Form AI Video Generator.
set -e
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it first (e.g. sudo apt-get install -y ffmpeg)." >&2
  exit 1
fi

pip install -q -r requirements.txt

PORT="${PORT:-8000}"
echo "Starting server on http://0.0.0.0:${PORT}"
exec python3 app.py
