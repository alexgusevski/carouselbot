import {
  DESIGN_WIDTH,
  DEFAULT_OUTLINE_WIDTH,
  SUPPORTED_ASPECT_RATIOS,
  TEXT_LINE_HEIGHT,
  BOX_TEXT_LINE_HEIGHT,
  BOX_LINE_HEIGHT,
  BOX_HORIZONTAL_PADDING,
  BOX_BACKGROUND_VERTICAL_OFFSET,
  TEXT_BOX_EDGE_PADDING,
  BOX_CORNER_RADIUS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_SLIDER_MAX,
  FONT_SIZE_SLIDER_STEP,
  TEXT_COLOR_PRESETS,
  escapeHtml,
  textColor,
  formatRgb,
  outlineColorFor,
  overlayCrop,
  textAlignment,
  layerClipCss,
  slideItems,
  sliderPositionFromFontSize,
  formatFontSize,
  getImageLayout,
  projectCanvasDimensions,
  slideCanvasDimensions,
  perLineBackgroundSvgPath,
  wrapText,
} from "./editor-model.mjs";
import {
  state,
  app,
  activeProject,
  activeSlide,
  slideThumbnailKey,
  selectedText,
  selectedOverlay,
  isLayerSelected,
  selectedLayers,
  projectAsset,
  getOverlayMetrics,
  overlayClipCss,
} from "./editor-state.mjs";
import {
  isTextFontAvailable,
  isTextFontLoaded,
  textCanvasFont,
  textCssFontFamily,
  textFontLabel,
  textFontStyle,
  textFontVariationCss,
  textFontWeight,
} from "./project-fonts.mjs";

export function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function icon(name) {
  const icons = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    airdrop: '<img class="airdrop-icon" src="/assets/airdrop.svg" alt="" />',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m7 7 1 14h8l1-14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v6h-6"/></svg>',
    "align-left": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h11M4 14h16M4 18h9"/></svg>',
    "align-center": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M6.5 10h11M4 14h16M7.5 18h9"/></svg>',
    "align-right": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M9 10h11M4 14h16M11 18h9"/></svg>',
    front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    "send-back": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 13 5 5 5-5"/><path d="m7 6 5 5 5-5"/></svg>',
    crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14"/><path d="M12 5v14"/><path d="M8 19h8"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 4.5-4 3.5 3 3-2.5 5 4.5"/></svg>',
    adjust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h7"/><path d="M15 7h5"/><circle cx="13" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/></svg>',
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 6h4"/><path d="M10 17.5h4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  };
  return icons[name] || "";
}

export function renderHeader({ editor = false } = {}) {
  const project = activeProject();
  const agentConnectButton = `
    <button class="button button--quiet agent-connect-button" type="button" data-action="connect-agent" aria-label="Connect via MCP" title="Connect via MCP">
      <span class="agent-logo-stack" aria-hidden="true">
        <img src="/assets/claude-ai-icon-f3a857f4.svg" alt="" />
        <img src="/assets/codex-logo-colored-53743834.svg" alt="" />
        <img src="/assets/hermes-agent-icon-e5340726.webp" alt="" />
      </span>
      <span class="agent-connect-label">Connect AI</span>
      <span class="agent-connect-dot" aria-hidden="true"></span>
    </button>`;
  return `
    <header class="app-header${editor ? " app-header--editor" : ""}">
      <a class="brand" href="/" data-action="home" aria-label="Go to projects">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-copy"><strong>CarouselBot</strong><small>AI carousel maker</small></span>
      </a>
      ${editor && project ? `
        <div class="project-identity">
          <input class="project-title-input" value="${escapeHtml(project.name)}" aria-label="Project name" maxlength="64" />
        </div>
      ` : ""}
      <div class="header-actions">
        ${editor ? `
          <button class="button button--quiet share-button" type="button" data-action="share" aria-label="AirDrop current slide" title="AirDrop current slide" ${activeSlide() ? "" : "disabled"}>
            ${icon("airdrop")} <span>AirDrop</span>
          </button>
          <button class="button button--quiet share-button" type="button" data-action="share-all" aria-label="AirDrop all slides" title="AirDrop all slides" ${project.slides.length ? "" : "disabled"}>
            ${icon("airdrop")} <span>AirDrop all</span>
          </button>
          ${agentConnectButton}
          <button class="button button--quiet" type="button" data-action="export" aria-label="Download current slide as PNG" title="Download PNG" ${activeSlide() ? "" : "disabled"}>
            ${icon("download")} <span>PNG</span>
          </button>
        ` : `${agentConnectButton}<button class="button button--primary" type="button" data-action="new-project">New project</button>`}
        <a class="icon-button github-link" href="https://github.com/alexgusevski/carouselbot" target="_blank" rel="noopener noreferrer" aria-label="Open CarouselBot on GitHub" title="Open GitHub repository"><img class="github-mark" src="/assets/Octicons-mark-github.svg" alt="" /></a>
      </div>
    </header>
  `;
}

