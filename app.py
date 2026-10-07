"""Flask web server for the Long-Form AI Video Generator."""

import shutil

from flask import (
    Flask, abort, jsonify, render_template, request, send_file,
)

from generator import config, renderer, tts
from generator.pipeline import manager

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024

MIN_SECONDS = 30
MAX_SECONDS = 600


@app.route("/")
def index():
    return render_template(
        "index.html",
        voices=tts.available_voices(),
        default_voice=config.DEFAULT_VOICE,
        min_seconds=MIN_SECONDS,
        max_seconds=MAX_SECONDS,
        ffmpeg_ok=renderer.is_available(),
    )


@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "ffmpeg": renderer.is_available(),
        "voices": tts.available_voices(),
    })


@app.route("/api/generate", methods=["POST"])
def generate():
    if not renderer.is_available():
        return jsonify({"error": "ffmpeg is not installed on the server"}), 503

    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "").strip()
    if not topic:
        return jsonify({"error": "Please enter a topic."}), 400

    try:
        target_seconds = int(data.get("duration", 60))
    except (TypeError, ValueError):
        return jsonify({"error": "Duration must be a number."}), 400
    if not MIN_SECONDS <= target_seconds <= MAX_SECONDS:
        return jsonify({
            "error": f"Duration must be between {MIN_SECONDS} and {MAX_SECONDS} seconds."
        }), 400

    voice = data.get("voice", config.DEFAULT_VOICE)
    if voice not in config.VOICES:
        voice = config.DEFAULT_VOICE
    language = config.VOICES[voice]["lang"]

    job = manager.create(
        topic=topic,
        target_seconds=target_seconds,
        voice=voice,
        language=language,
        tone=(data.get("tone") or "engaging and informative").strip(),
        style=(data.get("style") or "cinematic").strip(),
    )
    return jsonify(job.to_dict()), 202


@app.route("/api/jobs")
def list_jobs():
    return jsonify([j.to_dict(include_script=False) for j in manager.list()])


@app.route("/api/jobs/<job_id>")
def job_status(job_id):
    job = manager.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job.to_dict())


@app.route("/video/<job_id>")
def stream_video(job_id):
    job = manager.get(job_id)
    if not job or job.status != "done":
        abort(404)
    path = config.OUTPUT_DIR / f"{job_id}.mp4"
    if not path.exists():
        abort(404)
    return send_file(path, mimetype="video/mp4", conditional=True)


@app.route("/download/<job_id>")
def download_video(job_id):
    job = manager.get(job_id)
    if not job or job.status != "done":
        abort(404)
    path = config.OUTPUT_DIR / f"{job_id}.mp4"
    if not path.exists():
        abort(404)
    safe_title = "".join(c for c in job.title if c.isalnum() or c in " -_")[:60].strip() or "video"
    return send_file(path, as_attachment=True, download_name=f"{safe_title}.mp4")


if __name__ == "__main__":
    import os

    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, threaded=True)
