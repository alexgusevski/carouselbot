import { slideVideoDuration } from "./editor-model.mjs";
import { releaseVideo } from "./video-media.mjs";

let previous = null;

export function mountVideoPlayback(root, slide, project) {
  const duration = slideVideoDuration(slide, project);
  const videos = [...root.querySelectorAll("[data-slide-video]")];
  if (!duration) return () => {};
  const button = root.querySelector("[data-video-play]");
  const range = root.querySelector("[data-video-time]");
  const clock = root.querySelector("[data-video-clock]");
  let playing = previous?.slideId === slide.id ? previous.playing : true;
  let time = previous?.slideId === slide.id ? previous.time % duration : 0;
  let last = performance.now();
  let frame;
  const sync = (seek = false) => {
    for (const video of videos) {
      if (!Number.isFinite(video.duration)) continue;
      const target = Math.min(time, duration - 0.001) % video.duration;
      video.loop = true;
      if (seek || Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
      if (playing && video.paused) void video.play().catch(() => {});
      if (!playing) video.pause();
    }
    range.value = time;
    clock.textContent = `${time.toFixed(1)} / ${duration.toFixed(1)}s`;
    range.style.setProperty("--video-progress", `${time / duration * 100}%`);
    button.setAttribute("aria-label", playing ? "Pause video" : "Play video");
    button.setAttribute("aria-pressed", String(playing));
  };
  const toggle = () => { playing = !playing; last = performance.now(); sync(); };
  // Capture Space before focused assets/buttons can activate themselves.
  let spaceHandled = false;
  const keydown = (event) => {
    if ((event.code !== "Space" && event.key !== " ") || event.metaKey || event.ctrlKey || event.altKey
      || event.target.isContentEditable
      || event.target.closest('input:not([type="range"]), textarea, select, [role="textbox"], dialog[open]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    spaceHandled = true;
    if (!event.repeat) toggle();
  };
  const keyup = (event) => {
    if (!spaceHandled || (event.code !== "Space" && event.key !== " ")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    spaceHandled = false;
  };
  button.onclick = toggle;
  range.oninput = () => { time = Number(range.value); last = performance.now(); sync(true); };
  const tick = (now) => {
    if (playing) time = (time + (now - last) / 1000) % duration;
    last = now;
    sync();
    frame = requestAnimationFrame(tick);
  };
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("keyup", keyup, true);
  frame = requestAnimationFrame(tick);
  sync();
  return () => {
    previous = { slideId: slide.id, playing, time };
    cancelAnimationFrame(frame);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("keyup", keyup, true);
    videos.forEach(releaseVideo);
  };
}