export function renderLegacyMigrationNotice(projects, migrationController, dismissed = false) {
  if (!migrationController.isLegacyOrigin || !migrationController.config.enabled || dismissed) return "";
  const completed = migrationController.completedMigration();
  const count = projects.length;
  const pending = migrationController.hasPendingProjects(projects);
  const detail = completed && !pending
    ? `Your ${completed.projectCount === 1 ? "project has" : "projects have"} already been copied. The originals are still safe in this browser.`
    : count
      ? `${completed ? "Some projects changed since your last copy. " : ""}We found ${count} ${count === 1 ? "project" : "projects"} in this browser. Copying them will not remove anything from this site.`
      : "There are no projects saved in this browser, so you can head straight to the new site.";
  return `
    <div class="migration-modal-backdrop" data-migration-modal>
      <section class="migration-modal" role="dialog" aria-modal="true" aria-labelledby="migration-modal-title" aria-describedby="migration-modal-description migration-modal-status">
        <button class="migration-modal-close" type="button" data-action="close-migration-modal" aria-label="Close migration notice" title="Close">
          <span aria-hidden="true">×</span>
        </button>
        <p class="eyebrow">Slide Studio has moved</p>
        <h2 id="migration-modal-title">Meet CarouselBot.</h2>
        <p id="migration-modal-description" class="migration-modal-description">
          This project now lives at <strong>carousel.bot</strong>. It is still free and
          <a href="https://github.com/alexgusevski/carouselbot" target="_blank" rel="noopener noreferrer">open source</a>.
        </p>
        <p id="migration-modal-status" class="migration-modal-status" data-migration-status>${escapeHtml(detail)}</p>
        <div class="migration-actions">
          ${pending ? `<button class="button button--primary" type="button" data-action="migrate-projects">${completed ? "Copy changed projects" : `Copy ${count === 1 ? "my project" : `my ${count} projects`}`}</button>` : ""}
          <a class="button button--quiet" href="${escapeHtml(migrationController.config.canonicalOrigin)}" target="_blank" rel="noopener">${pending ? "Open without copying" : "Open carousel.bot"}</a>
        </div>
      </section>
    </div>`;
}

export function renderSlideRail(project) {
  return `
    <aside class="slide-rail">
      <div class="rail-heading"><h2>Slides</h2><span>${project.slides.length}</span></div>
      <div class="slide-list">
        ${project.slides.map((slide, index) => {
          const canvas = slideCanvasDimensions(project, slide);
          return `
            <button class="slide-thumb ${slide.id === state.activeSlideId ? "is-active" : ""}" type="button" data-slide-id="${slide.id}" draggable="true" aria-haspopup="menu" aria-label="Open slide ${index + 1}. Drag to reorder. Right-click for actions." title="Drag to reorder · Right-click for actions">
              <span class="slide-number">${String(index + 1).padStart(2, "0")}</span>
              <span class="thumb-image" data-thumbnail-slide-id="${slide.id}" data-thumbnail-project-id="${project.id}" style="aspect-ratio:${canvas.width} / ${canvas.height}">${renderSlideThumbnail(slide, project)}</span>
            </button>
          `;
        }).join("")}
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload">${icon("plus")}<span>New slide</span></button></div>
    </aside>
  `;
}

export function renderSlideThumbnail(slide, project = activeProject()) {
  const source = state.thumbnailUrls.get(slideThumbnailKey(project?.id, slide.id));
  return source
    ? `<img class="thumb-rendered" src="${source}" alt="" draggable="false" decoding="async" aria-hidden="true" />`
    : `<span class="thumb-rendering-placeholder" aria-hidden="true"><span></span></span>`;
}

