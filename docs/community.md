# Figma Community listing

Copy and assets for publishing **Finally — Better exports for Figma** to the Figma Community.
Publishing itself is done from Figma (Plugins → Manage → Publish); this file is
the source of truth for the listing text.

## Name
Finally — Better exports for Figma

## Tagline (one line)
Print-ready PDF export — CMYK, bleed, crop marks and PDF/X-1a.

## Description
Export Figma frames to PDFs that are actually ready for print.

- **RGB vector PDF** — text and shapes stay crisp; merge frames into one
  document or export each frame to a ZIP.
- **CMYK PDF** — frames are rasterised to `DeviceCMYK` with an adjustable ink
  limit (GCR) for coated or uncoated stock, with optional JPEG compression for
  dramatically smaller files.
- **PDF/X-1a** — embeds a Coated FOGRA39 OutputIntent so print shops get a
  standards-compliant file out of the box.
- **Bleed & crop marks** — real `TrimBox`/`BleedBox`, registration-colour marks
  that print on every separation.
- **Metadata** — title, author, dates and a document ID written into the PDF.
- **Quality-of-life** — frame thumbnails, remembered settings, and filename
  templates (`{name}`, `{index}`, `{date}`, `{time}`, `{w}`, `{h}`).

Everything runs locally inside the plugin — no uploads, no network access.

## Tags
pdf, export, print, cmyk, prepress, pdf-x, bleed, crop-marks

## Assets
- `assets/icon.svg` — plugin icon (export to 128×128 PNG for the listing).
- `publikacja/screenshots/01-rgb-vector-export.png` — RGB/vector export workflow.
- `publikacja/screenshots/02-cmyk-print-settings.png` — CMYK print controls.
- `publikacja/screenshots/03-dark-theme-workflow.png` — dark theme workflow.
- `publikacja/screenshots/04-polish-interface.png` — Polish localization.

## Figma plugin ID
`manifest.json` uses the Community plugin ID `1653737759217582417`.

## Pre-publish checklist
- [ ] `npm run build` produces a current `ui.html`
- [ ] `npm test` is green
- [ ] Icon exported to PNG from `assets/icon.svg`
- [x] Screenshot set prepared in `publikacja/screenshots/`
- [ ] Test an RGB merge, a CMYK ZIP, and a PDF/X export on a real document
