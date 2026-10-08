// Module worker: fetches scene images off the main thread so the UI stays
// responsive while a video is built.

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    if (type === "image") {
      const image = await fetchImage(event.data.url);
      self.postMessage({ id, ok: true, image }, [image]);
    } else {
      throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

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
  const decoded = await createImageBitmap(blob, { imageOrientation: "flipY" }).catch(
    () => createImageBitmap(blob),
  );
  // Wikimedia can return very tall/wide photos; a single 1280x4000 bitmap is
  // ~20 MB, and dozens of them pin hundreds of MB. Bound every bitmap to 1280
  // on its long side (aspect preserved -> coverDraw still crops correctly).
  const MAX = 1280;
  if (decoded.width <= MAX && decoded.height <= MAX) return decoded;
  const scale = MAX / Math.max(decoded.width, decoded.height);
  const resized = await createImageBitmap(blob, {
    resizeWidth: Math.max(1, Math.round(decoded.width * scale)),
    resizeHeight: Math.max(1, Math.round(decoded.height * scale)),
    resizeQuality: "high",
    imageOrientation: "flipY",
  }).catch(() => null);
  if (!resized) return decoded;
  decoded.close();
  return resized;
}
