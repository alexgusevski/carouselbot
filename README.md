# Slide Studio

A focused, local-first web editor for creating TikTok slideshow images.

**Live:** [slides-editor.pages.dev](https://slides-editor.pages.dev)

Everything runs in the browser. Photos and projects stay in IndexedDB on your device — nothing is uploaded.

## What it does

- Creates projects that persist in the browser with IndexedDB
- Uploads multiple PNG, JPEG, WebP, GIF, SVG, or AVIF photos
- Crops every photo to TikTok's portrait 9:16 format with drag and zoom controls
- Shows full slide compositions in the sidebar and supports drag-to-reorder
- Keeps a project-wide asset library so extra photos can be reused on any slide
- Adds photo overlays by dragging an uploaded asset onto the main image, then resizing (aspect ratio locked) or rotating
- Adds multiline text layers that can be dragged and resized
- Offers text color presets plus a live color wheel with synchronized hex and RGB values
- Includes clean text, adjustable outlines, per-line rounded backgrounds, and full-box backgrounds
- Offers white or black background treatments
- Toggles a semi-transparent TikTok UI placement preview that is never exported
- Uses the official open-source TikTok Sans font
- Shares one slide or every slide at once as full-resolution PNGs, with text and image layers included
- Downloads the selected slide as a 1080 × 1920 PNG

## Run it locally

```bash
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

## Deploy to Cloudflare

This project uses Cloudflare Pages Direct Upload. The deployment contains only the browser-ready files in `dist/`; there is no backend function.

```bash
npm run deploy
```

The public site is [slides-editor.pages.dev](https://slides-editor.pages.dev).

To publish the current checkout to the persistent dev environment without touching production:

```bash
npm run deploy:dev
```

## License

MIT. TikTok Sans is distributed under the SIL Open Font License 1.1; its license is included at `assets/TikTokSans-OFL.txt`. The GitHub Octicons mark is distributed under the MIT License; its notice is included at `assets/Octicons-LICENSE.txt`.
