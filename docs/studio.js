// Long-Form Video Studio — fully client-side build.
// GitHub Pages can only serve static files, so the whole pipeline runs in the
// browser: a free LLM writes the script, eSpeak-NG (WASM) narrates it, images
// are fetched from free APIs, and canvas + MediaRecorder render the MP4/WebM.

const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

const styleEl = document.getElementById("bg-style") || document.createElement("style");

const WEBCAM_GRADIENTS = [
  ["#1b2a4a", "#0b1120"],
  ["#2a1b4a", "#0b1120"],
  ["#123a34", "#0b1120"],
  ["#3a2412", "#0b1120"],
  ["#3a1230", "#0b1120"],
];

const state = {
  worker: null,
  pending: new Map(),
  nextReqId: 1,
  audioCtx: null,
  lastBlob: null,
  lastUrl: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

// --- Worker bridge ---------------------------------------------------------

function getWorker() {
  if (!state.worker) {
    state.worker = new Worker("./worker.js", { type: "module" });
    state.worker.onmessage = (event) => {
      const { id, ok, error } = event.data;
      const entry = state.pending.get(id);
      if (!entry) return;
      state.pending.delete(id);
      if (ok) {
        const { wav, image } = event.data;
        entry.resolve(wav !== undefined ? wav : image);
      } else {
        entry.reject(new Error(error));
      }
    };
    state.worker.onerror = (event) => {
      for (const [, entry] of state.pending) entry.reject(new Error(event.message || "worker error"));
      state.pending.clear();
    };
  }
  return state.worker;
}

function workerCall(payload) {
  const id = state.nextReqId++;
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload });
  });
}

const synthWav = (text, voice, rate, pitch) =>
  workerCall({ type: "tts", text, voice, rate, pitch });

const fetchImage = (url) => workerCall({ type: "image", url });

// --- Voice catalog ---------------------------------------------------------

const VOICES = {
  en_female: { voice: "en-us+f3", lang: "en", rate: 165, pitch: 60, label: "English – Female" },
  en_male: { voice: "en-us+m3", lang: "en", rate: 158, pitch: 38, label: "English – Male" },
  id_female: { voice: "id+f3", lang: "id", rate: 160, pitch: 60, label: "Bahasa Indonesia – Female" },
  id_male: { voice: "id+m3", lang: "id", rate: 158, pitch: 38, label: "Bahasa Indonesia – Male" },
};

const WORDS_PER_SECOND = 2.4;
const SCENE_PAD_SECONDS = 0.6;
const MIN_SECONDS = 30;
const MAX_SECONDS = 600;

// --- Fetch with timeout ----------------------------------------------------

async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Text helpers ----------------------------------------------------------

function estimateSeconds(text) {
  return text.trim().split(/\s+/).length / WORDS_PER_SECOND;
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkText(text, maxWords) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];
  let count = 0;
  const flush = () => {
    if (current.length) chunks.push(current.join(" "));
    current = [];
    count = 0;
  };
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length;
    if (count && count + words > maxWords) flush();
    if (words > maxWords * 1.6) {
      const parts = sentence.split(/\s+/);
      for (let i = 0; i < parts.length; i += maxWords) {
        const piece = parts.slice(i, i + maxWords).join(" ");
        if (piece) chunks.push(piece);
      }
      continue;
    }
    current.push(sentence);
    count += words;
  }
  flush();
  return chunks.length ? chunks : [text];
}

// --- Script generation -----------------------------------------------------

function buildPrompt(topic, seconds, language, tone, style) {
  const words = Math.round(seconds * WORDS_PER_SECOND);
  const scenes = Math.max(4, Math.round(seconds / 8));
  const perScene = Math.max(10, Math.round(words / scenes));
  const langName = language === "id" ? "Bahasa Indonesia" : "English";
  return (
    "You are an expert short-documentary video scriptwriter. " +
    "Return ONLY valid minified JSON, with no markdown and no commentary. " +
    'Schema: {"title": string, "scenes": [{"text": string, "visual": string}]}. ' +
    '"text" is the spoken narration for the scene. ' +
    '"visual" is a short ENGLISH text-to-image prompt describing the scene. ' +
    `Write a cohesive ${seconds}-second video about: ${JSON.stringify(topic)}. ` +
    `Tone: ${tone}. Visual style: ${style}. ` +
    `Produce EXACTLY ${scenes} scenes. Each scene's narration must be about ${perScene} words. ` +
    "The narration must flow as one continuous story from first scene to last, " +
    "with a clear introduction and a satisfying conclusion. " +
    `The narration MUST be written in ${langName}. ` +
    "Every 'visual' field must be in English and describe a vivid, filmable image."
  );
}

