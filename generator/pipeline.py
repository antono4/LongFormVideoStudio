"""End-to-end pipeline plus an in-memory job manager for the web UI."""

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import config, renderer, scriptwriter, tts, visuals


@dataclass
class Job:
    id: str
    topic: str
    target_seconds: int
    voice: str
    language: str
    tone: str
    style: str
    status: str = "queued"  # queued | running | done | error
    stage: str = "Queued"
    progress: int = 0
    title: str = ""
    script: dict = field(default_factory=dict)
    result: dict = field(default_factory=dict)
    error: str = ""
    created_at: float = field(default_factory=time.time)

    def to_dict(self, include_script: bool = True) -> dict:
        data = {
            "id": self.id,
            "topic": self.topic,
            "target_seconds": self.target_seconds,
            "voice": self.voice,
            "language": self.language,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "title": self.title,
            "error": self.error,
            "result": self.result,
        }
        if include_script:
            data["script"] = self.script
        return data


class JobManager:
    def __init__(self):
        self._jobs: dict = {}
        self._lock = threading.Lock()

    def create(self, **kwargs) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], **kwargs)
        with self._lock:
            self._jobs[job.id] = job
        thread = threading.Thread(target=self._run, args=(job,), daemon=True)
        thread.start()
        return job

    def get(self, job_id: str):
        return self._jobs.get(job_id)

    def list(self) -> list:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def _set(self, job: Job, stage: str, progress: int) -> None:
        job.stage = stage
        job.progress = progress

    def _run(self, job: Job) -> None:
        work_dir = config.TMP_DIR / job.id
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            job.status = "running"

            self._set(job, "Writing the script with AI...", 5)
            script = scriptwriter.generate_script(
                job.topic, job.target_seconds, job.language, job.tone, job.style,
            )
            job.script = script
            job.title = script["title"]
            scenes = script["scenes"]
            total = len(scenes)

            self._set(job, "Generating voiceover...", 15)
            for i, scene in enumerate(scenes):
                audio_path = work_dir / f"audio_{i}.wav"
                info = tts.synthesize(scene["text"], job.voice, audio_path)
                scene["audio"] = str(info["path"])
                scene["audio_duration"] = round(info["duration"], 2)
                scene["engine"] = info["engine"]
                self._set(job, f"Voiceover {i + 1}/{total}", 15 + int(20 * (i + 1) / total))

            self._set(job, "Creating scene images with AI...", 40)
            for i, scene in enumerate(scenes):
                image_path = work_dir / f"image_{i}.jpg"
                info = visuals.fetch_image(scene["visual"], image_path, seed=1000 + i)
                scene["image"] = str(info["path"])
                scene["image_source"] = info["source"]
                self._set(job, f"Image {i + 1}/{total}", 40 + int(35 * (i + 1) / total))

            self._set(job, "Rendering video with ffmpeg...", 78)

            def report(msg: str) -> None:
                self._set(job, msg, min(95, job.progress + 2))

            out_path = config.OUTPUT_DIR / f"{job.id}.mp4"
            result = renderer.render(scenes, work_dir, out_path, progress=report)
            result["download"] = f"/download/{job.id}"
            result["stream"] = f"/video/{job.id}"
            job.result = result

            self._set(job, "Done", 100)
            job.status = "done"
        except Exception as exc:
            job.status = "error"
            job.error = f"{exc}"
            job.stage = "Failed"
            traceback.print_exc()


manager = JobManager()
