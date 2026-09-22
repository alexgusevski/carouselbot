import { loadVideo, releaseVideo } from "./video-media.mjs";

// Offline mixing works even when an agent has no transient user gesture. Muted
// media-element capture preserves source audio without playing it on speakers.
export async function prepareExportAudio(videos, duration) {
  if (videos.some((video) => !video.captureStream)) {
    const live = new AudioContext();
    let timeout;
    try {
      await Promise.race([live.resume(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("This browser requires a click in the editor before exporting audio. Click once and retry, or use current Chrome for gesture-free agent exports.")), 3000);
      })]);
      const destination = live.createMediaStreamDestination();
      for (const video of videos) {
        video.muted = false;
        live.createMediaElementSource(video).connect(destination);
      }
      return { tracks: destination.stream.getAudioTracks(), release() {
        destination.stream.getTracks().forEach((track) => track.stop());
        void live.close();
      } };
    } catch (error) { await live.close(); throw error; }
    finally { clearTimeout(timeout); }
  }
  const sampleRate = 48000;
  const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  let sources = 0;
  for (const video of videos) {
    const probe = video.captureStream();
    const hasAudio = probe.getAudioTracks().length > 0;
    probe.getTracks().forEach((track) => track.stop());
    if (!hasAudio) continue;
    let buffer;
    try { buffer = await context.decodeAudioData(await fetch(video.src).then((response) => response.arrayBuffer())); }
    catch { throw new Error("The video audio could not be decoded for export. Convert the clip to H.264/AAC MP4 and retry."); }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
    sources += 1;
  }
  if (!sources) return null;
  const mixed = await context.startRendering();
  const channels = mixed.numberOfChannels;
  const bytes = new ArrayBuffer(44 + mixed.length * channels * 2);
  const view = new DataView(bytes);
  const label = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  label(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); label(8, "WAVE");
  label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, bytes.byteLength - 44, true);
  const samples = Array.from({ length: channels }, (_, channel) => mixed.getChannelData(channel));
  for (let frame = 0; frame < mixed.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, samples[channel][frame]));
      view.setInt16(44 + (frame * channels + channel) * 2, sample * (sample < 0 ? 32768 : 32767), true);
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  let player;
  let stream;
  try {
    player = await loadVideo(url);
    stream = player.captureStream();
    return { player, tracks: stream.getAudioTracks(), release() {
      stream.getTracks().forEach((track) => track.stop());
      releaseVideo(player);
      URL.revokeObjectURL(url);
    } };
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (player) releaseVideo(player);
    URL.revokeObjectURL(url);
    throw error;
  }
}