function balancedJson(text) {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON in model response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unterminated JSON in model response");
}

function normaliseScript(raw, topic, style) {
  let data = raw;
  if (typeof data === "string") {
    let text = data.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
    data = JSON.parse(balancedJson(text));
  }
  const list = data.scenes || data.scene || data.shots || data.segments;
  const scenes = [];
  for (const item of list || []) {
    const text = (item.text || item.narration || item.voiceover || item.content || "").trim();
    const visual = (item.visual || item.image || item.prompt || item.description || item.text || "").trim();
    if (text) scenes.push({ text, visual: visual || text });
  }
  if (!scenes.length) throw new Error("model returned no usable scenes");
  return { title: (data.title || topic).trim(), scenes, source: "ai" };
}

// Offline narration pools. Each beat pairs a line of a coherent arc with an
// English text-to-image prompt. Used when the AI text service is unavailable.
const BEATS_EN = [
  ["Let's take a closer look at {t} and why it deserves your attention.", "cinematic establishing shot introducing {t}"],
  ["At first glance, {t} may seem simple, but the details tell a much richer story.", "wide contextual shot of {t}"],
  ["To understand {t}, we have to start with the context that shaped it.", "documentary shot showing the context of {t}"],
  ["Researchers have long debated what {t} really means for us today.", "detailed shot of research about {t}"],
  ["There is one detail about {t} that most people completely overlook.", "close-up revealing a hidden detail of {t}"],
  ["When you slow down and examine it, that detail changes everything.", "dramatic close-up of {t}"],
  ["Consider a real example: {t} quietly reshaping everyday decisions.", "documentary shot of {t} in everyday life"],
  ["That example reveals a pattern that repeats far more often than we expect.", "wide shot showing a repeating pattern of {t}"],
  ["Then comes the turning point, the moment {t} stops being background noise.", "dramatic shot marking a turning point for {t}"],
  ["From there, the consequences ripple outward, touching people and places we rarely consider.", "expansive shot of the wider consequences of {t}"],
  ["Looking ahead, {t} will likely shape the choices of the next generation.", "forward-looking shot of the future of {t}"],
  ["So the next time you encounter {t}, remember how much is really going on beneath the surface.", "cinematic closing shot of {t} fading to the horizon"],
];

const BEATS_ID = [
  ["Mari kita telusuri lebih dekat tentang {t} dan alasan hal ini layak diperhatikan.", "cinematic establishing shot introducing {t}"],
  ["Sekilas, {t} tampak sederhana, tetapi detailnya menyimpan cerita yang jauh lebih kaya.", "wide contextual shot of {t}"],
  ["Untuk memahami {t}, kita perlu mulai dari konteks yang membentuknya.", "documentary shot showing the context of {t}"],
  ["Para peneliti telah lama memperdebatkan arti {t} bagi kita hari ini.", "detailed shot of research about {t}"],
  ["Ada satu detail tentang {t} yang sering luput dari perhatian banyak orang.", "close-up revealing a hidden detail of {t}"],
  ["Ketika kita meluangkan waktu untuk mencermatinya, detail itu mengubah segalanya.", "dramatic close-up of {t}"],
  ["Ambil contoh nyata: {t} hadir dalam kehidupan sehari-hari dan diam-diam mengubah keputusan.", "documentary shot of {t} in everyday life"],
  ["Contoh itu mengungkap pola yang jauh lebih sering terjadi daripada yang kita duga.", "wide shot showing a repeating pattern of {t}"],
  ["Lalu tibalah titik balik, saat {t} berhenti menjadi sekadar latar belakang.", "dramatic shot marking a turning point for {t}"],
  ["Sejak itu, dampaknya menjalar ke luar, menyentuh orang dan tempat yang jarang kita pikirkan.", "expansive shot of the wider consequences of {t}"],
  ["Ke depan, {t} kemungkinan besar akan membentuk pilihan generasi berikutnya.", "forward-looking shot of the future of {t}"],
  ["Jadi, saat Anda menjumpai {t} lagi, ingatlah betapa banyak hal terjadi di balik permukaannya.", "cinematic closing shot of {t} fading to the horizon"],
];

