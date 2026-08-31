# CarouselBot design guidance

Read this before creating or editing slides. Use it as a compact quality bar, then inspect the rendered slide instead of assuming code values look good.

## Defaults that usually look good

- Build for a 9:16 phone canvas and keep one clear idea per slide.
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
- Do not call `open_project` merely to edit or render another project. It intentionally changes the user's browser view; use it only when the user asks to see that project.
