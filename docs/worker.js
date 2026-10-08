// Module worker: runs eSpeak-NG (WASM) and fetches scene images off the main
// thread so the UI stays responsive while a video is built.

import ESpeakNG from "./vendor/espeak-ng.js";

const VENDOR = new URL("./vendor/", import.meta.url).href;

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    if (type === "tts") {
      const wav = await synthesize(event.data);
      self.postMessage({ id, ok: true, wav }, [wav]);
    } else if (type === "image") {
      const image = await fetchImage(event.data.url);
      self.postMessage({ id, ok: true, image }, [image]);
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

async function synthesize({ text, voice, rate, pitch }) {
  const args = ["-v", voice || "en-us", "-s", String(rate || 165), "-p", String(pitch || 50)];
  args.push("-w", "out.wav", text);
  const espeak = await ESpeakNG({
    arguments: args,
    locateFile: (path) => VENDOR + path,
  });
  const data = espeak.FS.readFile("out.wav");
  return data.slice().buffer;
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(url, { mode: "cors", redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`image http ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("empty image response");
  return await createImageBitmap(blob, { imageOrientation: "flipY" }).catch(
    () => createImageBitmap(blob),
  );
}