function fallbackScript(topic, seconds, language, style) {
  const pool = language === "id" ? BEATS_ID : BEATS_EN;
  const n = Math.max(4, Math.round(seconds / 8));
  const targetWords = Math.max(80, Math.round(seconds * WORDS_PER_SECOND));
  const perScene = Math.max(12, Math.round(targetWords / n));
  const scenes = [];
  let idx = 0;
  for (let s = 0; s < n; s++) {
    const sentences = [];
    let words = 0;
    let guard = 0;
    while (words < perScene && guard < 12) {
      const text = pool[idx % pool.length][0].replace(/\{t\}/g, topic);
      sentences.push(text);
      words += text.split(/\s+/).length;
      idx++;
      guard++;
    }
    const visual = pool[(idx - 1 + pool.length) % pool.length][1].replace(/\{t\}/g, topic);
    scenes.push({ text: sentences.join(" "), visual: `${visual}, ${style}, highly detailed, 16:9` });
  }
  return { title: topic, scenes, source: "offline" };
}

async function generateScript(topic, seconds, language, tone, style) {
  const prompt = buildPrompt(topic, seconds, language, tone, style);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout("https://text.pollinations.ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai-fast",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 4000,
          reasoning_effort: "low",
        }),
      }, 12000);
      if (!res.ok) throw new Error(`text http ${res.status}`);
      const data = await res.json();
      const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const content = message.content || message.reasoning || "";
      if (!String(content).trim()) throw new Error("empty completion");
      return normaliseScript(content, topic, style);
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const result = fallbackScript(topic, seconds, language, style);
  result.error = lastError;
  return result;
}

// --- Scene images ----------------------------------------------------------

function wikimediaQuery(text) {
  const stop = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "for", "with", "that", "this", "are", "is", "as", "by", "at"]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w))
    .slice(0, 5)
    .join(" ");
}

async function wikimediaImage(prompt) {
  const query = wikimediaQuery(prompt);
  if (!query) throw new Error("empty query");
  const url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
    "&generator=search&gsrnamespace=6&gsrsearch=" + encodeURIComponent(`filetype:bitmap ${query}`) +
    "&gsrlimit=6&prop=imageinfo&iiprop=url&iiurlwidth=1280";
  const res = await fetchWithTimeout(url, {}, 15000);
  if (!res.ok) throw new Error(`commons http ${res.status}`);
  const data = await res.json();
  const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
  for (const page of pages) {
    const info = page.imageinfo && page.imageinfo[0];
    if (info && info.thumburl) return info.thumburl;
  }
  throw new Error("no commons result");
}

async function sceneImage(prompt, seed) {
  const encoded = encodeURIComponent(prompt);
  const candidates = [
    ["pollinations", `https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&model=flux&seed=${seed}`],
    ["wikimedia", () => wikimediaImage(prompt)],
    ["picsum", `https://picsum.photos/seed/${seed}/1280/720`],
  ];
  let lastError = "";
  for (const [source, target] of candidates) {
    for (let attempt = 0; attempt < (source === "pollinations" ? 2 : 1); attempt++) {
      try {
        const url = typeof target === "function" ? await target() : target;
        const bitmap = await fetchImage(url);
        return { bitmap, source };
      } catch (err) {
        lastError = String((err && err.message) || err);
      }
    }
  }
  return { bitmap: null, source: "generated", error: lastError };
}

// --- Canvas helpers --------------------------------------------------------

function coverDraw(ctx, image, t, duration, index) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const progress = duration > 0 ? Math.min(1, t / duration) : 0;
  const zoom = 1.06 + 0.14 * progress;
  const pan = Math.sin(index * 1.7) * 0.03;
  const scale = Math.max(W / (image.width || W), H / (image.height || H)) * zoom;
  const dw = (image.width || W) * scale;
  const dh = (image.height || H) * scale;
  const dx = (W - dw) / 2 + pan * W * progress;
  const dy = (H - dh) / 2;
  ctx.drawImage(image, dx, dy, dw, dh);
}

