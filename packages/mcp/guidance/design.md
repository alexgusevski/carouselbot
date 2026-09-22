# CarouselBot design guidance

Read this before creating or editing slides. Use it as a compact quality bar, then inspect the rendered slide instead of assuming code values look good.

## Defaults that usually look good

- Choose a project aspect ratio as the default for new slides. `9:16` is the default; presets also include `2:3`, `3:4`, `4:5`, `1:1`, `4:3`, and `16:9`. Pass `aspectRatio` to `add_slide` or `update_slide` when an individual slide should differ, and use another validated positive `W:H` ratio when the reference demands it. Deliberate format changes can add rhythm and uniqueness; accidental inconsistency cannot. Keep one clear idea per slide.
- When `add_slide` uses `backgroundPath` without an explicit `aspectRatio`, the slide adopts the image's exact reduced ratio. Use this for source-faithful image slides: the image scales to the fixed 1080-pixel canvas width, workspace space above or below stays outside the slide, and export contains only the visible slide canvas. Pass `aspectRatio` only when deliberate crop-to-format behavior is wanted.
- For a flat background, call `add_slide` with `backgroundColor` (or `update_slide` with `backgroundColor`). Do not create, upload, or import a bitmap merely to get a solid color.
- Prefer `boxed` text with `backgroundShape: "lines"` for highlighted copy. Treat per-line boxes as the default; use `full` only for a deliberate card or label.
- `add_text` and `update_text` automatically preserve width and fit height around all wrapped lines with safety padding. Do not render just to discover clipping or call `fit_text_boxes` after ordinary copy edits.
- Use `fit_text_boxes` with `mode: "both"` only when you intentionally want width to shrink as well. If automatic fitting rejects copy that cannot fit on one slide, shorten it or split it across slides.
- After creating or changing any full-box text, call `fit_text_boxes`. A full box must hug its rendered content instead of leaving a large empty rectangle.
- Use plain or outlined text for supporting copy. Use no more than two text treatments on one slide.
- Choose size by role rather than one universal value: titles `92–124`, subtitles `68–84`, body copy `54–68`, captions `44–52`. These are ranges, not fixed presets; render and adjust within them.
- Do not shrink dense copy below the body range to make it fit. Shorten it or split it across slides. Aim for roughly 3–7 body lines on a slide.
- Keep important content inside roughly `x: 0.06..0.86` and `y: 0.08..0.78` when the TikTok overlay matters. The right and bottom edges are occupied by interface controls and captions.
- Give text boxes generous width while composing. Per-line backgrounds include protected edge padding; if content or size changes, render again and use `fit_text_boxes` when the box itself should hug the content.
- Use short lines. Two to four lines for a headline is usually stronger than one dense paragraph.
- Keep strong contrast between copy and the image. Use black boxed backgrounds with white text or white boxed backgrounds with near-black text.
- Preserve an obvious focal image. Do not cover faces or the main subject unless the composition intentionally calls for it.
- Align related text layers consistently. Center is a safe default; use left alignment for editorial layouts.
- Use rotation sparingly. Small intentional angles can add energy; arbitrary angles make carousels feel inconsistent.
- Reuse a small palette and consistent type scale across the project.
- For an installed Mac font, select an exact face with `list_local_fonts`, import its opaque ID with `import_font`, and apply only the returned project `fontId`. Reuse project faces through `list_project_fonts`; never guess family strings.
- Use numeric `fontWeight`, including 550 or 725, for variable weight. Built-in TikTok Sans supports 100–900; imported variable faces use their wght range. Static fonts select an exact matching imported family face or report FONT_FACE_MISMATCH; they cannot interpolate arbitrary weights. `inspect_editor` reports effectiveFontWeight and supportedWeights for each text layer. Check every title and body layer separately. Do not newly apply `wdth`, `opsz`, `slnt`, or custom axes until exported-canvas parity is available.
- Keep ordinary typography as editable text layers, including typography that uses an imported font. Never generate or import a text-only PNG/SVG and place it with `add_image` just to imitate a font. If the requested face cannot be imported, keep the copy editable in an available face and report the substitution instead of baking the words into pixels.

