// Browser media resources are scoped to an import, playback view, or export.
export function releaseVideo(video) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

// Imported media is already local. Fetching a data URL is a network request to
// CSP, even though playback of that same URL is allowed by media-src.
export function localVideoBytes(src) {
  const match = /^data:video\/[^;,]+(?:;[^,]*)?;base64,(.+)$/s.exec(src);
  if (!match) throw new Error("A local video data URL is required.");
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function readVideoAudio(src, context) {
  const { Input, BufferSource, MP4, QTFF, MATROSKA, AudioBufferSink } = await import("/assets/mediabunny-1.60.0.min.mjs");
  const bytes = localVideoBytes(src);
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4, QTFF, MATROSKA] });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const decoder = context || new OfflineAudioContext(2, 1, 48000);
    try { return await decoder.decodeAudioData(bytes.slice().buffer); }
    catch (error) {
      // Some playable MP4/MOV containers are rejected by Web Audio's container
      // decoder. Demux them locally and use the browser's audio codec directly.
      if (!await track.canDecode()) throw new Error("This video's audio codec is not supported by this browser. The clip was not imported; try current Chrome or an AAC/Opus audio track.", { cause: error });
      const duration = await track.computeDuration();
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("This video has no valid audio duration.");
      let buffer;
      for await (const sample of new AudioBufferSink(track).buffers()) {
        const sampleRate = sample.buffer.sampleRate;
        if (!buffer) buffer = decoder.createBuffer(sample.buffer.numberOfChannels, Math.ceil(duration * sampleRate), sampleRate);
        const offset = Math.round(sample.timestamp * sampleRate);
        const skip = Math.max(0, -offset);
        const start = Math.max(0, offset);
        const length = Math.min(sample.buffer.length - skip, buffer.length - start);
        if (length <= 0) continue;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          buffer.copyToChannel(sample.buffer.getChannelData(channel).subarray(skip, skip + length), channel, start);
        }
      }
      if (!buffer) throw new Error("This video's audio track could not be decoded. The clip was not imported.");
      return buffer;
    }
  } finally { input.dispose(); }
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
  const bytes = localVideoBytes(src);
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
    // Validate the export decoder before accepting the clip into a project.
    // Unsupported audio must never surface only after the user has edited it.
    await readVideoAudio(src);
    return { imageData: canvas.toDataURL("image/jpeg", 0.85), videoData: src,
      width: canvas.width, height: canvas.height, duration };
  } finally { canvas.width = 0; canvas.height = 0; }
}
