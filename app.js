const DB_NAME = "slide-studio-db";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const DESIGN_WIDTH = 1080;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const DEFAULT_OUTLINE_WIDTH = 14;

const state = {
  projects: [],
  activeProjectId: null,
  activeSlideId: null,
  selectedTextId: null,
  db: null,
  stageWidth: 0,
  stageHeight: 0,
  saveTimer: null,
  toastTimer: null,
  mobileInspectorOpen: false,
  photoAdjustMode: false,
  showTikTokOverlay: false,
};

const app = document.querySelector("#app");

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllProjects() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putProject(project) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(project);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteProjectFromDb(projectId) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(projectId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function activeSlide() {
  return activeProject()?.slides.find((slide) => slide.id === state.activeSlideId) || null;
}

function selectedText() {
  return activeSlide()?.texts.find((text) => text.id === state.selectedTextId) || null;
}

function scheduleSave() {
  const project = activeProject();
  if (!project) return;
  project.updatedAt = Date.now();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await putProject(project);
    } catch (error) {
      console.error(error);
      toast("Couldn’t save this project in your browser.");
    }
  }, 180);
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  clearTimeout(state.toastTimer);
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  document.body.appendChild(element);
  state.toastTimer = setTimeout(() => element.remove(), 2600);
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function icon(name) {
  const icons = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m7 7 1 14h8l1-14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  };
  return icons[name] || "";
}

function renderHeader({ editor = false } = {}) {
  const project = activeProject();
  return `
    <header class="app-header">
      <button class="brand" type="button" data-action="home" aria-label="Go to projects">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-copy"><strong>Slide Studio</strong><small>TikTok image maker</small></span>
      </button>
      ${editor && project ? `
        <div class="project-identity">
          <input class="project-title-input" value="${escapeHtml(project.name)}" aria-label="Project name" maxlength="64" />
        </div>
      ` : ""}
      <div class="header-actions">
        ${editor ? `
          <button class="icon-button mobile-edit-button" type="button" data-action="toggle-inspector" aria-label="Toggle text controls">${icon("edit")}</button>
          <button class="button button--primary" type="button" data-action="export" ${activeSlide() ? "" : "disabled"}>
            ${icon("download")} <span>Download PNG</span>
          </button>
        ` : `<button class="button button--primary" type="button" data-action="new-project">New project</button>`}
      </div>
    </header>
  `;
}

function renderDashboard() {
  state.activeProjectId = null;
  state.activeSlideId = null;
  state.selectedTextId = null;
  const sortedProjects = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  app.innerHTML = `
    ${renderHeader()}
    <main class="dashboard">
      <section class="dashboard-hero">
        <div>
          <p class="eyebrow">Made for your camera roll</p>
          <h1>Turn photos into<br><em>scroll-stoppers.</em></h1>
        </div>
        <p class="dashboard-intro">Upload your photos, place TikTok-style text, and export crisp slideshow images. Nothing else in the way.</p>
      </section>
      <section>
        <div class="section-heading">
          <h2>Your projects</h2>
          <span>${sortedProjects.length} ${sortedProjects.length === 1 ? "project" : "projects"}</span>
        </div>
        <div class="project-grid">
          <button class="new-project-card" type="button" data-action="new-project">
            <span>+</span>
            <span><strong>Start a project</strong><small>Add photos when you’re ready</small></span>
          </button>
          ${sortedProjects.map((project) => {
            const cover = project.slides[0]?.imageData;
            return `
              <button class="project-card" type="button" data-project-id="${project.id}">
                <span class="project-preview">
                  ${cover ? `<img src="${cover}" alt="" />` : `<span class="project-preview-empty">No photos yet</span>`}
                </span>
                <span class="project-meta">
                  <strong>${escapeHtml(project.name)}</strong>
                  <span>${project.slides.length} ${project.slides.length === 1 ? "slide" : "slides"} · ${formatDate(project.updatedAt)}</span>
                </span>
              </button>
            `;
          }).join("")}
        </div>
      </section>
    </main>
  `;
  bindDashboardEvents();
}