function drawFallback(ctx, index) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const [a, b] = WEBCAM_GRADIENTS[index % WEBCAM_GRADIENTS.length];
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#6d8bff";
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc((index * 97 + i * 211) % W, (index * 53 + i * 137) % H, 40 + (i % 3) * 30, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

function drawSubtitle(ctx, lines) {
  if (!lines || !lines.length) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.font = "600 34px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = 46;
  const blockHeight = lines.length * lineHeight + 28;
  const top = H - blockHeight - 52;
  let maxWidth = 0;
  for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  const boxWidth = Math.min(W - 80, maxWidth + 48);
  const x = (W - boxWidth) / 2;
  const radius = 14;
  ctx.beginPath();
  ctx.roundRect(x, top, boxWidth, blockHeight, radius);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, top + 14 + lineHeight * (i + 0.5));
  });
}

function drawFrame(ctx, segment, allSegments, t, duration, index) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, W, H);
  if (segment.bitmap) coverDraw(ctx, segment.bitmap, t, duration, index);
  else drawFallback(ctx, index);

  const grad = ctx.createLinearGradient(0, H * 0.55, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);

  const absolute = segment.start + Math.min(t, duration);
  const lines = [];
  ctx.font = "600 34px Inter, system-ui, sans-serif";
  for (const other of allSegments) {
    if (absolute < other.start) break;
    if (absolute <= other.start + other.duration + 0.05) {
      const wrapped = wrapLines(ctx, other.text, W - 160, 3);
      lines.push(...wrapped);
      if (lines.length >= 3) lines.length = 3;
      break;
    }
  }
  drawSubtitle(ctx, lines);
}

// --- Audio decode ----------------------------------------------------------

