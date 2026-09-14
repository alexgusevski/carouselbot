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
    const timer = setTimeout(() => fail(), 30000);
    const fail = () => {
      clearTimeout(timer);
      video.onerror = null;
      video.onloadeddata = null;
      releaseVideo(video);
      reject(new Error("This video could not be decoded. Try an H.264 MP4."));
    };
    video.onerror = fail;
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

export async function readVideoAsset(src) {
  const video = await loadVideo(src);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return { imageData: canvas.toDataURL("image/jpeg", 0.85), videoData: src,
      width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  } finally { releaseVideo(video); }
}