function renderEditor() {
  const project = activeProject();
  if (!project) return renderDashboard();
  if (!activeSlide() && project.slides[0]) state.activeSlideId = project.slides[0].id;

  app.innerHTML = `
    ${renderHeader({ editor: true })}
    <main class="editor-shell">
      ${renderSlideRail(project)}
      <section class="workspace" aria-label="Image editor">
        <div class="workspace-tools">
          <button class="tool-chip ${state.photoAdjustMode ? "is-active" : ""}" type="button" data-action="adjust-photo" aria-pressed="${state.photoAdjustMode}" ${activeSlide() ? "" : "disabled"}>Adjust photo</button>
          <button class="tool-chip ${state.showTikTokOverlay ? "is-active" : ""}" type="button" data-action="toggle-tiktok-overlay" aria-pressed="${state.showTikTokOverlay}" ${activeSlide() ? "" : "disabled"}>TikTok UI preview</button>
        </div>
        <div class="workspace-inner">
          ${activeSlide() ? renderStage(activeSlide()) : renderEmptyStage()}
        </div>
      </section>
      ${renderInspector()}
    </main>
    <input id="photo-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" multiple />
  `;
  bindEditorEvents();
  if (activeSlide()) requestAnimationFrame(sizeStage);
}

function renderSlideRail(project) {
  return `
    <aside class="slide-rail">
      <div class="rail-heading"><h2>Photos</h2><span>${project.slides.length}</span></div>
      <div class="slide-list">
        ${project.slides.map((slide, index) => `
          <button class="slide-thumb ${slide.id === state.activeSlideId ? "is-active" : ""}" type="button" data-slide-id="${slide.id}" aria-label="Open slide ${index + 1}">
            <span class="slide-number">${String(index + 1).padStart(2, "0")}</span>
            <span class="thumb-image"><img src="${slide.imageData}" alt="" /></span>
          </button>
        `).join("")}
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload">+ Add photos</button></div>
    </aside>
  `;
}

function renderEmptyStage() {
  return `
    <div class="empty-stage">
      <div>
        <div class="empty-stage-graphic" aria-hidden="true"></div>
        <h2>Add your first photos</h2>
        <p>Choose one or several images from your computer. Each one becomes a slide.</p>
        <button class="button button--primary" type="button" data-action="upload">Choose photos</button>
      </div>
    </div>
  `;
}

function renderStage(slide) {
  return `
    <div class="stage-wrap">
      <div class="stage ${state.photoAdjustMode ? "is-adjusting" : ""}" data-natural-width="${slide.width}" data-natural-height="${slide.height}">
        <img class="stage-image" src="${slide.imageData}" alt="${escapeHtml(slide.name)}" draggable="false" />
        <div class="text-layer">
          ${slide.texts.map(renderTextBox).join("")}
        </div>
        ${renderTikTokOverlay()}
      </div>
      <span class="stage-dimensions">${OUTPUT_WIDTH} × ${OUTPUT_HEIGHT} · 9:16</span>
    </div>
  `;
}

function renderTikTokOverlay() {
  return `
    <div class="tiktok-overlay ${state.showTikTokOverlay ? "" : "is-hidden"}" aria-hidden="true">
      <div class="tiktok-overlay-canvas">
        <div class="tt-preview-label">PREVIEW ONLY · NOT EXPORTED</div>
        <div class="tt-topbar"><span>Following</span><strong>For You</strong><span class="tt-search">⌕</span></div>
        <div class="tt-side-actions">
          <div class="tt-avatar"><span></span><b>+</b></div>
          <div class="tt-action"><span class="tt-heart">♥</span><small>128K</small></div>
          <div class="tt-action"><span class="tt-bubble">●</span><small>842</small></div>
          <div class="tt-action"><span class="tt-bookmark">▮</span><small>12K</small></div>
          <div class="tt-action"><span class="tt-share">↗</span><small>Share</small></div>
          <div class="tt-disc">♪</div>
        </div>
        <div class="tt-caption">
          <strong>@yourname</strong>
          <p>Your caption appears here <b>more</b></p>
          <span>♫ Original sound · yourname</span>
        </div>
        <div class="tt-bottom-nav">
          <span><b>⌂</b>Home</span><span><b>♙</b>Friends</span><span class="tt-create">+</span><span><b>▣</b>Inbox</span><span><b>◉</b>Profile</span>
        </div>
      </div>
    </div>
  `;
}

function renderTextBox(text) {
  const selected = text.id === state.selectedTextId;
  const outlineWidth = text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH;
  const background = text.background || "white";
  const backgroundShape = text.backgroundShape || "lines";
  return `
    <div
      class="text-box ${selected ? "is-selected" : ""}"
      data-text-id="${text.id}"
      data-style="${text.style}"
      data-background="${background}"
      data-box-shape="${backgroundShape}"
      style="left:${text.x * 100}%;top:${text.y * 100}%;width:${text.width * 100}%;height:${text.height * 100}%;--outline-width:${outlineWidth * (state.stageWidth / DESIGN_WIDTH)}px;"
      tabindex="0"
      aria-label="Text layer: ${escapeHtml(text.text)}"
    >
      <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
    </div>
  `;
}

