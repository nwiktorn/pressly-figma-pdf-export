# Pressly - PDF Export

Print-ready PDF export plugin for Figma.

- **RGB** — vector PDF (text/shapes stay crisp), multi-page merge or per-frame ZIP.
  Merged PDFs deduplicate identical fonts/images across pages to keep files small.
- **CMYK** — raster PDF with `DeviceCMYK` images, ink-limit/GCR control, and
  optional JPEG (`DCTDecode`) compression for much smaller files.
- **PDF/X-1a** — embeds a Coated FOGRA39 OutputIntent for print shops.
- **Bleed** (spad), **crop marks** in registration color, correct `TrimBox`/`BleedBox`,
  white background, PDF metadata (title/author/dates/ID).
- **Quality of life** — frame thumbnails, settings remembered via `clientStorage`,
  filename templates (`{name}` `{index}` `{date}` `{time}` `{w}` `{h}`).

Runs fully locally — no network access (see `manifest.json`).

## UI — Aurora design

The plugin uses the "Aurora" visual identity: a two-column layout (900 px wide),
animated conic-gradient borders on selected options and the export button, and a
Google/Gemini-spectrum colour palette (`#4285F4 / #9b72cb / #d96570 / #3ec6c0`).
Animations are disabled automatically via `@media (prefers-reduced-motion)`.

The design source is `C:\Users\nwikt\Downloads\pressly-pdf-export-aurora-wide.html`
(self-contained prototype, no dependencies). When making UI changes, match that
prototype's tokens and component patterns.

## Architecture

| File | Role |
| --- | --- |
| `manifest.json` | Figma plugin manifest. Declares `documentAccess: dynamic-page` and `networkAccess` (no domains — everything is bundled). |
| `code.js` | Plugin sandbox. Enumerates exportable nodes on the current page and runs `exportAsync`. |
| `src/ui.html` | **Source** for the plugin UI + all PDF-building logic. |
| `ui.html` | **Generated** — `src/ui.html` with `pdf-lib`, `jszip`, `pako` inlined. Referenced by the manifest. Do not edit by hand. |
| `src/lib/pdf-core.js` | Pure (DOM-free) CMYK PDF builder — unit-tested in Node. |
| `src/lib/pdf-merge.js` | Cross-page stream (font/image) deduplication for merged RGB PDFs. |
| `assets/CoatedFOGRA39.icc` | Default CMYK output profile (ECI, see `NOTICE.md`), embedded for PDF/X. |
| `build.mjs` | Inlines the vendored libraries, `pdf-core`, and the ICC profile into `src/ui.html` → `ui.html`. |
| `test/` | Node tests for the PDF core. Run `npm test`. |

The libraries are inlined at build time so the plugin works offline and needs no
network access, which keeps it compatible with Figma's `networkAccess` policy.

## Development

```bash
npm install        # fetch pdf-lib / jszip / pako into node_modules
npm run build      # generate ui.html from src/ui.html
npm run watch      # rebuild on changes to src/
npm test           # run the PDF-core unit tests (Node)
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…**
and pick `manifest.json`. After editing `src/ui.html` run `npm run build` and
re-run the plugin.

> Edit `src/ui.html`, never the generated `ui.html`.