export function renderAssetRail(project) {
  const assets = project.assets || [];
  return `
    <aside class="asset-rail">
      <div class="rail-heading"><h2>Assets</h2><span>${assets.length}</span></div>
      <div class="asset-grid" aria-label="Uploaded assets">
        ${assets.length ? assets.map((asset) => `
          <div class="asset-item" data-asset-id="${asset.id}" draggable="true" title="${escapeHtml(asset.name)}">
            <img src="${asset.imageData}" alt="${escapeHtml(asset.name)}" draggable="false" />
            <button class="asset-remove" type="button" data-action="delete-asset" data-asset-id="${asset.id}" aria-label="Remove ${escapeHtml(asset.name)}">×</button>
          </div>
        `).join("") : `<p class="asset-empty">Upload logos, stickers, or extra photos. Drag them onto a photo to place them.</p>`}
      </div>
      <div class="asset-trash" data-asset-trash>
        ${icon("trash")}
        <span>Drag here to delete</span>
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload-assets">${icon("plus")}<span>Upload assets</span></button></div>
    </aside>
  `;
}

export function renderEmptyStage(project = activeProject()) {
  const canvas = projectCanvasDimensions(project);
  const aspectRatios = SUPPORTED_ASPECT_RATIOS.includes(canvas.aspectRatio)
    ? SUPPORTED_ASPECT_RATIOS
    : [canvas.aspectRatio, ...SUPPORTED_ASPECT_RATIOS];
  return `
    <div class="empty-stage">
      <div>
        <div class="empty-stage-graphic" aria-hidden="true"></div>
        <h2>Add your first photos</h2>
        <p>Choose one or several images from your computer. Each one becomes a slide.</p>
        <label class="empty-stage-format" for="project-aspect-ratio">
          <span>Canvas format</span>
          <select id="project-aspect-ratio" aria-describedby="project-aspect-ratio-help">
            ${aspectRatios.map((aspectRatio) => {
              const dimensions = projectCanvasDimensions({ aspectRatio });
              return `<option value="${escapeHtml(aspectRatio)}" ${aspectRatio === canvas.aspectRatio ? "selected" : ""}>${escapeHtml(aspectRatio)} · ${dimensions.width} × ${dimensions.height}</option>`;
            }).join("")}
          </select>
          <small id="project-aspect-ratio-help">Default for solid slides. Uploaded images keep their own shape.</small>
        </label>
        <button class="button button--primary" type="button" data-action="upload">Choose photos</button>
      </div>
    </div>
  `;
}

export function renderStage(slide, project = activeProject()) {
  const canvas = slideCanvasDimensions(project, slide);
  const aspectRatios = SUPPORTED_ASPECT_RATIOS.includes(canvas.aspectRatio)
    ? SUPPORTED_ASPECT_RATIOS
    : [canvas.aspectRatio, ...SUPPORTED_ASPECT_RATIOS];
  const supportsTikTokOverlay = canvas.aspectRatio === "9:16";
  return `
    <div class="canvas-composition">
      <div class="stage-wrap">
        <div class="tiktok-screen-preview ${supportsTikTokOverlay ? "is-native-format" : "has-letterbox"}" aria-label="9:16 TikTok screen preview. Black area is outside the slide and is not exported.">
          <div class="stage-frame ${selectedLayers().length > 1 ? "has-multi-selection" : ""} ${state.photoAdjustMode ? "is-adjusting-photo" : ""}">
            <img class="stage-image-ghost" src="${slide.imageData}" alt="" draggable="false" aria-hidden="true" />
            <div class="stage ${state.photoAdjustMode ? "is-adjusting" : ""}" data-natural-width="${slide.width}" data-natural-height="${slide.height}">
              <img class="stage-image" src="${slide.imageData}" alt="${escapeHtml(slide.name)}" draggable="false" />
              ${supportsTikTokOverlay ? renderTikTokOverlay() : ""}
            </div>
            <div class="layer-stack">
              ${slideItems(slide).map(({ kind, item }) => (kind === "overlay" ? renderOverlayBox(item) : renderTextBox(item))).join("")}
            </div>
          </div>
        </div>
        ${supportsTikTokOverlay ? "" : `<span class="tiktok-screen-note">9:16 preview · black not exported</span>`}
        <span class="stage-dimensions">
          <span class="stage-size-label">${canvas.width} × ${canvas.height} · ${escapeHtml(canvas.aspectRatio)}</span>
          <label class="slide-format-control" for="slide-aspect-ratio">
            <span>Format</span>
            <select id="slide-aspect-ratio" aria-label="Slide format">
              ${aspectRatios.map((aspectRatio) => `<option value="${escapeHtml(aspectRatio)}" ${aspectRatio === canvas.aspectRatio ? "selected" : ""}>${escapeHtml(aspectRatio)}</option>`).join("")}
            </select>
          </label>
          <span class="canvas-zoom-controls" aria-label="Canvas zoom">
            <button class="canvas-zoom-button" type="button" data-action="canvas-zoom-out" aria-label="Zoom canvas out">−</button>
            <button class="canvas-zoom-level" type="button" data-action="canvas-zoom-reset" title="Reset canvas zoom">${Math.round(state.canvasZoom * 100)}%</button>
            <button class="canvas-zoom-button" type="button" data-action="canvas-zoom-in" aria-label="Zoom canvas in">+</button>
          </span>
        </span>
      </div>
      ${renderCanvasActions(project, slide)}
    </div>
  `;
}

