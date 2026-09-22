import { loadVideo, releaseVideo } from "./video-media.mjs";
import { renderSlideCanvas } from "./slide-renderer.mjs";

// Separate decoders keep agent frame inspection from moving the user's playhead.
export async function renderVideoFrame(slide, project, width, height, time = 0) {
  const videos = [];
  const media = new Map();
  try {
    const ids = new Set((slide.overlays || []).map((layer) => layer.assetId));
    for (const source of [slide, ...(project.assets || []).filter((asset) => ids.has(asset.id))]) {
      if (!source.videoData) continue;
      const video = await loadVideo(source.videoData);
      videos.push(video);
      const target = Math.max(0, time) % video.duration;
      if (Math.abs(video.currentTime - target) > 0.001) {
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer);
            video.onseeked = null;
            video.onerror = null;
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finish(new Error("Video frame seek timed out.")), 15000);
          video.onseeked = () => finish();
          video.onerror = () => finish(new Error("Video frame could not be decoded."));
          video.currentTime = target;
        });
      }
      media.set(source.id, video);
    }
    return await renderSlideCanvas(slide, width, height, project, media);
  } finally { videos.forEach(releaseVideo); }
}
