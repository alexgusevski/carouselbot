// Browser media resources are scoped to an import, playback view, or export.
export function releaseVideo(video) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

export function loadVideo(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const timer = setTimeout(() => fail(document.hidden
      ? "Video loading was paused by the browser. Bring the CarouselBot tab to the foreground and retry."
      : "Video loading timed out. Please retry."), 30000);
    const fail = (message = "This video could not be decoded. Try an H.264 MP4.") => {
      clearTimeout(timer);
      video.onerror = null;
      video.onloadeddata = null;
      releaseVideo(video);
      reject(new Error(message));
    };
    video.onerror = () => fail();
    video.onloadeddata = () => {
      clearTimeout(timer);
      video.onerror = null;
      video.onloadeddata = null;
      if (!Number.isFinite(video.duration) || video.duration <= 0) return fail();
      resolve(video);
    };
    video.src = src;
  });
}

// HTML media elements can defer loading indefinitely in a background tab.
// Decode local frames directly instead; load this parser only for video work.
export async function readVideoFrame(src, time = 0) {
  if (!globalThis.VideoDecoder) return readHtmlVideoFrame(src, time);
  const { Input, BufferSource, MP4, QTFF, MATROSKA, CanvasSink } = await import("/assets/mediabunny-1.60.0.min.mjs");
  const match = /^data:video\/[^;,]+(?:;[^,]*)?;base64,(.+)$/s.exec(src);
  if (!match) throw new Error("A local video data URL is required.");
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4, QTFF, MATROSKA] });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const track = await input.getPrimaryVideoTrack();
        if (!track || !await track.canDecode()) throw new Error("This video codec is not supported by your browser. Try an H.264 MP4.");
        const duration = await input.computeDuration();
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("This video has no valid duration.");
        const first = await track.getFirstTimestamp();
        const frame = await new CanvasSink(track).getCanvas(Math.max(first, Math.max(0, time) % duration));
        if (!frame) throw new Error("This video has no decodable frame.");
        return { canvas: frame.canvas, duration };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Video decoding timed out. Please retry.")), 30000); }),
    ]);
  } finally { clearTimeout(timer); input.dispose(); }
}

async function readHtmlVideoFrame(src, time) {
  const video = await loadVideo(src);
  try {
    const target = Math.max(0, time) % video.duration;
    if (Math.abs(video.currentTime - target) > 0.001) {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer); video.onseeked = null; video.onerror = null;
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error("Video frame seek timed out.")), 15000);
        video.onseeked = () => finish();
        video.onerror = () => finish(new Error("Video frame could not be decoded."));
        video.currentTime = target;
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return { canvas, duration: video.duration };
  } finally { releaseVideo(video); }
}

export async function readVideoAsset(src) {
  const { canvas, duration } = await readVideoFrame(src);
  try {
    return { imageData: canvas.toDataURL("image/jpeg", 0.85), videoData: src,
      width: canvas.width, height: canvas.height, duration };
  } finally { canvas.width = 0; canvas.height = 0; }
}