export function renderCanvasActions(project = activeProject(), slide = activeSlide()) {
  const supportsTikTokOverlay = slideCanvasDimensions(project, slide).aspectRatio === "9:16";
  return `
    <div class="canvas-actions" aria-label="Canvas actions">
      <button class="canvas-action" type="button" data-action="add-text" title="Add text">${icon("text")}<span>Text</span></button>
      <button class="canvas-action" type="button" data-action="upload-assets" title="Add image">${icon("image")}<span>Image</span></button>
      <button class="canvas-action ${state.photoAdjustMode ? "is-active" : ""}" type="button" data-action="adjust-photo" aria-pressed="${state.photoAdjustMode}" title="Adjust photo">${icon("adjust")}<span>Adjust photo</span></button>
      <button class="canvas-action ${supportsTikTokOverlay && state.showTikTokOverlay ? "is-active" : ""}" type="button" data-action="toggle-tiktok-overlay" aria-pressed="${supportsTikTokOverlay && state.showTikTokOverlay}" title="${supportsTikTokOverlay ? "Toggle TikTok UI overlay" : "TikTok UI preview is available for 9:16 canvases"}" ${supportsTikTokOverlay ? "" : "disabled"}>${icon("preview")}<span>Overlay</span></button>
    </div>
  `;
}

