# Slide Studio design guidance

Read this before creating or editing slides. Use it as a compact quality bar, then inspect the rendered slide instead of assuming code values look good.

## Defaults that usually look good

- Build for a 9:16 phone canvas and keep one clear idea per slide.
- Prefer `boxed` text with `backgroundShape: "lines"` for highlighted copy. The per-line treatment is the product's strongest default.
- Avoid `backgroundShape: "full"` unless a deliberate large label or card is required. A large rectangular text box usually looks heavy.
- Use plain or outlined text for supporting copy. Use no more than two text treatments on one slide.
- Start headlines around 64–88 px and supporting text around 42–60 px. Adjust after rendering.
- Keep important content inside roughly `x: 0.06..0.86` and `y: 0.08..0.78` when the TikTok overlay matters. The right and bottom edges are occupied by interface controls and captions.
- Give text boxes generous width and height. Leave at least 0.04 of canvas width beyond the visible longest line and enough height for every line plus its background. Never let glyphs or rounded backgrounds touch a box edge.
- Use short lines. Two to four lines for a headline is usually stronger than one dense paragraph.
- Keep strong contrast between copy and the image. Use black boxed backgrounds with white text or white boxed backgrounds with near-black text.
- Preserve an obvious focal image. Do not cover faces or the main subject unless the composition intentionally calls for it.
- Align related text layers consistently. Center is a safe default; use left alignment for editorial layouts.
- Use rotation sparingly. Small intentional angles can add energy; arbitrary angles make carousels feel inconsistent.
- Reuse a small palette and consistent type scale across the project.

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
- Keep `x + width` and `y + height` within the canvas unless an off-canvas effect is intentional.
- With boxed text, keep `backgroundShape: "lines"` and do not size the box tightly around the letters; rounded pills need breathing room.
- If the result is uncertain, render it. Numeric state is not a visual review.

## Agent behavior

- Do not delete projects, slides, assets, or layers unless the request calls for it.
- Do not overwrite an existing export unless explicitly requested.
- Keep tool responses and progress messages concise.
- Prefer IDs returned by tools over guessed names or array positions.
- Do not claim a slide looks good until you have inspected a rendered image.
- Do not call `open_project` merely to edit or render another project. It intentionally changes the user's browser view; use it only when the user asks to see that project.
