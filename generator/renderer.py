"""Render scenes into a single MP4 with ffmpeg (Ken Burns motion + subtitles)."""

import shutil
import subprocess
import textwrap
import wave
from pathlib import Path

from . import config

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SUBTITLE_WIDTH = 58
MAX_LINES = 3


def _run(cmd: list) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-1500:]
        raise RuntimeError(f"ffmpeg failed:\n{' '.join(cmd[:6])}...\n{tail}")


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def _write_subtitle(text: str, path: Path) -> None:
    lines = textwrap.wrap(text, width=SUBTITLE_WIDTH)[:MAX_LINES]
    path.write_text("\n".join(lines), encoding="utf-8")


def _zoompan_filter(frames: int, zoom_in: bool) -> str:
    rate = 0.20 / max(1, frames)
    if zoom_in:
        z = f"min(zoom+{rate:.6f},1.20)"
    else:
        z = f"if(lte(zoom,1.0),1.20,max(1.001,zoom-{rate:.6f}))"
    return (
        f"scale={config.WIDTH * 2}:{config.HEIGHT * 2}"
        f":force_original_aspect_ratio=increase,"
        f"crop={config.WIDTH * 2}:{config.HEIGHT * 2},"
        f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":d={frames}:s={config.WIDTH}x{config.HEIGHT}:fps={config.FPS}"
    )


def _subtitle_filter(textfile: Path) -> str:
    return (
        f"drawtext=fontfile={FONT}:textfile={textfile}"
        f":fontcolor=white:fontsize=30:line_spacing=8"
        f":box=1:boxcolor=black@0.45:boxborderw=14"
        f":x=(w-text_w)/2:y=h-th-60"
    )


def _encode_args() -> list:
    return [
        "-r", str(config.FPS),
        "-c:v", "libx264", "-preset", config.PRESET, "-crf", str(config.CRF),
        "-pix_fmt", "yuv420p", "-an",
    ]


def _render_segment(image: Path, textfile: Path, duration: float, frames: int,
                    zoom_in: bool, out_path: Path) -> None:
    vf = f"{_zoompan_filter(frames, zoom_in)},{_subtitle_filter(textfile)}"
    _run([
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", str(config.FPS), "-i", str(image),
        "-vf", vf,
        "-t", f"{duration:.3f}",
        *_encode_args(),
        str(out_path),
    ])


def _render_clip_segment(clip: Path, textfile: Path, duration: float,
                         out_path: Path) -> None:
    """Use an AI-generated motion clip, looped/trimmed to the scene duration."""
    vf = (
        f"scale={config.WIDTH}:{config.HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={config.WIDTH}:{config.HEIGHT},setsar=1,"
        f"{_subtitle_filter(textfile)}"
    )
    _run([
        "ffmpeg", "-y",
        "-stream_loop", "-1", "-i", str(clip),
        "-t", f"{duration:.3f}",
        "-vf", vf,
        *_encode_args(),
        str(out_path),
    ])


def _concat_video(segments: list, out_path: Path, work_dir: Path) -> None:
    list_file = work_dir / "video_concat.txt"
    list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in segments))
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", str(out_path),
    ])


def _build_audio(scene_audio: list, durations: list, out_path: Path) -> None:
    """Concatenate narration clips, padding each to its scene duration."""
    first = wave.open(str(scene_audio[0]), "rb")
    params = first.getparams()
    first.close()
    with wave.open(str(out_path), "wb") as out:
        out.setparams(params)
        for wav_path, duration in zip(scene_audio, durations):
            with wave.open(str(wav_path), "rb") as wf:
                frames = wf.readframes(wf.getnframes())
                out.writeframes(frames)
                target = int(duration * wf.getframerate())
                pad = target - wf.getnframes()
                if pad > 0:
                    out.writeframes(b"\x00" * pad * wf.getsampwidth() * wf.getnchannels())


def render(scenes: list, work_dir: Path, out_path: Path, progress=None) -> dict:
    """scenes: list of {'text','visual','image','audio','audio_duration'}."""
    work_dir.mkdir(parents=True, exist_ok=True)
    durations, segments, scene_audio = [], [], []

    total = len(scenes)
    for i, scene in enumerate(scenes):
        narr_dur = _wav_duration(Path(scene["audio"]))
        duration = narr_dur + config.SCENE_PAD_SECONDS
        frames = max(1, round(duration * config.FPS))
        textfile = work_dir / f"sub_{i}.txt"
        _write_subtitle(scene["text"], textfile)
        seg = work_dir / f"seg_{i}.mp4"
        clip = scene.get("clip")
        if clip and Path(clip).exists():
            _render_clip_segment(Path(clip), textfile, duration, seg)
        else:
            _render_segment(Path(scene["image"]), textfile, duration, frames,
                            zoom_in=(i % 2 == 0), out_path=seg)
        durations.append(duration)
        segments.append(seg)
        scene_audio.append(Path(scene["audio"]))
        if progress:
            progress(f"Rendered scene {i + 1}/{total}")

    if progress:
        progress("Combining scenes...")
    video_full = work_dir / "video_full.mp4"
    _concat_video(segments, video_full, work_dir)

    audio_full = work_dir / "audio_full.wav"
    _build_audio(scene_audio, durations, audio_full)

    if progress:
        progress("Muxing audio and video...")
    _run([
        "ffmpeg", "-y", "-i", str(video_full), "-i", str(audio_full),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        "-shortest", str(out_path),
    ])

    total_duration = sum(durations)
    return {
        "path": str(out_path),
        "duration": round(total_duration, 2),
        "size": out_path.stat().st_size if out_path.exists() else 0,
        "scene_durations": [round(d, 2) for d in durations],
    }


def is_available() -> bool:
    return shutil.which("ffmpeg") is not None
