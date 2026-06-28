# PDF Export Pro

Print-ready PDF export plugin for Figma.

- **RGB** — vector PDF (text/shapes stay crisp), multi-page merge or per-frame ZIP.
- **CMYK** — raster PDF with `DeviceCMYK` images, ink-limit/GCR control.
- **PDF/X-1a** — embeds a Coated FOGRA39 OutputIntent for print shops.
- **Bleed** (spad), **crop marks** in registration color, correct `TrimBox`/`BleedBox`,
  white background, PDF metadata (title/author/dates/ID).

## Architecture

| File | Role |
| --- | --- |
| `manifest.json` | Figma plugin manifest. Declares `documentAccess: dynamic-page` and `networkAccess` (no domains — everything is bundled). |
| `code.js` | Plugin sandbox. Enumerates exportable nodes on the current page and runs `exportAsync`. |
| `src/ui.html` | **Source** for the plugin UI + all PDF-building logic. |
| `ui.html` | **Generated** — `src/ui.html` with `pdf-lib`, `jszip`, `pako` inlined. Referenced by the manifest. Do not edit by hand. |
| `src/lib/pdf-core.js` | Pure (DOM-free) CMYK PDF builder — unit-tested in Node. |
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
