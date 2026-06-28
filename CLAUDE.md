# CLAUDE.md — agent onboarding for PDF Export Pro

Read this first. It explains what the project is, how it is built, every feature
and the non-obvious decisions behind them, so you can be productive immediately.

---

## 1. What this is

**PDF Export Pro** is a **Figma plugin** that exports frames to **print-ready and
share-ready PDFs**. It is aimed at people who need real prepress output (posters,
flyers, CVs, multi-page documents) directly from Figma, not just a screenshot.

Two export engines, chosen by the user:

- **RGB** → **vector** PDF. Uses Figma's native `exportAsync({format:'PDF'})` per
  frame, then merges with `pdf-lib`. Text/shapes stay crisp and selectable,
  resolution-independent. Best for screen, email, and most CVs.
- **CMYK** → **raster** PDF with `DeviceCMYK` images. Frames are exported as PNG,
  drawn on a canvas, converted RGB→CMYK, and assembled into a PDF **by hand**
  (no pdf-lib) in `src/lib/pdf-core.js`. Best for commercial print.

Everything runs **locally inside the plugin** — no network calls, no uploads.

---

## 2. Repository map

| Path | Role |
| --- | --- |
| `manifest.json` | Figma manifest. `documentAccess: "dynamic-page"`, `networkAccess: ["none"]`. |
| `code.js` | Plugin **sandbox** (main thread). Enumerates exportable nodes, runs `exportAsync`, sends bytes to the UI, handles thumbnails + `clientStorage`. |
| `src/ui.html` | **SOURCE** for the UI iframe + all browser-side logic. **Edit this.** |
| `ui.html` | **GENERATED** by the build (`src/ui.html` + libs + ICC inlined). Referenced by the manifest. **Never hand-edit.** |
| `src/lib/pdf-core.js` | Pure, DOM-free CMYK PDF builder + CMYK JPEG encoder. Unit-tested in Node. |
| `src/lib/pdf-merge.js` | Cross-page stream (font/image) deduplication for merged RGB PDFs. |
| `assets/CoatedFOGRA39.icc` | Default CMYK output profile, embedded for PDF/X (see `NOTICE.md`). |
| `assets/icon.svg` | Plugin icon for the Community listing. |
| `build.mjs` | Inlines vendored libs + app modules + ICC profile into `ui.html`. |
| `test/pdf-core.test.mjs` | Node test suite (`npm test`). 18 tests. |
| `docs/community.md` | Figma Community listing copy + publish checklist. |
| `README.md` | User/dev-facing overview. |
| `NOTICE.md` | Third-party attributions (ICC profile, libraries). |

The plugin UI loads **no external resources at runtime**. `pdf-lib`, `jszip`,
`pako` and the ICC profile are all inlined into `ui.html` at build time. This is
deliberate: Figma blocks UI network access unless declared, and we declare none.

---

## 3. Build & dev workflow