function renderInspector() {
  const text = selectedText();
  const slide = activeSlide();
  const photoMode = Boolean(state.photoAdjustMode && slide);
  return `
    <aside class="inspector ${state.mobileInspectorOpen ? "is-mobile-open" : ""}">
      <div class="inspector-header">
        <h2>${photoMode ? "Photo settings" : text ? "Text settings" : "Text"}</h2>
        ${text && !photoMode ? `<button class="icon-button" type="button" data-action="delete-text" aria-label="Delete text">${icon("trash")}</button>` : ""}
      </div>
      ${photoMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="photo-zoom">Zoom <output id="photo-zoom-output">${Math.round((slide.imageScale || 1) * 100)}%</output></label>
            <input id="photo-zoom" type="range" min="1" max="3" step="0.01" value="${slide.imageScale || 1}" />
          </div>
          <button class="button button--quiet reset-photo-button" type="button" data-action="reset-photo">Reset photo</button>
          <div class="tip"><strong>Move it</strong><span>Drag the photo inside the 9:16 frame. Zoom in until the crop looks right.</span></div>
        </div>
      ` : text ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="text-value">Words</label>
            <textarea id="text-value" class="text-input" maxlength="500" placeholder="Type something…">${escapeHtml(text.text)}</textarea>
          </div>
          <div class="control-group">
            <div class="control-label">Style</div>
            <div class="style-options">
              <button class="style-option ${text.style === "plain" ? "is-active" : ""}" type="button" data-text-style="plain">
                <span class="style-preview">Aa</span><small>Clean</small>
              </button>
              <button class="style-option ${text.style === "outline" ? "is-active" : ""}" type="button" data-text-style="outline">
                <span class="style-preview style-preview--outline">Aa</span><small>Outline</small>
              </button>
              <button class="style-option ${text.style === "boxed" ? "is-active" : ""}" type="button" data-text-style="boxed">
                <span class="style-preview style-preview--boxed">Aa</span><small>Box</small>
              </button>
            </div>
          </div>
          <div class="control-group">
            <label class="control-label" for="font-size">Size <output>${Math.round(text.size)} px</output></label>
            <div class="range-wrap">
              <input id="font-size" type="range" min="20" max="180" step="1" value="${text.size}" />
              <input id="font-size-number" class="number-input" type="number" min="20" max="180" step="1" value="${Math.round(text.size)}" aria-label="Font size in pixels" />
            </div>
          </div>
          ${text.style === "outline" ? `
            <div class="control-group">
              <label class="control-label" for="outline-width">Outline <output id="outline-output">${Math.round(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH)} px</output></label>
              <div class="range-wrap">
                <input id="outline-width" type="range" min="2" max="18" step="1" value="${text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH}" />
                <input id="outline-width-number" class="number-input" type="number" min="2" max="18" step="1" value="${Math.round(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH)}" aria-label="Outline thickness in pixels" />
              </div>
            </div>
          ` : ""}
          ${text.style === "boxed" ? `
            <div class="control-group">
              <div class="control-label">Background</div>
              <div class="tone-options">
                <button class="tone-option ${text.background !== "black" ? "is-active" : ""}" type="button" data-background-tone="white"><span class="tone-swatch tone-swatch--white">Aa</span>White</button>
                <button class="tone-option ${text.background === "black" ? "is-active" : ""}" type="button" data-background-tone="black"><span class="tone-swatch tone-swatch--black">Aa</span>Black</button>
              </div>
            </div>
            <div class="control-group">
              <div class="control-label">Shape</div>
              <div class="shape-options">
                <button class="shape-option ${text.backgroundShape !== "full" ? "is-active" : ""}" type="button" data-background-shape="lines"><span class="shape-preview shape-preview--lines"><i>Text line</i><i>Shorter</i></span><small>Per line</small></button>
                <button class="shape-option ${text.backgroundShape === "full" ? "is-active" : ""}" type="button" data-background-shape="full"><span class="shape-preview shape-preview--full">Text box</span><small>Full box</small></button>
              </div>
            </div>
          ` : ""}
          <div class="tip"><strong>Tip</strong><span>Drag text to move it. Drag any corner to reshape its box. Double-click the text to type directly.</span></div>
        </div>
      ` : `
        <div class="inspector-empty"><span>T</span><p>${slide ? "Select a text layer, or add one to this photo." : "Add a photo to start placing text."}</p></div>
      `}
      <div class="bottom-actions">
        <button class="button button--primary" type="button" data-action="add-text" ${activeSlide() ? "" : "disabled"}>+ Add text</button>
        ${activeSlide() ? `<button class="button button--quiet" type="button" data-action="delete-slide">Remove photo</button>` : ""}
      </div>
    </aside>
  `;
}

function openProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.activeProjectId = projectId;
  state.activeSlideId = project.slides[0]?.id || null;
  state.selectedTextId = null;
  state.photoAdjustMode = false;
  renderEditor();
}

function showProjectModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal">
      <h2>New project</h2>
      <p>Give this slideshow a name. It stays saved in this browser.</p>
      <input name="project-name" value="Untitled slideshow" maxlength="64" autocomplete="off" aria-label="Project name" />
      <div class="modal-actions">
        <button class="button button--quiet" type="button" data-action="cancel-modal">Cancel</button>
        <button class="button button--primary" type="submit">Create project</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);
  const input = backdrop.querySelector("input");
  requestAnimationFrame(() => input.select());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest('[data-action="cancel-modal"]')) backdrop.remove();
  });
  backdrop.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim() || "Untitled slideshow";
    const project = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), slides: [] };
    state.projects.push(project);
    await putProject(project);
    backdrop.remove();
    openProject(project.id);
  });
}

function bindDashboardEvents() {
  app.querySelectorAll('[data-action="new-project"]').forEach((button) => button.addEventListener("click", showProjectModal));
  app.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => openProject(button.dataset.projectId));
  });
}

function bindGlobalActions() {
  app.querySelector('[data-action="home"]')?.addEventListener("click", renderDashboard);
}

function bindEditorEvents() {
  bindGlobalActions();
  const title = app.querySelector(".project-title-input");
  title?.addEventListener("input", () => {
    activeProject().name = title.value || "Untitled slideshow";
    scheduleSave();
  });

  app.querySelectorAll('[data-action="upload"]').forEach((button) => {
    button.addEventListener("click", () => app.querySelector("#photo-upload").click());
  });
  app.querySelector("#photo-upload")?.addEventListener("change", handleUpload);

  app.querySelectorAll("[data-slide-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSlideId = button.dataset.slideId;
      state.selectedTextId = null;
      state.photoAdjustMode = false;
      renderEditor();
    });
  });

  app.querySelector('[data-action="add-text"]')?.addEventListener("click", addText);
  app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
  app.querySelector('[data-action="delete-slide"]')?.addEventListener("click", deleteActiveSlide);
  app.querySelector('[data-action="export"]')?.addEventListener("click", exportActiveSlide);
  app.querySelector('[data-action="toggle-inspector"]')?.addEventListener("click", () => {
    state.mobileInspectorOpen = !state.mobileInspectorOpen;
    app.querySelector(".inspector")?.classList.toggle("is-mobile-open", state.mobileInspectorOpen);
  });
  app.querySelector('[data-action="adjust-photo"]')?.addEventListener("click", () => {
    state.photoAdjustMode = !state.photoAdjustMode;
    state.selectedTextId = null;
    state.mobileInspectorOpen = true;
    renderEditor();
  });
  app.querySelector('[data-action="toggle-tiktok-overlay"]')?.addEventListener("click", (event) => {
    state.showTikTokOverlay = !state.showTikTokOverlay;
    event.currentTarget.classList.toggle("is-active", state.showTikTokOverlay);
    event.currentTarget.setAttribute("aria-pressed", String(state.showTikTokOverlay));
    app.querySelector(".tiktok-overlay")?.classList.toggle("is-hidden", !state.showTikTokOverlay);
  });

  app.querySelectorAll(".text-box").forEach(bindTextBox);
  bindInspectorControls();

  const workspace = app.querySelector(".workspace");
  workspace?.addEventListener("pointerdown", (event) => {
    if (event.target === workspace || event.target.classList.contains("workspace-inner") || event.target.classList.contains("text-layer")) {
      state.selectedTextId = null;
      refreshSelection();
    }
  });

  const stage = app.querySelector(".stage");
  stage?.addEventListener("pointerdown", (event) => {
    if (!state.photoAdjustMode || event.target.closest(".text-box")) return;
    beginImageDrag(event, stage);
  });

  const resizeObserver = new ResizeObserver(() => sizeStage());
  const workspaceInner = app.querySelector(".workspace-inner");
  if (workspaceInner) resizeObserver.observe(workspaceInner);
}