## Working method

1. Inspect the editor and use the returned project, slide, asset, and layer IDs.
2. Create or update one slide at a time. If that project is already visible, the editor follows its most recently changed slide. Work on another project never takes over the user's current view.
3. Use `apply_operations` when several related edits can be expressed compactly; the browser still shows each operation live.
4. Call `render_slide` after a meaningful composition change and look at the returned image.
5. Correct clipping, collisions, weak contrast, unsafe placement, inconsistent spacing, and visual imbalance before continuing.
6. Render the complete set at least once before exporting.

## Text-box clipping checklist

- Increase width before shrinking type when a line almost fits.
- Increase height when multiline text or per-line backgrounds approach the top or bottom edge.
- Use `fit_text_boxes` after changing full-box copy or font size. Use `mode: "height"` when the chosen width must remain fixed.
- Keep `x + width` and `y + height` within the canvas unless an off-canvas effect is intentional.
- With boxed text, keep `backgroundShape: "lines"`; automatic height fitting includes minimum breathing room so rounded pills stay inside the text container.
- If the result is uncertain, render it. Numeric state is not a visual review.

## Agent behavior

- Do not delete projects, slides, assets, or layers unless the request calls for it.
- Do not overwrite an existing export unless explicitly requested.
- Keep tool responses and progress messages concise.
- Prefer IDs returned by tools over guessed names or array positions.
- Do not claim a slide looks good until you have inspected a rendered image.
- Use `add_text` or `update_text` for all ordinary words. Reserve image assets for photographs, illustrations, logos, screenshots, and deliberate artwork that cannot be represented by editable CarouselBot layers.
- Do not call `open_project` merely to edit or render another project. It intentionally changes the user's browser view; use it only when the user asks to see that project.


## Video workflow

Videos are supported end to end by the companion; do not fall back to browser clicks or say only images are supported. Use `inspect_editor` with `includeAllProjects: false` and the assigned project/slide IDs. `capabilities` reports video support; slides expose `mode`, `duration`, and `loop`, and assets and placed `images` expose `type: "video"`. The `images` field and image tool names remain compatible and include placed videos.

1. `import_asset({ path: "/absolute/path/demo.mp4", projectId, editSessionId })` imports MP4/MOV/WebM (browser-decodable codecs, H.264 MP4 recommended), up to 100 MB. Keep the returned `assetId`.
2. `add_image({ assetId, projectId, slideId, x: 0.52, y: 0.15, width: 0.42, editSessionId })` places the video. `update_image` controls the same move, resize, crop, rotation, and stacking fields as images. Keep all accompanying copy in editable text layers. `add_slide`/`update_slide` also accept a video `backgroundPath`.
3. Video mode is automatic. The longest placed/background clip defines duration; shorter clips loop. `render_slide({ projectId, slideId, time: 3, editSessionId })` returns real composited pixels at three seconds without moving the user's playback or navigating. Inspect multiple times for motion and layout.
4. For a video slide already visible, `set_video_playback({ projectId, slideId, playing: false, time: 3, editSessionId })` pauses/seeks; `playing: true` resumes. Omit both to read playback. This never navigates; only use `open_project` when asked to show a project.
5. `export_slide({ projectId, slideId, outputPath: "/absolute/path/slide.mp4", editSessionId })` automatically produces MP4 with source audio for video slides. Image slides remain PNG. `format: "png", time: 3` explicitly exports a still frame to a `.png` path. `export_project` chooses MP4/PNG for each slide in mixed projects. Existing files are protected unless `overwrite: true` is authorized.

MP4 export uses the browser's encoder and runs in real time. Agent exports support up to 120 seconds per slide and need a browser with native MP4 recording (current Chrome recommended). Allow enough tool time for encoding; the CLI fallback supports long export calls. Media stays on this computer. For an older editor without video capabilities, reload its existing real-browser tab and retry after automatic reconnection. For an older installed companion use `npx -y carouselbot@latest call ...`; newly added tool names are available immediately through this fallback without restarting an agent session.