function resampleTo(audioBuffer, targetRate) {
  if (audioBuffer.sampleRate === targetRate) return audioBuffer;
  const length = Math.ceil((audioBuffer.duration * targetRate));
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, length, targetRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

// --- Video render ----------------------------------------------------------

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of WEBM_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

async function renderVideo(segments, ctxAudio, mime, onProgress, audioCtx) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const fps = 30;
  const total = segments.reduce((sum, s) => sum + s.duration, 0);

  const stream = canvas.captureStream(fps);

  // Reuse the context that was unlocked by the user gesture. A freshly created
  // AudioContext can stay suspended under autoplay policies, which would freeze
  // the clock and stall the render.
  let hasAudio = true;
  if (audioCtx.state !== "running") {
    await Promise.race([
      audioCtx.resume().catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    hasAudio = audioCtx.state === "running";
  }
  let dest = null;
  if (hasAudio) {
    dest = audioCtx.createMediaStreamDestination();
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  // Prefer the audio clock (keeps picture in sync with sound) but fall back to
  // the wall clock so the render always finishes even if audio is blocked.
  const audioStart = audioCtx.currentTime + 0.15;
  const wallStart = performance.now();
  const elapsedNow = () =>
    hasAudio ? Math.max(0, audioCtx.currentTime - audioStart) : (performance.now() - wallStart) / 1000;

  if (hasAudio) {
    let cursor = audioStart;
    for (const segment of segments) {
      if (ctxAudio.has(segment.index)) {
        const source = audioCtx.createBufferSource();
        source.buffer = ctxAudio.get(segment.index);
        source.connect(dest);
        source.start(cursor);
      }
      cursor += segment.duration;
    }
  }

  recorder.start(1000);
  debugLog(`render start total=${total.toFixed(1)}s audio=${hasAudio ? "on" : "off"} state=${audioCtx.state}`);
  const frameMs = 1000 / fps;
  let ticks = 0;
  let lastLog = -1;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // Watchdog: never hang the UI if the audio clock or timers stall.
    const watchdog = setInterval(() => {
      if (elapsedNow() >= total || performance.now() - wallStart > (total + 20) * 1000) finish();
    }, 500);
    const tick = () => {
      try {
        const elapsed = elapsedNow();
        let acc = 0;
        let active = segments[segments.length - 1];
        let local = elapsed;
        for (const segment of segments) {
          if (elapsed <= acc + segment.duration) { active = segment; local = elapsed - acc; break; }
          acc += segment.duration;
        }
        drawFrame(ctx, active, segments, local, active.duration, active.index);
        ticks++;
        const pct = Math.min(99, Math.round((elapsed / total) * 100));
        onProgress(pct);
        const sec = Math.floor(elapsed);
        if (sec !== lastLog) {
          lastLog = sec;
          debugLog(`render ${sec}/${Math.round(total)}s ticks=${ticks} state=${audioCtx.state}`);
        }
        if (elapsed >= total) { clearInterval(watchdog); finish(); return; }
      } catch (err) {
        debugLog(`render frame error: ${err.message}`);
      }
      setTimeout(tick, frameMs);
    };
    tick();
  });

  await new Promise((r) => setTimeout(r, 500));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  return new Blob(chunks, { type: mime.split(";")[0] });
}

// --- Orchestration ---------------------------------------------------------

function debugLog(message) {
  const box = $("debug");
  if (!box) return;
  const line = `[${((performance.now() / 1000).toFixed(1))}s] ${message}`;
  box.textContent += line + "\n";
  box.scrollTop = box.scrollHeight;
}

let lastStage = "";
function setStage(stage, progress) {
  $("stage").textContent = stage;
  $("bar-fill").style.width = progress + "%";
  $("pct").textContent = progress + "%";
  if (stage !== lastStage) { lastStage = stage; debugLog(`stage: ${stage}`); }
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

async function buildVideo(topic, targetSeconds, voiceKey, tone, style, language) {
  const spec = VOICES[voiceKey] || VOICES.en_female;

  debugLog(`buildVideo start topic="${topic}" target=${targetSeconds}s voice=${voiceKey}`);
  setStage("Writing the script with AI…", 3);
  const script = await generateScript(topic, targetSeconds, language, tone, style);
  debugLog(`script ready: source=${script.source} scenes=${script.scenes.length}`);

  const perSegmentWords = Math.max(12, Math.round((targetSeconds * WORDS_PER_SECOND) / script.scenes.length));
  const segments = [];
  script.scenes.forEach((scene, sceneIndex) => {
    for (const chunk of chunkText(scene.text, perSegmentWords)) {
      segments.push({ text: chunk, visual: scene.visual, sceneIndex, index: segments.length });
    }
  });

  const ctxAudio = new Map();
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    setStage(`Generating voiceover ${i + 1}/${segments.length}…`, 8 + Math.round((i / segments.length) * 30));
    const segment = segments[i];
    try {
      const wav = await synthWav(segment.text, spec.voice, spec.rate, spec.pitch);
      const buffer = await state.audioCtx.decodeAudioData(wav.slice(0));
      const rate = state.audioCtx.sampleRate;
      ctxAudio.set(segment.index, await resampleTo(buffer, rate));
      segment.duration = buffer.duration + SCENE_PAD_SECONDS;
    } catch (err) {
      segment.duration = estimateSeconds(segment.text) + SCENE_PAD_SECONDS;
      debugLog(`tts ${i + 1} failed: ${err.message} (using estimate)`);
    }
    segment.start = cursor;
    cursor += segment.duration;
  }

  for (let i = 0; i < segments.length; i++) {
    setStage(`Creating scene image ${i + 1}/${segments.length}…`, 40 + Math.round((i / segments.length) * 35));
    const segment = segments[i];
    const { bitmap, source } = await sceneImage(segment.visual, 1000 + i);
    segment.bitmap = bitmap;
    segment.imageSource = source;
    debugLog(`image ${i + 1}/${segments.length}: ${source}${bitmap ? "" : " (no bitmap)"}`);
  }

  const mime = pickMime();
  if (!mime) throw new Error("This browser cannot record video (MediaRecorder unsupported).");
  setStage("Rendering video in your browser…", 78);
  const blob = await renderVideo(
    segments, ctxAudio, mime,
    (pct) => setStage("Rendering video in your browser…", 78 + Math.round(pct * 0.2)),
    state.audioCtx,
  );

  return {
    blob,
    mime,
    script,
    segments,
    duration: cursor,
  };
}

// --- History (IndexedDB) ---------------------------------------------------
// GitHub Pages has no backend, so finished videos are kept in the browser.

const DB_NAME = "lfvs";
const DB_STORE = "videos";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function historyPut(entry) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(entry);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) { /* storage unavailable — history is best-effort */ }
}

async function historyAll() {
  try {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a, b) => b.created - a.created);
  } catch (err) {
    return [];
  }
}

// --- UI --------------------------------------------------------------------