function bindInspectorControls() {
  const textarea = app.querySelector("#text-value");
  textarea?.addEventListener("input", () => {
    const text = selectedText();
    if (!text) return;
    text.text = textarea.value;
    updateTextBox(text);
    ensureTextFits(text);
    scheduleSave();
  });

  app.querySelectorAll("[data-text-style]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      text.style = button.dataset.textStyle;
      scheduleSave();
      refreshSelection();
      updateTextBox(text);
      ensureTextFits(text);
    });
  });

  const range = app.querySelector("#font-size");
  const number = app.querySelector("#font-size-number");
  const setSize = (value) => {
    const text = selectedText();
    if (!text) return;
    text.size = Math.max(20, Math.min(180, Number(value) || 20));
    if (range) range.value = text.size;
    if (number) number.value = Math.round(text.size);
    const output = app.querySelector(".control-label output");
    if (output) output.textContent = `${Math.round(text.size)} px`;
    updateTextBox(text);
    ensureTextFits(text);
    scheduleSave();
  };
  range?.addEventListener("input", () => setSize(range.value));
  number?.addEventListener("input", () => setSize(number.value));

  const outlineRange = app.querySelector("#outline-width");
  const outlineNumber = app.querySelector("#outline-width-number");
  const setOutlineWidth = (value) => {
    const text = selectedText();
    if (!text) return;
    text.outlineWidth = Math.max(2, Math.min(18, Number(value) || DEFAULT_OUTLINE_WIDTH));
    if (outlineRange) outlineRange.value = text.outlineWidth;
    if (outlineNumber) outlineNumber.value = Math.round(text.outlineWidth);
    const output = app.querySelector("#outline-output");
    if (output) output.textContent = `${Math.round(text.outlineWidth)} px`;
    updateTextBox(text);
    scheduleSave();
  };
  outlineRange?.addEventListener("input", () => setOutlineWidth(outlineRange.value));
  outlineNumber?.addEventListener("input", () => setOutlineWidth(outlineNumber.value));

  app.querySelectorAll("[data-background-tone]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      text.background = button.dataset.backgroundTone;
      app.querySelectorAll("[data-background-tone]").forEach((item) => item.classList.toggle("is-active", item === button));
      updateTextBox(text);
      scheduleSave();
    });
  });

  app.querySelectorAll("[data-background-shape]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      text.backgroundShape = button.dataset.backgroundShape;
      app.querySelectorAll("[data-background-shape]").forEach((item) => item.classList.toggle("is-active", item === button));
      updateTextBox(text);
      ensureTextFits(text);
      scheduleSave();
    });
  });

  const photoZoom = app.querySelector("#photo-zoom");
  photoZoom?.addEventListener("input", () => {
    const slide = activeSlide();
    if (!slide) return;
    slide.imageScale = clamp(Number(photoZoom.value) || 1, 1, 3);
    constrainImagePosition(slide);
    updateStageImage(slide);
    const output = app.querySelector("#photo-zoom-output");
    if (output) output.textContent = `${Math.round(slide.imageScale * 100)}%`;
    scheduleSave();
  });
  app.querySelector('[data-action="reset-photo"]')?.addEventListener("click", () => {
    const slide = activeSlide();
    if (!slide) return;
    slide.imageScale = 1;
    slide.imageX = 0;
    slide.imageY = 0;
    updateStageImage(slide);
    if (photoZoom) photoZoom.value = 1;
    const output = app.querySelector("#photo-zoom-output");
    if (output) output.textContent = "100%";
    scheduleSave();
  });
}

function refreshSelection() {
  app.querySelectorAll(".text-box").forEach((box) => {
    box.classList.toggle("is-selected", box.dataset.textId === state.selectedTextId);
  });
  const currentInspector = app.querySelector(".inspector");
  if (currentInspector) {
    currentInspector.outerHTML = renderInspector();
    app.querySelector('[data-action="add-text"]')?.addEventListener("click", addText);
    app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
    app.querySelector('[data-action="delete-slide"]')?.addEventListener("click", deleteActiveSlide);
    bindInspectorControls();
  }
}

function sizeStage() {
  const inner = app.querySelector(".workspace-inner");
  const stage = app.querySelector(".stage");
  const slide = activeSlide();
  if (!inner || !stage || !slide) return;
  const availableWidth = inner.clientWidth;
  const availableHeight = inner.clientHeight;
  const ratio = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  let width = availableWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }
  state.stageWidth = width;
  state.stageHeight = height;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.setProperty("--stage-scale", width / OUTPUT_WIDTH);
  updateStageImage(slide);
  activeSlide().texts.forEach(updateTextBox);
}

