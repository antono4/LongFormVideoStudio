"""Turn a topic into a structured, scene-by-scene video script using a free LLM."""

import json
import re
import time
import urllib.parse

import requests

from . import config

WORDS_PER_SECOND = 2.4  # average narration pace used to size the script
MIN_SCENES = 4

LANGUAGE_NAMES = {
    "en": "English",
    "id": "Bahasa Indonesia",
}

SCHEMA_HINT = (
    'Schema: {"title": string, "scenes": [{"text": string, "visual": string}]}. '
    '"text" is the spoken narration for the scene. '
    '"visual" is a short ENGLISH text-to-image prompt describing the scene.'
)


def _scene_count(target_seconds: int) -> int:
    return max(MIN_SCENES, round(target_seconds / 8))


def _build_prompt(topic: str, target_seconds: int, language: str, tone: str) -> str:
    n = _scene_count(target_seconds)
    words_total = int(target_seconds * WORDS_PER_SECOND)
    words_scene = max(10, words_total // n)
    lang_name = LANGUAGE_NAMES.get(language, "English")
    return (
        "You are an expert short-documentary video scriptwriter. "
        "Return ONLY valid minified JSON, with no markdown and no commentary. "
        f"{SCHEMA_HINT} "
        f"Write a cohesive {target_seconds}-second video about: {topic!r}. "
        f"Tone: {tone}. "
        f"Produce EXACTLY {n} scenes. Each scene's narration must be about "
        f"{words_scene} words (roughly {words_scene / WORDS_PER_SECOND:.0f} seconds spoken). "
        "The narration must flow as one continuous story from the first scene to the last, "
        "with a clear introduction and a satisfying conclusion. "
        f"The narration MUST be written in {lang_name}. "
        "Every 'visual' field must be in English and describe a vivid, filmable image."
    )


def _balanced_object(text: str) -> str:
    """Return the first complete top-level {...} block, ignoring braces in strings."""
    start = text.find("{")
    if start == -1:
        raise ValueError("no JSON object found in model response")
    depth, in_string, escaped = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise ValueError("unbalanced JSON object in model response")


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    candidates = [text]
    try:
        candidates.append(_balanced_object(text))
    except ValueError:
        pass
    for candidate in candidates:
        for fixed in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
            try:
                return json.loads(fixed)
            except json.JSONDecodeError:
                continue
    raise ValueError("could not parse JSON from model response")


def _normalise(data: dict, topic: str, style: str) -> dict:
    title = str(data.get("title") or topic).strip()
    raw_scenes = data.get("scenes") or data.get("scene") or []
    if isinstance(raw_scenes, dict):
        raw_scenes = list(raw_scenes.values())
    scenes = []
    for item in raw_scenes:
        if not isinstance(item, dict):
            continue
        text = str(
            item.get("text") or item.get("narration") or item.get("script") or ""
        ).strip()
        visual = str(
            item.get("visual") or item.get("image") or item.get("prompt") or ""
        ).strip()
        if not text:
            continue
        scenes.append({"text": text, "visual": visual or f"cinematic shot about {topic}"})
    if not scenes:
        raise ValueError("model returned no usable scenes")
    for scene in scenes:
        scene["visual"] = f"{scene['visual']}, {style}, highly detailed, cinematic lighting, 16:9"
    return {"title": title, "scenes": scenes, "source": "ai"}


_BEATS_EN = [
    ("a hook that introduces the subject and grabs attention",
     "opening establishing shot that introduces the subject"),
    ("the essential background and why it matters",
     "wide contextual shot setting the scene"),
    ("a surprising detail most people never notice",
     "detailed close-up revealing the surprising detail"),
    ("a concrete example happening in real life",
     "documentary shot of the example in action"),
    ("the turning point that changes everything",
     "dramatic shot marking the turning point"),
    ("the wider consequences that ripple outward",
     "expansive shot showing the wider consequences"),
    ("what this means for the future",
     "forward-looking shot of the future"),
    ("a closing thought to remember",
     "cinematic closing shot fading to the horizon"),
]

_BEATS_ID = [
    ("pembuka yang memperkenalkan topik dan menarik perhatian",
     "opening establishing shot that introduces the subject"),
    ("latar belakang penting dan alasan topik ini berarti",
     "wide contextual shot setting the scene"),
    ("detail mengejutkan yang sering luput dari perhatian",
     "detailed close-up revealing the surprising detail"),
    ("contoh nyata yang benar-benar terjadi",
     "documentary shot of the example in action"),
    ("titik balik yang mengubah segalanya",
     "dramatic shot marking the turning point"),
    ("dampak yang menjalar lebih luas",
     "expansive shot showing the wider consequences"),
    ("makna semua ini bagi masa depan",
     "forward-looking shot of the future"),
    ("penutup yang layak untuk diingat",
     "cinematic closing shot fading to the horizon"),
]


def _fallback(topic: str, target_seconds: int, language: str, style: str) -> dict:
    """Offline-safe script so the pipeline never hard-fails."""
    n = _scene_count(target_seconds)
    beats = _BEATS_ID if language == "id" else _BEATS_EN
    scenes = []
    for i in range(n):
        narration, visual = beats[i % len(beats)]
        if language == "id":
            text = f"Bagian {i + 1}: {narration} dalam kisah tentang {topic}."
        else:
            text = f"Part {i + 1}: {narration} in the story of {topic}."
        scenes.append({
            "text": text,
            "visual": f"{visual} about {topic}, {style}, highly detailed, 16:9",
        })
    return {"title": topic, "scenes": scenes, "source": "fallback"}


def _post_chat(prompt: str, model: str) -> str:
    """Call the OpenAI-compatible endpoint (reliable for long prompts)."""
    resp = requests.post(
        config.TEXT_API + "openai",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
            "max_tokens": 4000,
            "reasoning_effort": "low",
        },
        timeout=config.HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    payload = resp.json()
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not choices:
        raise ValueError(f"unexpected response shape: {str(payload)[:120]}")
    message = choices[0].get("message") or {}
    # Reasoning models may put the answer in either field.
    text = (message.get("content") or "").strip()
    if not text:
        text = (message.get("reasoning") or "").strip()
    if not text:
        raise ValueError("model returned empty content")
    return text


def _get_completion(prompt: str, model: str) -> str:
    """Fallback: simple GET endpoint."""
    url = config.TEXT_API + urllib.parse.quote(prompt) + f"?model={model}"
    resp = requests.get(url, timeout=config.HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.text


def generate_script(topic: str, target_seconds: int, language: str = "en",
                    tone: str = "engaging and informative", style: str = "cinematic") -> dict:
    """Return {'title', 'scenes': [{'text','visual'}], 'source'}."""
    prompt = _build_prompt(topic, target_seconds, language, tone)
    models = [config.TEXT_MODEL, "openai"]
    last_error = None
    for attempt in range(6):
        for model in models:
            fetch = _post_chat if attempt % 2 == 0 else _get_completion
            try:
                raw = fetch(prompt, model)
                return _normalise(_extract_json(raw), topic, style)
            except Exception as exc:  # network, parsing, or validation issue
                last_error = exc
        time.sleep(3.0 * (attempt + 1))
    result = _fallback(topic, target_seconds, language, style)
    result["error"] = str(last_error)
    return result


def estimated_scene_count(target_seconds: int) -> int:
    return _scene_count(target_seconds)
