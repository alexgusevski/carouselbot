// A self-contained ten-second app walkthrough, generated locally on demand.
export async function createSampleClip() {
  const canvas = document.createElement("canvas");
  canvas.width = 460;
  canvas.height = 920;
  const ctx = canvas.getContext("2d");
  const draw = (seconds) => {
    ctx.fillStyle = "#f5f4ee";
    ctx.fillRect(0, 0, 460, 920);
    const text = (value, x, y, size = 22, color = "#17352b") => {
      ctx.fillStyle = color;
      ctx.font = `600 ${size}px system-ui`;
      ctx.fillText(value, x, y);
    };
    text("9:41", 28, 40, 16);
    text("● ● ●", 350, 40, 12);
    text("focus", 28, 120, 38);
    text("A little progress, every day.", 28, 159, 18, "#64756d");
    ctx.fillStyle = "#dce9be";
    ctx.beginPath(); ctx.roundRect(24, 200, 412, 176, 24); ctx.fill();
    const count = Math.min(3, Math.floor(seconds / 2.5));
    text("TODAY’S PROGRESS", 44, 240, 14);
    text(`${count} of 3`, 44, 304, 44);
    ctx.fillStyle = "#bdcea0"; ctx.fillRect(44, 336, 370, 8);
    ctx.fillStyle = "#285b3f"; ctx.fillRect(44, 336, 370 * count / 3, 8);
    text("Your daily rituals", 28, 428, 24);
    ["Drink a glass of water", "Read for 10 minutes", "Take a mindful walk"].forEach((label, i) => {
      const y = 462 + i * 104;
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.roundRect(24, y, 412, 88, 18); ctx.fill();
      ctx.strokeStyle = "#bbc8bc"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(60, y + 44, 15, 0, Math.PI * 2); ctx.stroke();
      if (i < count) { ctx.fillStyle = "#285b3f"; ctx.fill(); text("✓", 50, y + 51, 21, "#fff"); }
      text(label, 91, y + 50, 18, i < count ? "#88988a" : "#17352b");
    });
    text(count === 3 ? "Small steps. Big difference." : "Make room for what matters.", 28, 830, 19);
    text("Today                       Insights          Profile", 28, 887, 15, "#64756d");
    const cycle = seconds % 2.5;
    if (seconds > 1 && count < 3) {
      const y = 506 + count * 104;
      const radius = 12 + Math.sin(cycle * Math.PI) * 5;
      ctx.fillStyle = "#285b3f33";
      ctx.beginPath(); ctx.arc(60, y, radius + 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#285b3f";
      ctx.beginPath(); ctx.arc(60, y, 7, 0, Math.PI * 2); ctx.fill();
    }
  };
  draw(0);
  const mimeType = ["video/mp4;codecs=avc3.420033", "video/mp4", "video/webm"].find((type) => globalThis.MediaRecorder?.isTypeSupported(type));
  if (!mimeType) throw new Error("This browser cannot create the sample video.");
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  let timer;
  try {
    const result = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error("Could not create sample video"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    recorder.start();
    const start = performance.now();
    timer = setInterval(() => {
      const seconds = (performance.now() - start) / 1000;
      draw(Math.min(seconds, 9.99));
      if (seconds >= 10) { clearInterval(timer); recorder.stop(); }
    }, 1000 / 30);
    return await result;
  } finally {
    clearInterval(timer);
    if (recorder.state === "recording") recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
  }
}
