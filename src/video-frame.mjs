import { readVideoFrame } from "./video-media.mjs";
import { renderSlideCanvas } from "./slide-renderer.mjs";

// Independent local frames never move the user's playhead or need a visible tab.
export async function renderVideoFrame(slide, project, width, height, time = 0) {
  const media = new Map();
  try {
    const ids = new Set((slide.overlays || []).map((layer) => layer.assetId));
    for (const source of [slide, ...(project.assets || []).filter((asset) => ids.has(asset.id))]) {
      if (!source.videoData) continue;
      const { canvas } = await readVideoFrame(source.videoData, time);
      media.set(source.id, canvas);
    }
    return await renderSlideCanvas(slide, width, height, project, media);
  } finally {
    for (const canvas of media.values()) { canvas.width = 0; canvas.height = 0; }
  }
}