export function renderTikTokOverlay() {
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

export function renderOverlayBox(overlay) {
  const asset = projectAsset(overlay.assetId);
  if (!asset) return "";
  const selected = isLayerSelected("overlay", overlay.id);
  const cropping = overlay.id === state.croppingOverlayId;
  const metrics = getOverlayMetrics(overlay, asset);
  const crop = overlayCrop(overlay);
  const imageStyle = cropping
    ? "width:100%;height:100%;left:0;top:0;"
    : `width:${100 / crop.w}%;height:${100 / crop.h}%;left:${(-crop.x / crop.w) * 100}%;top:${(-crop.y / crop.h) * 100}%;`;
  return `
    <div
      class="overlay-box ${selected ? "is-selected" : ""} ${cropping ? "is-cropping" : ""}"
      data-overlay-id="${overlay.id}"
      style="left:${overlay.x * 100}%;top:${overlay.y * 100}%;width:${metrics.width * 100}%;height:${metrics.height * 100}%;transform:rotate(${overlay.rotation || 0}deg);"
      tabindex="0"
      aria-label="Photo overlay: ${escapeHtml(asset.name)}"
    >
      <div class="overlay-image-clip overlay-image-clip--outside"><img src="${asset.imageData}" alt="" draggable="false" style="${imageStyle}" /></div>
      <div class="overlay-image-clip overlay-image-clip--inside" style="clip-path:${overlayClipCss(overlay, asset)}"><img src="${asset.imageData}" alt="" draggable="false" style="${imageStyle}" /></div>
      ${cropping ? `
        <div class="crop-rect" style="left:${crop.x * 100}%;top:${crop.y * 100}%;width:${crop.w * 100}%;height:${crop.h * 100}%;">
          <span class="crop-handle" data-crop="nw"></span>
          <span class="crop-handle" data-crop="n"></span>
          <span class="crop-handle" data-crop="ne"></span>
          <span class="crop-handle" data-crop="e"></span>
          <span class="crop-handle" data-crop="se"></span>
          <span class="crop-handle" data-crop="s"></span>
          <span class="crop-handle" data-crop="sw"></span>
          <span class="crop-handle" data-crop="w"></span>
        </div>
      ` : `
        <span class="rotate-handle" data-rotate="true" aria-hidden="true">${icon("rotate")}</span>
        <span class="edge-resize-handle" data-edge="n" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="e" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="s" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="w" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
      `}
    </div>
  `;
}

export function renderTextBox(text) {
  const project = activeProject();
  const selected = isLayerSelected("text", text.id);
  const background = text.background || "white";
  const backgroundShape = text.backgroundShape || "lines";
  const color = textColor(text);
  const outlineColor = outlineColorFor(color);
  const fontMissing = Boolean(text.fontId && !isTextFontAvailable(project, text));
  const fontLoading = Boolean(text.fontId && !fontMissing && !isTextFontLoaded(project, text));
  const fontFamily = escapeHtml(textCssFontFamily(project, text));
  const fontWeight = textFontWeight(project, text);
  const fontStyle = textFontStyle(project, text);
  const fontVariations = escapeHtml(textFontVariationCss(project, text));
  return `
    <div
      class="text-box ${selected ? "is-selected" : ""} ${fontMissing ? "is-font-missing" : ""} ${fontLoading ? "is-font-loading" : ""}"
      data-text-id="${text.id}"
      data-style="${text.style}"
      data-background="${background}"
      data-box-shape="${backgroundShape}"
      data-align="${textAlignment(text)}"
      style="left:${text.x * 100}%;top:${text.y * 100}%;width:${text.width * 100}%;height:${text.height * 100}%;transform:rotate(${text.rotation || 0}deg);--text-color:${color};--outline-color:${outlineColor};--box-text-line-height:${BOX_TEXT_LINE_HEIGHT}em;--box-horizontal-padding:${BOX_HORIZONTAL_PADDING}em;--text-font-family:${fontFamily};--text-font-weight:${fontWeight};--text-font-style:${fontStyle};--text-font-variations:${fontVariations};"
      tabindex="0"
      aria-label="Text layer: ${escapeHtml(text.text)}"
    >
      <div class="text-visual text-visual--outside" aria-hidden="true">
        <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      </div>
      <div class="text-visual text-visual--inside" style="clip-path:${layerClipCss(text.x, text.y, text.width, text.height)}">
        <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      </div>
      <span class="rotate-handle" data-rotate="true" aria-hidden="true">${icon("rotate")}</span>
      <span class="edge-resize-handle" data-edge="n" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="e" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="s" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="w" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
      ${fontMissing ? `<span class="missing-font-badge" title="${escapeHtml(textFontLabel(project, text))} is unavailable">Missing font</span>` : ""}
    </div>
  `;
}

export function renderInspector() {
  const text = selectedText();
  const overlay = selectedOverlay();
  const selectionCount = selectedLayers().length;
  const multiMode = selectionCount > 1;
  const overlayAsset = overlay ? projectAsset(overlay.assetId) : null;
  const slide = activeSlide();
  const photoMode = Boolean(state.photoAdjustMode && slide);
  const overlayMode = Boolean(!photoMode && !multiMode && overlay);
  const color = textColor(text);
  return `
    <aside class="inspector ${state.mobileInspectorOpen ? "is-mobile-open" : ""}">
      <div class="inspector-header">
        <h2>${photoMode ? "Photo settings" : multiMode ? `${selectionCount} layers selected` : overlayMode && state.croppingOverlayId === overlay.id ? "Crop" : overlayMode ? "Overlay" : text ? "Text settings" : "Text"}</h2>
        ${multiMode ? `<button class="icon-button" type="button" data-action="delete-selection" aria-label="Delete selected layers">${icon("trash")}</button>` : ((text && !photoMode && !overlayMode) || overlayMode) ? `<button class="icon-button" type="button" data-action="${overlayMode ? "delete-overlay" : "delete-text"}" aria-label="${overlayMode ? "Delete overlay" : "Delete text"}">${icon("trash")}</button>` : ""}
      </div>
      ${photoMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="photo-zoom">Zoom <output id="photo-zoom-output">${Math.round((slide.imageScale || 1) * 100)}%</output></label>
            <input id="photo-zoom" type="range" min="1" max="3" step="0.01" value="${slide.imageScale || 1}" />
          </div>
          <button class="button button--quiet reset-photo-button" type="button" data-action="reset-photo">Reset photo</button>
        </div>
      ` : multiMode ? "" : overlayMode && state.croppingOverlayId === overlay.id ? `
        <div class="inspector-body">
          <button class="button button--primary" type="button" data-action="done-crop">Done</button>
        </div>
      ` : overlayMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <div class="control-label">File</div>
            <p class="overlay-asset-name">${escapeHtml(overlayAsset?.name || "Photo")}</p>
          </div>
          <div class="control-group">
            <label class="control-label" for="overlay-rotation">Rotate <output id="overlay-rotation-output">${Math.round(overlay.rotation || 0)}°</output></label>
            <div class="range-wrap">
              <input id="overlay-rotation" type="range" min="0" max="359" step="1" value="${Math.round(overlay.rotation || 0)}" />
              <input id="overlay-rotation-number" class="number-input" type="number" min="0" max="359" step="1" value="${Math.round(overlay.rotation || 0)}" aria-label="Rotation in degrees" />
            </div>
          </div>
        </div>
      ` : text ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="text-value">Words</label>
            <textarea id="text-value" class="text-input" maxlength="500" placeholder="Type something…">${escapeHtml(text.text)}</textarea>
          </div>
          <div class="control-group">
            <label class="control-label" for="text-font">Font</label>
            <select id="text-font" class="font-select" aria-label="Text font">
              <option value="" ${text.fontId ? "" : "selected"}>TikTok Sans</option>
              ${(activeProject()?.fonts || []).map((font) => `<option value="${escapeHtml(font.id)}" ${text.fontId === font.id ? "selected" : ""}>${escapeHtml(font.fullName || `${font.family} ${font.subfamily || ""}`.trim())}</option>`).join("")}
              <option value="__add_local_font__">Add font from Mac…</option>
            </select>
            ${text.fontId && !isTextFontAvailable(activeProject(), text) ? `<p class="font-warning">${escapeHtml(textFontLabel(activeProject(), text))} is unavailable on this device.</p>` : ""}
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
            <label class="control-label" for="font-size">Size <output>${formatFontSize(text.size)} px</output></label>
            <div class="range-wrap">
              <input id="font-size" type="range" min="0" max="${FONT_SIZE_SLIDER_MAX}" step="${FONT_SIZE_SLIDER_STEP}" value="${sliderPositionFromFontSize(text.size)}" aria-valuetext="${formatFontSize(text.size)} pixels" />
              <input id="font-size-number" class="number-input" type="number" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="0.5" value="${formatFontSize(text.size)}" aria-label="Font size in pixels" />
            </div>
          </div>
          <div class="control-group color-control">
            <div class="control-label">Text color</div>
            <div class="color-presets" role="group" aria-label="Text color presets">
              ${TEXT_COLOR_PRESETS.map((preset) => `
                <button
                  class="color-preset color-preset--${preset.name.toLowerCase()} ${color === preset.value ? "is-active" : ""}"
                  type="button"
                  data-text-color="${preset.value}"
                  title="${preset.name} ${preset.value}"
                  aria-label="Use ${preset.name} text"
                  aria-pressed="${color === preset.value}"
                ></button>
              `).join("")}
            </div>
            <div class="color-custom">
              <label class="color-picker-wrap" for="text-color-picker">
                <input id="text-color-picker" type="color" value="${color}" aria-label="Choose a custom text color" />
                <span>Color wheel</span>
              </label>
              <div class="color-values">
                <div class="color-value-row">
                  <label for="text-color-hex">Hex</label>
                  <input id="text-color-hex" type="text" value="${color}" maxlength="7" spellcheck="false" aria-label="Text color hex value" />
                  <button type="button" data-copy-color="hex" aria-label="Copy hex color">Copy</button>
                </div>
                <div class="color-value-row">
                  <label for="text-color-rgb">RGB</label>
                  <input id="text-color-rgb" type="text" value="${formatRgb(color)}" spellcheck="false" aria-label="Text color RGB value" />
                  <button type="button" data-copy-color="rgb" aria-label="Copy RGB color">Copy</button>
                </div>
              </div>
            </div>
          </div>
          <div class="control-group">
            <div class="control-label">Alignment</div>
            <div class="alignment-options" role="group" aria-label="Text alignment">
              ${["left", "center", "right"].map((align) => `<button class="alignment-option ${textAlignment(text) === align ? "is-active" : ""}" type="button" data-text-align="${align}" aria-label="Align text ${align}" aria-pressed="${textAlignment(text) === align}">${icon(`align-${align}`)}</button>`).join("")}
            </div>
          </div>
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
        </div>
      ` : `
        <div class="inspector-empty"><span>T</span><p>${slide ? "Select text or an overlay, or add one to this photo." : "Add a photo to start placing text."}</p></div>
      `}
    </aside>
  `;
}

export function updateStageImage(slide) {
  const images = app.querySelectorAll(".stage-image, .stage-image-ghost");
  if (!images.length || !state.stageWidth || !state.stageHeight) return;
  const layout = getImageLayout(slide, state.stageWidth, state.stageHeight);
  images.forEach((image) => {
    image.style.width = `${layout.width}px`;
    image.style.height = `${layout.height}px`;
    image.style.left = `${layout.left}px`;
    image.style.top = `${layout.top}px`;
  });
}

export function updateTextBox(text) {
  const project = activeProject();
  const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
  if (!box) return;
  box.style.left = `${text.x * 100}%`;
  box.style.top = `${text.y * 100}%`;
  box.style.width = `${text.width * 100}%`;
  box.style.height = `${text.height * 100}%`;
  box.style.transform = `rotate(${text.rotation || 0}deg)`;
  box.dataset.style = text.style;
  box.dataset.background = text.background || "white";
  box.dataset.boxShape = text.backgroundShape || "lines";
  box.dataset.align = textAlignment(text);
  const fontMissing = Boolean(text.fontId && !isTextFontAvailable(project, text));
  const fontLoading = Boolean(text.fontId && !fontMissing && !isTextFontLoaded(project, text));
  box.classList.toggle("is-font-missing", fontMissing);
  box.classList.toggle("is-font-loading", fontLoading);
  let missingBadge = box.querySelector(".missing-font-badge");
  if (fontMissing && !missingBadge) {
    missingBadge = document.createElement("span");
    missingBadge.className = "missing-font-badge";
    missingBadge.textContent = "Missing font";
    box.appendChild(missingBadge);
  } else if (!fontMissing) missingBadge?.remove();
  if (missingBadge) missingBadge.title = `${textFontLabel(project, text)} is unavailable`;
  const color = textColor(text);
  box.style.setProperty("--text-color", color);
  box.style.setProperty("--outline-color", outlineColorFor(color));
  box.style.setProperty("--box-text-line-height", `${BOX_TEXT_LINE_HEIGHT}em`);
  box.style.setProperty("--box-horizontal-padding", `${BOX_HORIZONTAL_PADDING}em`);
  box.style.setProperty("--text-font-family", textCssFontFamily(project, text));
  box.style.setProperty("--text-font-weight", String(textFontWeight(project, text)));
  box.style.setProperty("--text-font-style", textFontStyle(project, text));
  box.style.setProperty("--text-font-variations", textFontVariationCss(project, text));
  const insideVisual = box.querySelector(".text-visual--inside");
  if (insideVisual) insideVisual.style.clipPath = layerClipCss(text.x, text.y, text.width, text.height);
  box.querySelectorAll(".text-content-wrap").forEach((contentWrap) => {
    contentWrap.style.textAlign = textAlignment(text);
  });
  box.querySelectorAll(".text-content").forEach((content) => {
    content.style.textAlign = textAlignment(text);
    content.style.alignItems = textAlignment(text) === "left" ? "flex-start" : textAlignment(text) === "right" ? "flex-end" : "center";
    content.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
    if (fontLoading) content.textContent = text.text;
    else paintTextContent(text, content, box);
  });
  const editor = box.querySelector(".text-editor");
  if (editor) {
    editor.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
    editor.style.textAlign = textAlignment(text);
  }
}

export const measureCanvas = typeof document === "undefined" ? null : document.createElement("canvas");

export function measureFont(text) {
  const fontSize = text.size * ((state.stageWidth || DESIGN_WIDTH) / DESIGN_WIDTH);
  const context = measureCanvas.getContext("2d");
  context.font = textCanvasFont(activeProject(), text, fontSize);
  if ("fontVariationSettings" in context) context.fontVariationSettings = textFontVariationCss(activeProject(), text);
  return { context, fontSize };
}

export function wrappedLinesForBox(text, box) {
  const { context, fontSize } = measureFont(text);
  const boxWidth = box?.clientWidth || (state.stageWidth || DESIGN_WIDTH) * text.width;
  const perLineBox = text.style === "boxed" && (text.backgroundShape || "lines") !== "full";
  const horizontalInset = perLineBox
    ? fontSize * (TEXT_BOX_EDGE_PADDING * 2 + BOX_HORIZONTAL_PADDING * 2)
    : fontSize * 0.32;
  const maxWidth = Math.max(1, boxWidth - horizontalInset);
  return { lines: wrapText(context, text.text, maxWidth), fontSize, context };
}

export function createPerLineBackground(text, widths, lineHeight, fontSize, contentWidth) {
  const namespace = "http://www.w3.org/2000/svg";
  const boxHeight = fontSize * BOX_LINE_HEIGHT;
  const radius = Math.min(fontSize * BOX_CORNER_RADIUS, boxHeight / 2);
  const height = (widths.length - 1) * lineHeight + boxHeight;
  const fill = text.background === "black" ? "#111111" : "#ffffff";
  const align = textAlignment(text);
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "text-background");
  svg.setAttribute("viewBox", `0 0 ${contentWidth} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.height = `${height}px`;
  svg.style.top = `${(lineHeight - boxHeight) / 2 + fontSize * BOX_BACKGROUND_VERTICAL_OFFSET}px`;

  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", perLineBackgroundSvgPath(widths, lineHeight, boxHeight, 0, contentWidth, align, radius));
  path.setAttribute("fill", fill);
  svg.appendChild(path);
  return svg;
}

