let loading;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = setTimeout(() => finish(new Error("Verification could not load. Please try again.")), 15000);
    const finish = (error) => {
      clearTimeout(timer);
      if (error) { script.remove(); loading = null; reject(error); }
      else resolve();
    };
    script.onload = () => finish(window.turnstile ? null : new Error("Verification is unavailable."));
    script.onerror = () => finish(new Error("Verification could not load. Please try again."));
    document.head.appendChild(script);
  });
  return loading;
}
export async function verifyShareRequest() {
  const response = await fetch("/api/shares/config", { cache: "no-store", signal: AbortSignal.timeout(15000) });
  const config = await response.json();
  if (!response.ok || !config.siteKey) throw new Error(config.error || "Sharing is temporarily unavailable.");
  await loadTurnstile();
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = '<section class="modal" role="dialog" aria-modal="true" aria-labelledby="share-verify-title"><h2 id="share-verify-title">Create a share link</h2><p>Please verify this request to keep free sharing available.</p><div data-share-verification></div><div class="modal-actions"><button class="button button--quiet" type="button">Cancel</button></div></section>';
    let widget;
    let finished = false;
    const finish = (error, token) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (widget != null) window.turnstile.remove(widget);
      backdrop.remove();
      if (error) reject(error); else resolve(token);
    };
    const cancel = () => finish(new Error("Share link cancelled."));
    const timer = setTimeout(() => finish(new Error("Verification timed out. Please try again.")), 120000);
    backdrop.querySelector("button").addEventListener("click", cancel);
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") cancel(); });
    document.body.appendChild(backdrop);
    backdrop.querySelector("button").focus();
    try {
      widget = window.turnstile.render(backdrop.querySelector("[data-share-verification]"), {
        sitekey: config.siteKey, action: "share", callback: (token) => finish(null, token),
        "error-callback": () => finish(new Error("Verification failed. Please try again.")),
        "expired-callback": () => finish(new Error("Verification expired. Please try again.")),
      });
    } catch { finish(new Error("Verification is unavailable. Please try again.")); }
  });
}
