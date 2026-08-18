# Slide Studio

A focused, local-first web editor for creating TikTok slideshow images.

## Run it

```bash
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

## Deploy to Cloudflare

This project uses Cloudflare Workers Static Assets. The deployment contains only the browser-ready files in `dist/`; there is no backend Worker invocation.

```bash
npm run deploy
```

The public Worker is named `slides-editor` and is served from the account's `workers.dev` domain.

## What it does

- Creates projects that persist in the browser with IndexedDB
- Uploads multiple PNG, JPEG, or WebP photos
- Crops every photo to TikTok's portrait 9:16 format with drag and zoom controls
- Adds multiline text layers that can be dragged and resized
- Includes clean text, adjustable outlines, per-line rounded backgrounds, and full-box backgrounds
- Offers white or black background treatments
- Toggles a semi-transparent TikTok UI placement preview that is never exported
- Uses the official open-source TikTok Sans font
- Downloads the selected slide as a 1080 × 1920 PNG

Everything runs in the browser. Photos and projects are not uploaded anywhere.

TikTok Sans is distributed under the SIL Open Font License 1.1. Its license is included at `assets/TikTokSans-OFL.txt`.
