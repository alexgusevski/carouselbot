import { prepareExportAudio } from "./video-audio.mjs";
import { ensureProjectFontsLoaded } from "./project-fonts.mjs";
import { canonicalSolidBackgroundColor } from "./slide-background.mjs";
import { slideCanvasDimensions, getImageLayout, slideVideoDuration } from "./editor-model.mjs";
import { loadImage, drawSlideLayers } from "./slide-renderer.mjs";
import { loadVideo, releaseVideo } from "./video-media.mjs";

// Record the same canvas composition used by PNG export, entirely on-device.
export async function renderSlideMp4(slide, project) {
  const mimeType = ["video/mp4;codecs=avc3.420033,mp4a.40.2", "video/mp4;codecs=avc1.420033,mp4a.40.2", "video/mp4"].find((type) => globalThis.MediaRecorder?.isTypeSupported(type));
  if (!mimeType) throw new Error("MP4 export needs a browser with MP4 recording support, such as current Chrome or Safari.");
  const videos = [];
  const media = new Map();
  let stream;
  let audio;
  let recorder;
  let timer;
  try {
    const assets = [...new Set((slide.overlays || []).map((layer) => layer.assetId))]
      .map((id) => project.assets.find((asset) => asset.id === id)).filter(Boolean);
    for (const asset of [slide, ...assets]) {
      const source = asset.videoData ? await loadVideo(asset.videoData) : await loadImage(asset.imageData);
      media.set(asset.id, source);
      if (asset.videoData) {
        videos.push(source);
        source.loop = true;
      }
    }
    audio = await prepareExportAudio(videos, slideVideoDuration(slide, project));
    await ensureProjectFontsLoaded(project, slide.texts || []);
    const canvas = document.createElement("canvas");
    const dimensions = slideCanvasDimensions(project, slide);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    const layout = getImageLayout(slide, canvas.width, canvas.height);
    const draw = async () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const backgroundColor = canonicalSolidBackgroundColor(slide, project);
      if (backgroundColor && !slide.videoData) {
        context.fillStyle = backgroundColor;
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else context.drawImage(media.get(slide.id), layout.left, layout.top, layout.width, layout.height);
      await drawSlideLayers(context, slide, canvas.width, canvas.height, project, media);
    };
    await draw();
    stream = canvas.captureStream(30);
    audio?.tracks.forEach((track) => stream.addTrack(track));
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
    const chunks = [];
    const finished = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = (event) => reject(event.error || new Error("MP4 encoding failed"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/mp4" }));
    });
    await Promise.all([...videos, ...(audio?.player ? [audio.player] : [])].map((video) => video.play()));
    recorder.start(250);
    const started = performance.now();
    const duration = slideVideoDuration(slide, project) * 1000;
    let drawing = false;
    timer = setInterval(() => {
      if (performance.now() - started >= duration) {
        clearInterval(timer);
        recorder.stop();
      } else if (!drawing) {
        drawing = true;
        void draw().finally(() => { drawing = false; });
      }
    }, 1000 / 30);
    return await finished;
  } finally {
    clearInterval(timer);
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    videos.forEach(releaseVideo);
    audio?.release();
  }
}