export function paintTextContent(text, content, box) {
  const { lines, fontSize, context } = wrappedLinesForBox(text, box);
  const perLineBox = text.style === "boxed" && (text.backgroundShape || "lines") !== "full";
  const lineHeight = fontSize * (perLineBox ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT);
  const padX = fontSize * BOX_HORIZONTAL_PADDING;
  const contentWidth = Math.max(1, content.clientWidth || box?.clientWidth || 1);
  const lineNodes = lines.map((line) => {
    if (text.style === "outline") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "text-line outline-line");
      svg.setAttribute("height", String(lineHeight));
      svg.setAttribute("width", "100%");
      const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const align = textAlignment(text);
      node.setAttribute("x", align === "left" ? "0" : align === "right" ? "100%" : "50%");
      node.setAttribute("y", "50%");
      node.setAttribute("text-anchor", align === "left" ? "start" : align === "right" ? "end" : "middle");
      node.setAttribute("dominant-baseline", "middle");
      node.setAttribute("fill", textColor(text));
      node.setAttribute("stroke", outlineColorFor(textColor(text)));
      const outlineWidth = Number.isFinite(Number(text.outlineWidth))
        ? Math.max(0, Number(text.outlineWidth))
        : DEFAULT_OUTLINE_WIDTH;
      node.setAttribute("stroke-width", String(outlineWidth * ((state.stageWidth || DESIGN_WIDTH) / DESIGN_WIDTH)));
      node.setAttribute("stroke-linejoin", "round");
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("paint-order", "stroke fill");
      node.setAttribute("font-family", textCssFontFamily(activeProject(), text));
      node.setAttribute("font-weight", String(textFontWeight(activeProject(), text)));
      node.setAttribute("font-style", textFontStyle(activeProject(), text));
      node.style.fontVariationSettings = textFontVariationCss(activeProject(), text);
      node.setAttribute("font-size", `${fontSize}px`);
      node.textContent = line || " ";
      svg.appendChild(node);
      return svg;
    }
    const span = document.createElement("span");
    span.className = "text-line";
    span.textContent = line || "\u00a0";
    return span;
  });
  content.replaceChildren(...lineNodes);
  if (!perLineBox) return;

  const widths = lineNodes.map((lineNode, index) => {
    const renderedWidth = lineNode.getBoundingClientRect().width;
    return renderedWidth > 0
      ? renderedWidth
      : context.measureText(lines[index] || " ").width + padX * 2;
  });
  content.prepend(createPerLineBackground(text, widths, lineHeight, fontSize, contentWidth));
}