function getImageLayout(slide, canvasWidth, canvasHeight) {
  const zoom = slide.imageScale || 1;
  const coverScale = Math.max(canvasWidth / slide.width, canvasHeight / slide.height);
  const scale = coverScale * zoom;
  const width = slide.width * scale;
  const height = slide.height * scale;
  const maxOffsetX = Math.max(0, (width - canvasWidth) / (2 * canvasWidth));
  const maxOffsetY = Math.max(0, (height - canvasHeight) / (2 * canvasHeight));
  const offsetX = clamp(slide.imageX || 0, -maxOffsetX, maxOffsetX);
  const offsetY = clamp(slide.imageY || 0, -maxOffsetY, maxOffsetY);
  return {
    width,
    height,
    left: (canvasWidth - width) / 2 + offsetX * canvasWidth,
    top: (canvasHeight - height) / 2 + offsetY * canvasHeight,
    maxOffsetX,
    maxOffsetY,
  };
}

function constrainImagePosition(slide) {
  const canvasWidth = state.stageWidth || OUTPUT_WIDTH;
  const canvasHeight = state.stageHeight || OUTPUT_HEIGHT;
  const layout = getImageLayout(slide, canvasWidth, canvasHeight);
  slide.imageX = clamp(slide.imageX || 0, -layout.maxOffsetX, layout.maxOffsetX);
  slide.imageY = clamp(slide.imageY || 0, -layout.maxOffsetY, layout.maxOffsetY);
}

function updateStageImage(slide) {
  const image = app.querySelector(".stage-image");
  if (!image || !state.stageWidth || !state.stageHeight) return;
  const layout = getImageLayout(slide, state.stageWidth, state.stageHeight);
  image.style.width = `${layout.width}px`;
  image.style.height = `${layout.height}px`;
  image.style.left = `${layout.left}px`;
  image.style.top = `${layout.top}px`;
}

function updateTextBox(text) {
  const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
  if (!box) return;
  box.style.left = `${text.x * 100}%`;
  box.style.top = `${text.y * 100}%`;
  box.style.width = `${text.width * 100}%`;
  box.style.height = `${text.height * 100}%`;
  box.dataset.style = text.style;
  box.dataset.background = text.background || "white";
  box.dataset.boxShape = text.backgroundShape || "lines";
  box.style.setProperty("--outline-width", `${(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH) * (state.stageWidth / DESIGN_WIDTH)}px`);
  const content = box.querySelector(".text-content");
  content.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
  if (!box.classList.contains("is-editing")) content.textContent = text.text;
}

function ensureTextFits(text) {
  requestAnimationFrame(() => {
    const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
    const contentWrap = box?.querySelector(".text-content-wrap");
    if (!box || !contentWrap || !state.stageHeight) return;
    const previousMaxHeight = contentWrap.style.maxHeight;
    contentWrap.style.maxHeight = "none";
    const neededPixels = contentWrap.scrollHeight + 4;
    contentWrap.style.maxHeight = previousMaxHeight;
    if (neededPixels <= box.clientHeight) return;

    const nextHeight = Math.min(1, neededPixels / state.stageHeight);
    text.y = Math.min(text.y, 1 - nextHeight);
    text.height = nextHeight;
    box.style.top = `${text.y * 100}%`;
    box.style.height = `${text.height * 100}%`;
    scheduleSave();
  });
}

function addText() {
  const slide = activeSlide();
  if (!slide) return;
  const text = {
    id: uid(),
    text: "Your text",
    x: 0.18,
    y: 0.42,
    width: 0.64,
    height: 0.13,
    size: 64,
    style: "outline",
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
    background: "white",
    backgroundShape: "lines",
  };
  state.photoAdjustMode = false;
  slide.texts.push(text);
  state.selectedTextId = text.id;
  state.mobileInspectorOpen = true;
  scheduleSave();
  renderEditor();
  requestAnimationFrame(() => app.querySelector("#text-value")?.select());
}

function deleteSelectedText() {
  const slide = activeSlide();
  if (!slide || !state.selectedTextId) return;
  slide.texts = slide.texts.filter((text) => text.id !== state.selectedTextId);
  state.selectedTextId = null;
  scheduleSave();
  renderEditor();
}

async function deleteActiveSlide() {
  const project = activeProject();
  const slide = activeSlide();
  if (!project || !slide) return;
  const confirmed = window.confirm(`Remove “${slide.name}” from this project?`);
  if (!confirmed) return;
  const index = project.slides.findIndex((item) => item.id === slide.id);
  project.slides.splice(index, 1);
  state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
  state.selectedTextId = null;
  scheduleSave();
  renderEditor();
}