function showVideo(result, topic, fromHistory) {
  hide($("placeholder"));
  hide($("progress-box"));
  hide($("error-box"));
  $("video-title").textContent = result.script.title || topic;
  const ext = result.mime.includes("mp4") ? "mp4" : "webm";
  if (state.lastUrl) URL.revokeObjectURL(state.lastUrl);
  state.lastBlob = result.blob;
  state.lastUrl = URL.createObjectURL(result.blob);
  $("video").src = state.lastUrl;
  const note = result.script.source === "ai"
    ? "script: AI"
    : "script: built-in (AI text service was unavailable)";
  $("video-meta").textContent =
    `${result.duration.toFixed(1)}s  •  ${result.segments.length} scenes  •  ` +
    `${(result.blob.size / 1048576).toFixed(1)} MB  •  ${note}`;
  $("download-btn").href = state.lastUrl;
  $("download-btn").download = `${(result.script.title || topic).replace(/[^\w\- ]+/g, "").slice(0, 60) || "video"}.${ext}`;
  show($("video-box"));
  if (!fromHistory) {
    historyPut({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created: Date.now(),
      title: result.script.title || topic,
      topic,
      targetSeconds: Math.round(result.duration),
      duration: result.duration,
      scenes: result.segments.length,
      size: result.blob.size,
      mime: result.mime,
      source: result.script.source,
      blob: result.blob,
    }).then(renderHistory);
  }
}

async function renderHistory() {
  const list = $("history-list");
  if (!list) return;
  const rows = await historyAll();
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px">No videos yet.</p>';
    return;
  }
  for (const row of rows) {
    const card = document.createElement("div");
    card.className = "history-card";
    card.innerHTML = `
      <h4>${(row.title || row.topic).slice(0, 60)}</h4>
      <p>${Math.round(row.duration)}s • ${row.scenes} scenes • ${(row.size / 1048576).toFixed(1)} MB</p>
      <span class="badge done">done</span>`;
    card.addEventListener("click", () => {
      showVideo(
        { blob: row.blob, mime: row.mime, duration: row.duration, segments: new Array(row.scenes), script: { title: row.title, source: row.source } },
        row.topic,
        true,
      );
    });
    list.appendChild(card);
  }
}

function showError(message) {
  hide($("progress-box"));
  hide($("video-box"));
  $("error-text").textContent = message;
  show($("error-box"));
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const topic = $("topic").value.trim();
  if (!topic) return;
  const targetSeconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, parseInt($("duration").value, 10)));
  const voiceKey = $("voice").value;

  state.busy = true;
  $("submit-btn").disabled = true;
  hide($("placeholder"));
  hide($("video-box"));
  hide($("error-box"));
  show($("progress-box"));
  setStage("Starting…", 2);

  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // resume() can hang under strict autoplay policies; never block the build.
    await Promise.race([state.audioCtx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    const result = await buildVideo(
      topic, targetSeconds, voiceKey,
      $("tone").value.trim() || "engaging and informative",
      $("style").value, VOICES[voiceKey].lang,
    );
    showVideo(result, topic);
  } catch (err) {
    showError(String((err && err.message) || err));
  } finally {
    state.busy = false;
    $("submit-btn").disabled = false;
  }
}

function init() {
  const duration = $("duration");
  const durValue = $("dur-value");
  duration.addEventListener("input", () => { durValue.textContent = duration.value; });

  const select = $("voice");
  for (const [key, spec] of Object.entries(VOICES)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = spec.label;
    select.appendChild(option);
  }
  select.value = "en_female";

  $("gen-form").addEventListener("submit", onSubmit);
  $("again-btn").addEventListener("click", () => {
    hide($("video-box"));
    show($("placeholder"));
    $("video").removeAttribute("src");
  });

  const badge = $("engine-badge");
  if (!pickMime()) {
    badge.className = "status-chip bad";
    badge.innerHTML = '<span class="dot"></span> recording unsupported';
  } else if (!window.isSecureContext) {
    badge.className = "status-chip bad";
    badge.innerHTML = '<span class="dot"></span> needs https';
  }

  applyUrlParams();
  renderHistory();
}

// Deep links: ?topic=...&duration=60&voice=id_female&style=cinematic&autorun=1
function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const topic = params.get("topic");
  if (!topic) return;
  $("topic").value = topic;
  if (params.get("duration")) {
    $("duration").value = params.get("duration");
    $("dur-value").textContent = $("duration").value;
  }
  if (params.get("voice") && VOICES[params.get("voice")]) $("voice").value = params.get("voice");
  if (params.get("style")) $("style").value = params.get("style");
  if (params.get("tone")) $("tone").value = params.get("tone");
  if (params.get("autorun") === "1") {
    setTimeout(() => $("gen-form").requestSubmit(), 300);
  }
}

init();