```bash
npm install      # pdf-lib, jszip, pako (+ dev: jpeg-js, @pdf-lib/fontkit, chokidar)
npm run build    # generate ui.html from src/ui.html
npm run watch    # rebuild on changes under src/
npm test         # Node test suite for the pure PDF logic
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…**,
pick `manifest.json`. After editing `src/ui.html` run `npm run build` and re-run.

**Golden rules**
- Edit `src/ui.html`, **regenerate** `ui.html` with `npm run build`. Both are
  committed (the generated one is the plugin entry point).
- After UI edits, syntax-check the inlined script:
  `awk '/^<script>$/{f=1;next} /^<\/script>$/{f=0} f' src/ui.html > /tmp/app.js && node --check /tmp/app.js`
- Keep PDF logic in `src/lib/*.js` (pure, injected dependencies) so it stays
  Node-testable. `pdf-core.js` must NOT depend on the DOM or pdf-lib.

### How the build injects (markers in `src/ui.html`)
- `<!-- @INJECT:VENDOR_LIBS -->` → pdf-lib, jszip, pako
- `<!-- @INJECT:APP_MODULES -->` → pdf-core.js, pdf-merge.js (depend on `pako`)
- `<!-- @INJECT:ICC_PROFILE -->` → FOGRA39, deflated+base64, inflated at load
  into `window.__ICC_CMYK__`

---

## 4. Architecture & message flow

`code.js` (sandbox) ↔ `ui.html` (iframe) via `postMessage`.

- On launch / `currentpagechange`: `code.js` → `init` `{frames, settings}`, then
  streams `thumb` `{id, bytes}` (64px PNG previews) lazily.
- UI → `export` `{frameIds, format, scale}`. `format` is `PNG` for CMYK, `PDF`
  for RGB. `code.js` runs `exportAsync` per node, streams `progress`, then sends
  `exportDone` `{data:[{name,bytes,width,height}]}` (and `exportError` per failed
  frame).
- UI builds the final PDF(s)/ZIP entirely client-side, triggers download, shows
  results with file sizes.
- UI → `saveSettings` `{settings}` on export; `code.js` persists via
  `figma.clientStorage`.

`code.js` uses `figma.getNodeByIdAsync` (required by `documentAccess:dynamic-page`).

---

## 5. Features (and where they live)

All UI state is the `S` object in `src/ui.html`.

### Export modes
- **Merged** (one PDF) vs **Separate** (per-frame → ZIP via jszip).
- RGB merged: `buildMergedRgbPdf` (pdf-lib `copyPages`, then `dedupeStreams`).
- RGB separate: `buildSingleRgbPdf` per frame.
- CMYK: `buildCmykPdf` → `PDFCore.assembleCmykPdf`.

### Print options (`src/lib/pdf-core.js` for CMYK, `addCropMarksRgb` for RGB)
- **Bleed (spad)** in mm → expands MediaBox, sets `BleedBox`.
- **Crop marks** → registration colour (`1 1 1 1 K` in CMYK so they print on
  every separation), drawn outside the trim with a margin so they are never
  clipped. Correct `TrimBox`/`BleedBox`/`MediaBox` on both paths.
- **White background** toggle (CMYK canvas fill).
- **Metadata**: title/author + CreationDate/ModDate + trailer `/ID`. (Previously
  the CMYK path dropped all metadata — fixed.)

### CMYK colour & files
- **Ink limit / GCR** (`rgbaToCmyk(rgba,w,h,inkLimit)`): caps total ink coverage
  (default 320%) by pulling overshoot out of CMY into K. Naive, not colorimetric.
- **PDF/X-1a**: when enabled, embeds the FOGRA39 OutputIntent and writes the
  `GTS_PDFXVersion` keys. Conformance is only claimed when an ICC is actually
  embedded. ICC is embedded **only** when PDF/X is on (keeps plain CMYK small).
- **Compression**: `flate` (lossless) or `jpeg` (`DCTDecode`) + quality slider.

### Resolution clarity
- **DPI readout** under the DPI selector (CMYK card): `DPI = 96 × scale`
  (the plugin treats 96 px = 1 inch). Shows source px → output px and physical
  size in mm for the selected frame. RGB banner states vector = DPI-independent.
- Scale pills map to 96/192/288/384 DPI; Figma caps export at 4×.

### Quality of life
- **Frame thumbnails** in the list.
- **Settings persistence** via `clientStorage` (`collectSettings`/`applySettings`;
  applySettings drives the real controls so dependent UI updates).
- **Filename templates**: `{name} {index} {date} {time} {w} {h}`; auto per-file
  index in ZIP mode (`applyTemplate`).

---

## 6. Non-obvious decisions / gotchas (READ before touching these)

- **CMYK JPEG inversion (Adobe convention).** `encodeCmykJpeg` stores samples
  **inverted** (`255 - ink`) and writes an **Adobe APP14 marker (transform 0)**.
  PDF readers/RIPs invert CMYK DCTDecode images that carry this marker, so the
  PDF image needs **no `/Decode` array**. Verified by round-tripping through
  `jpeg-js` (same Adobe heuristic as pdf.js/Acrobat): white→white, black→black,
  red→red exactly. If you change the encoder, keep that test green.
- **The CMYK encoder is a hand-rolled baseline JPEG encoder** (4 components,
  shared quant + Huffman tables, no subsampling). `canvas.toBlob('image/jpeg')`
  cannot produce CMYK, hence the custom encoder. DCT/Huffman internals follow the
  well-known Thinh Nguyen / Andreas Ritter implementation; do not "optimise" the
  table ordering without re-running the round-trip test.
- **Stream dedup is byte-exact only.** `dedupeStreams` merges streams that match
  on length + FNV hash **and** full byte comparison, so it can never alter
  rendering. It recovers cross-page duplication (full fonts, repeated images).
  It does **NOT** re-subset fonts Figma already embedded (would need a font
  toolkit). Per-frame Figma subsets differ per page and are legitimately not
  merged.
- **FOGRA39 profile licensing.** ECI profiles are free to use and redistribute
  unmodified (see `NOTICE.md`). The file currently came from a local Adobe/ECI
  install; if provenance matters, replace with the pristine ECI download. Print
  shops can supply their own profile.
- **Generated `ui.html` is large (~1.35 MB)** because of the inlined ICC profile
  (~650 KB) and libraries. That is expected and loads once.
- **`rtk` is NOT installed here** despite the global CLAUDE.md mandating an `rtk`
  prefix on git/npm. Use plain `git`/`npm`. (Also recorded in agent memory.)

---

## 7. Testing

`npm test` runs `test/pdf-core.test.mjs` (no framework, Node assert). Covers:
RGB→CMYK conversion + ink limit, CMYK PDF geometry/metadata/PDF-X/`/ID`, the real
FOGRA39 profile + ICC inflate roundtrip, the CMYK JPEG encoder (markers + colour
round-trip via jpeg-js + size vs Flate), and stream dedup (repointing, no-op,
full-font multi-page shrink). 18 tests.

The pure logic is Node-testable precisely because `pdf-core.js`/`pdf-merge.js`
take their dependencies (pako, PDFLib) by injection and avoid the DOM. **What is
NOT covered: the live Figma runtime** (DOM wiring, canvas, clientStorage,
thumbnails, and how CMYK-JPEG looks in Acrobat/a real RIP) — verify those by
importing the plugin in Figma.

---

## 8. Status & roadmap

Done (committed): P0 build/bundling/async API · P1 print-correct CMYK core +
tests · P2 bundled FOGRA39 / PDF/X-1a · P3 thumbnails, persisted settings,
filename templates, release prep · CMYK JPEG · DPI readout · font/image dedup.

Possible next steps (not started):
- **Image downscale/JPEG in the RGB path** — usually the biggest real win for a
  CV with a photo (single-page exports are image-bound, not font-bound).
- **True font re-subsetting** of Figma-embedded fonts (needs fontkit; larger,
  riskier).
- **Size budget** mode (auto-pick quality to hit e.g. a 2 MB target).
- **Async/chunked CMYK JPEG encoding** — encoding large frames is synchronous and
  can briefly freeze the UI.
- **Multi-node single export** to avoid font duplication at the source.
- Community publish (icon→PNG, cover, screenshots; see `docs/community.md`).

---

## 9. Language note

The plugin UI is **Polish**. Keep user-facing strings in Polish; code, comments
and docs are in English.