function bindTextBox(box) {
  const content = box.querySelector(".text-content");
  box.addEventListener("pointerdown", (event) => {
    if (box.classList.contains("is-editing")) return;
    const corner = event.target.dataset.corner;
    state.selectedTextId = box.dataset.textId;
    refreshSelection();
    if (corner) beginResize(event, box, corner);
    else beginDrag(event, box);
  });
  box.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    state.selectedTextId = box.dataset.textId;
    box.classList.add("is-editing", "is-selected");
    content.contentEditable = "true";
    content.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  content.addEventListener("input", () => {
    const text = selectedText();
    if (!text) return;
    text.text = content.innerText.replace(/\n$/, "");
    const textarea = app.querySelector("#text-value");
    if (textarea) textarea.value = text.text;
    ensureTextFits(text);
    scheduleSave();
  });
  content.addEventListener("blur", () => {
    content.contentEditable = "false";
    box.classList.remove("is-editing");
  });
  box.addEventListener("keydown", (event) => {
    if ((event.key === "Backspace" || event.key === "Delete") && !box.classList.contains("is-editing")) {
      event.preventDefault();
      deleteSelectedText();
    }
    if (event.key === "Enter" && !box.classList.contains("is-editing")) {
      event.preventDefault();
      box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
  });
}

function beginDrag(event, box) {
  event.preventDefault();
  const text = selectedText();
  if (!text) return;
  box.classList.add("is-dragging");
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = { clientX: event.clientX, clientY: event.clientY, x: text.x, y: text.y };
  const move = (moveEvent) => {
    text.x = clamp(start.x + (moveEvent.clientX - start.clientX) / state.stageWidth, 0, 1 - text.width);
    text.y = clamp(start.y + (moveEvent.clientY - start.clientY) / state.stageHeight, 0, 1 - text.height);
    updateTextBox(text);
    scheduleSave();
  };
  const end = () => {
    box.classList.remove("is-dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginResize(event, box, corner) {
  event.preventDefault();
  event.stopPropagation();
  const text = selectedText();
  if (!text) return;
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: text.x,
    y: text.y,
    width: text.width,
    height: text.height,
  };
  const minWidth = 0.1;
  const minHeight = 0.045;
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.clientX) / state.stageWidth;
    const dy = (moveEvent.clientY - start.clientY) / state.stageHeight;
    let nextX = start.x;
    let nextY = start.y;
    let nextWidth = start.width;
    let nextHeight = start.height;

    if (corner.includes("e")) nextWidth = clamp(start.width + dx, minWidth, 1 - start.x);
    if (corner.includes("s")) nextHeight = clamp(start.height + dy, minHeight, 1 - start.y);
    if (corner.includes("w")) {
      nextX = clamp(start.x + dx, 0, start.x + start.width - minWidth);
      nextWidth = start.width + (start.x - nextX);
    }
    if (corner.includes("n")) {
      nextY = clamp(start.y + dy, 0, start.y + start.height - minHeight);
      nextHeight = start.height + (start.y - nextY);
    }
    text.x = nextX;
    text.y = nextY;
    text.width = nextWidth;
    text.height = nextHeight;
    updateTextBox(text);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginImageDrag(event, stage) {
  event.preventDefault();
  const slide = activeSlide();
  if (!slide) return;
  stage.classList.add("is-moving-photo");
  try { stage.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    imageX: slide.imageX || 0,
    imageY: slide.imageY || 0,
  };
  const move = (moveEvent) => {
    slide.imageX = start.imageX + (moveEvent.clientX - start.clientX) / state.stageWidth;
    slide.imageY = start.imageY + (moveEvent.clientY - start.clientY) / state.stageHeight;
    constrainImagePosition(slide);
    updateStageImage(slide);
    scheduleSave();
  };
  const end = () => {
    stage.classList.remove("is-moving-photo");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function handleUpload(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  const project = activeProject();
  if (!project) return;
  const button = app.querySelector('[data-action="upload"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Adding…";
  }
  try {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const imageData = await fileToDataUrl(file);
      const dimensions = await getImageDimensions(imageData);
      project.slides.push({
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ""),
        imageData,
        width: dimensions.width,
        height: dimensions.height,
        imageScale: 1,
        imageX: 0,
        imageY: 0,
        texts: [],
      });
    }
    if (!state.activeSlideId) state.activeSlideId = project.slides[0]?.id || null;
    await putProject(project);
    toast(`${files.length} ${files.length === 1 ? "photo" : "photos"} added`);
    renderEditor();
  } catch (error) {
    console.error(error);
    toast("One of those photos couldn’t be added.");
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function exportActiveSlide() {
  const slide = activeSlide();
  if (!slide) return;
  const exportButton = app.querySelector('[data-action="export"]');
  const oldLabel = exportButton?.innerHTML;
  if (exportButton) {
    exportButton.disabled = true;
    exportButton.textContent = "Rendering…";
  }
  try {
    await document.fonts.load('700 64px "TikTok Sans"');
    const image = await loadImage(slide.imageData);
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_WIDTH;
    canvas.height = OUTPUT_HEIGHT;
    const context = canvas.getContext("2d");
    const imageLayout = getImageLayout(slide, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    context.drawImage(image, imageLayout.left, imageLayout.top, imageLayout.width, imageLayout.height);
    slide.texts.forEach((text) => drawTextLayer(context, text, OUTPUT_WIDTH, OUTPUT_HEIGHT));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
    if (!blob) throw new Error("Could not create PNG");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(activeProject().name)}-${safeFilename(slide.name)}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("PNG downloaded at full resolution");
  } catch (error) {
    console.error(error);
    toast("The image couldn’t be downloaded.");
  } finally {
    if (exportButton) {
      exportButton.disabled = false;
      exportButton.innerHTML = oldLabel;
    }
  }
}

function drawTextLayer(context, text, imageWidth, imageHeight) {
  const x = text.x * imageWidth;
  const y = text.y * imageHeight;
  const width = text.width * imageWidth;
  const height = text.height * imageHeight;
  const exportScale = imageWidth / DESIGN_WIDTH;
  const fontSize = text.size * exportScale;
  const lineHeight = fontSize * 1.05;
  const horizontalPadding = text.style === "boxed" ? fontSize * 0.26 : fontSize * 0.16;
  const verticalPadding = fontSize * 0.1;
  context.save();
  context.font = `760 ${fontSize}px "TikTok Sans"`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const lines = wrapText(context, text.text, Math.max(1, width - horizontalPadding * 2));
  const visibleLineCount = Math.max(1, Math.floor((height - verticalPadding * 2) / lineHeight));
  const visibleLines = lines.slice(0, visibleLineCount);
  const blockHeight = visibleLines.length * lineHeight;
  const startY = y + (height - blockHeight) / 2 + lineHeight / 2;

  if (text.style === "boxed" && text.backgroundShape === "full") {
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    roundedRect(context, x, y, width, height, Math.min(fontSize * 0.18, width / 2, height / 2));
    context.fill();
  }

  visibleLines.forEach((line, index) => {
    const lineY = startY + index * lineHeight;
    if (text.style === "boxed" && text.backgroundShape !== "full" && line) {
      const backgroundWidth = Math.min(width, context.measureText(line).width + horizontalPadding * 2);
      const backgroundHeight = lineHeight * 0.98;
      context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
      roundedRect(
        context,
        x + (width - backgroundWidth) / 2,
        lineY - backgroundHeight / 2,
        backgroundWidth,
        backgroundHeight,
        Math.min(fontSize * 0.14, backgroundHeight / 2),
      );
      context.fill();
    }
    if (text.style === "outline") {
      context.strokeStyle = "#111111";
      context.lineWidth = (text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH) * exportScale;
      context.strokeText(line, x + width / 2, lineY);
      context.fillStyle = "#ffffff";
      context.fillText(line, x + width / 2, lineY);
    } else {
      context.fillStyle = text.style === "boxed" && text.background !== "black" ? "#111111" : "#ffffff";
      context.fillText(line, x + width / 2, lineY);
    }
  });
  context.restore();
}

function wrapText(context, value, maxWidth) {
  const paragraphs = String(value || " ").split("\n");
  const lines = [];
  paragraphs.forEach((paragraph) => {
    if (paragraph === "") {
      lines.push("");
      return;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width <= maxWidth) {
        line = test;
      } else if (line) {
        lines.push(line);
        line = word;
      } else {
        const characters = [...word];
        let chunk = "";
        characters.forEach((character) => {
          if (context.measureText(chunk + character).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        });
        line = chunk;
      }
    });
    lines.push(line);
  });
  return lines;
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function safeFilename(value) {
  return String(value || "slide")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "slide";
}

async function init() {
  try {
    state.db = await openDatabase();
    state.projects = await getAllProjects();
    state.projects.forEach((project) => project.slides.forEach((slide) => {
      if (slide.imageScale == null) slide.imageScale = 1;
      if (slide.imageX == null) slide.imageX = 0;
      if (slide.imageY == null) slide.imageY = 0;
      slide.texts.forEach((text) => {
        if (text.outlineWidth == null) text.outlineWidth = DEFAULT_OUTLINE_WIDTH;
        if (!text.background) text.background = "white";
        if (!text.backgroundShape) text.backgroundShape = "full";
      });
    }));
  } catch (error) {
    console.error(error);
    state.projects = [];
    toast("Browser storage is unavailable. Projects won’t persist.");
  }
  renderDashboard();
  bindGlobalActions();
}

init();
