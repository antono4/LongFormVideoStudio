// One-shot eSpeak-NG worker. eSpeak's wasm instance cannot be re-run (its
// `main` only produces a file on the first call) and `noExitRuntime` keeps the
// whole ~18 MB runtime alive, so the parent creates a fresh worker per
// utterance and terminates it afterwards. That keeps peak memory flat no matter
// how many scenes a video has.

// Versioned so a tab that cached an older (patched) bundle refetches this one.
import ESpeakNG from "./vendor/espeak-ng.js?v=3";

const VENDOR = new URL("./vendor/", import.meta.url).href;

self.onmessage = async (event) => {
  const { text, voice, rate, pitch } = event.data;
  try {
    const args = ["-v", voice || "en-us", "-s", String(rate || 165), "-p", String(pitch || 50)];
    args.push("-w", "out.wav", text);
    const espeak = await ESpeakNG({
      arguments: args,
      locateFile: (path) => VENDOR + path,
    });
    const data = espeak.FS.readFile("out.wav");
    const wav = data.slice().buffer;
    self.postMessage({ ok: true, wav }, [wav]);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