export function updateOverlayBox(overlay) {
  const box = app.querySelector(`.overlay-box[data-overlay-id="${overlay.id}"]`);
  const asset = projectAsset(overlay.assetId);
  if (!box || !asset) return;
  const metrics = getOverlayMetrics(overlay, asset);
  const crop = overlayCrop(overlay);
  const cropping = overlay.id === state.croppingOverlayId;
  box.style.left = `${overlay.x * 100}%`;
  box.style.top = `${overlay.y * 100}%`;
  box.style.width = `${metrics.width * 100}%`;
  box.style.height = `${metrics.height * 100}%`;
  box.style.transform = `rotate(${overlay.rotation || 0}deg)`;
  const images = box.querySelectorAll(".overlay-image-clip img");
  images.forEach((image) => {
    if (cropping) {
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.left = "0";
      image.style.top = "0";
    } else {
      image.style.width = `${100 / crop.w}%`;
      image.style.height = `${100 / crop.h}%`;
      image.style.left = `${(-crop.x / crop.w) * 100}%`;
      image.style.top = `${(-crop.y / crop.h) * 100}%`;
    }
  });
  const inside = box.querySelector(".overlay-image-clip--inside");
  if (inside) inside.style.clipPath = overlayClipCss(overlay, asset);
  const cropRect = box.querySelector(".crop-rect");
  if (cropRect) {
    cropRect.style.left = `${crop.x * 100}%`;
    cropRect.style.top = `${crop.y * 100}%`;
    cropRect.style.width = `${crop.w * 100}%`;
    cropRect.style.height = `${crop.h * 100}%`;
  }
}
