# RGB vector size optimization — discovery & implementation plan

> Status: **design / not yet implemented.** This document records what we found
> when investigating why Figma's vector PDFs are large, the measurements that
> prove the fix, and the concrete plan to build it. Implementation will land in
> `src/lib/pdf-core.js` (pure helpers), `src/lib/pdf-merge.js` (orchestration),
> `src/ui.html` (controls), and `test/pdf-core.test.mjs`.

---

## 1. The problem

Users need to shrink **already-small** (≈3 MB) vector PDFs exported from Figma —
typically **CVs and other text documents** — because job portals and upload forms
impose strict size limits. Re-exporting, rasterizing, or font-subsetting either
doesn't help or destroys selectable text. The only thing that worked previously
was running **Ghostscript** (`-dPDFSETTINGS`), which is a desktop dependency we
cannot ship inside a Figma plugin sandbox.

Goal: replicate (and beat) Ghostscript's reduction **in pure browser JS**, with
**no loss of selectable text**, inside the plugin.

---

## 2. Root cause (measured on `CV Łucja.pdf`, 3.34 MB, 2 pages)

Figma exports text as **Type3 fonts** — each glyph is a small content stream of
vector drawing operators (a `CharProc`), not an embedded TrueType/Type1 program.
Consequences we verified with PyMuPDF:

- **0 embedded font bytes** in every variant → classic *font subsetting buys
  nothing* (there is no `FontFile` to subset).
- Text is still selectable because the Type3 fonts carry encoding/ToUnicode
  (3974 characters extracted from page 0).
- **96% of the file is two streams** — the page content streams:

  | xref | role | stored (deflate) | decompressed |
  | --- | --- | --- | --- |
  | 2635 | page 0 `/Contents` | 1842 KB | **4649 KB** |
  | 4056 | page 1 `/Contents` | 1070 KB | 2683 KB |

- Those content streams are **86% numeric literals, and every number has exactly
  6 fractional digits** (`0.054902`, `8.579994`, `1123.000000`). The body is pure
  vector geometry: **64 168 cubic-bezier `c`**, 21 242 `l`, 8 248 `m` — versus only
  398 text-show `TJ` operators.
- Figma also compresses weakly: re-deflating the two big streams at zlib level 9
  recovers ~14% on its own (1842→1586 KB, 1070→917 KB).

**The waste is precision.** At PDF point scale (1 unit = 1/72 inch ≈ 0.353 mm),
6 fractional digits encodes **0.00000035 mm** — billions of times finer than any
printer (≈0.04 mm at 600 dpi) or screen can resolve. Each redundant digit is a
literal byte in a multi-megabyte stream.

What Ghostscript actually does (verified by structure diff): re-deflates every
stream, deduplicates objects (4336 → 232), and packs them into object streams
(`/ObjStm`). It does **not** touch coordinate precision — which is exactly the
lever it leaves on the table and we can take.

---

## 3. The fix — and proof it works

For every **operator stream** (page `/Contents`, Type3 `/CharProcs`, Form
XObjects): inflate → **reduce numeric precision** (round fractional numbers to N
decimals, outside string literals) → **re-deflate at level 9**; then dedupe
identical objects and save with object streams.

Measured end-to-end (PyMuPDF simulation mirroring the planned JS pipeline;
original 3421 KB, Ghostscript reference 1926 KB):

| Pipeline | Size | vs original | vs Ghostscript | Selectable | Visual Δ (mean abs px / 255 @150dpi) |
| --- | --- | --- | --- | --- | --- |
| deflate-9 + dedup + objstm only | 2420 KB | −29% | 1.26× | ✅ | 0 |
| + precision **3 dp** | 1825 KB | −47% | 0.95× | ✅ 3974 ch | 0.017 |
| + precision **2 dp** ⭐ | **1541 KB** | **−55%** | **0.80×** | ✅ 3974 ch | 0.126 |
| + precision **1 dp** | 1135 KB | −67% | 0.59× | ✅ 3975 ch | 0.752 (visible) |
| *Ghostscript (reference)* | *1926 KB* | *−44%* | *1.0×* | ✅ | — |

- **2 dp is the recommended default**: 20% smaller than Ghostscript, pixel diff
  0.126/255 (≈0.05%, on the order of anti-alias noise — side-by-side renders are
  indistinguishable). 2 dp at point scale = 0.0035 mm precision, well below print
  resolution.
- **1 dp is an opt-in "maximum" mode**: 0.035 mm rounding starts to nudge edges
  (4% of pixels differ at 150 dpi). Useful only to squeeze under an absurd limit,
  and must carry a **warning** that fine geometry may shift slightly — verify the
  result.

**Precision is applied per operand class, not blindly (measured on page 0).** Of
all fractional-number operands, geometry is ~all the weight and colour is a rounding
error:

| Operand class (operator) | count | bytes |
| --- | --- | --- |
| geometry (`m l c v y re cm h d w`) | 445 296 | **3940 KB (99.3%)** |
| text position (`Td TD Tm TJ …`) | 2 786 | 22.6 KB |
| colour (`g rg k sc scn …`) | 408 | **3.2 KB (0.08%)** |

So the shrink comes **entirely from geometry**. Colour operands (e.g. `scn`
`0.054902` ≈ 14/255) are kept at full precision — rounding them would band
gradients/subtle fills for **zero size benefit** (3 KB). The plan therefore reduces
geometry (and text) to the selected `decimals` and **leaves colour operands
untouched**. This requires knowing which operator consumes each operand → an
operator-aware tokenizer (below), not a blind text pass.

---

## 4. Implementation plan

### 4.0 Why NOT a blind regex (decision)

A content stream is **a sequence of operands followed by operators** with a precise
lexical grammar (ISO 32000 §7.8.2; cf. pikepdf/pdf.js, which both model it as an
operator/operand list and mutate via a tokenizer, never by text substitution). A
`/-?\d+\.\d+/g` replace over the decompressed bytes is acceptable **only as a
throwaway prototype** and must not ship, because content streams:

- contain **literal strings `(...)`** and **hex strings `<...>`** whose bytes are
  data, not operands (a `(3.5 kg)` would be mangled);
- can carry **inline images** — `BI … ID <raw image bytes> EI` — where everything
  between `ID` and `EI` is **arbitrary binary** (may contain `(`, `<`, digits,
  even the bytes `EI`);
- are **not guaranteed ASCII** — scanning this CV found a stream with high bytes.

Empirically *this* Figma CV has no inline images and no decimals inside strings, so
the prototype regex happened to round-trip cleanly — but correctness must not
depend on that. The shipped pass is a tokenizer.

### 4.1 Pure helpers — `src/lib/pdf-core.js`

DOM-free and pdf-lib-free (keeps it Node-testable, per the project's golden rule).

```js
// Operator-aware precision reducer. Tokenizes a DECODED content stream per the
// PDF content-stream grammar and rewrites ONLY numeric operands consumed by
// geometry/text operators, to `decimals` places. Everything else is re-emitted
// byte-for-byte: strings (…), hex <…>, names /…, comments %…, dict << >>,
// inline images BI…ID…EI, colour-operator operands, and any token it doesn't
// understand. Operates on bytes (1 byte = 1 unit), never on a Unicode string.
//   bytes     Uint8Array of the decoded stream
//   opts      { decimals, colorDecimals = null /* keep colour as-is */ }
function reduceOperatorPrecision(bytes, opts) { … }

// Defense-in-depth guard: returns false for bytes that are clearly NOT an
// operator stream (contains NUL, or <~85% printable ASCII+whitespace), so even a
// mis-selected binary stream is left alone.
function looksLikeOperatorStream(bytes) { … }
```

**Tokenizer scope (minimal but correct).** A single byte cursor classifies each
token: whitespace; comment `%…EOL`; literal string `(…)` (balanced parens,
`\(`/`\)`/`\\`/octal escapes); hex string `<…>` vs dict open `<<`; name `/…`
(`#xx` escapes); number `[+-]?(\d+\.?\d*|\.\d+)`; array `[`/`]`; or an operator
keyword. Operands accumulate until an operator keyword is read; the operator's
class then decides precision for the buffered numeric operands (geometry/text →
`decimals`; colour → kept). **Inline images:** on the `BI` operator, copy verbatim
through the matching `EI` — locate it by the dict's pixel length when unfiltered,
else by the whitespace-delimited `EI` heuristic — without interpreting the binary.
Number rewrite: round half-away-from-zero, strip trailing zeros and a bare `-0`;
never widen a token.

### 4.2 Orchestration — `src/lib/pdf-merge.js`

Already receives `PDFLib` by injection and owns `dedupeStreams`; add a sibling
that also takes `pako` (a browser global / Node dep, injected like elsewhere):

```js
// Walk doc, optimize only provably-safe operator streams, re-deflate level 9.
function optimizeStreams(PDFLib, pako, doc, { decimals }) {
  // 1. Build an ALLOWLIST of operator-stream refs by walking structure (NOT a
  //    denylist — see hazard below):
  //    - every page's /Contents (single ref OR array of refs)
  //    - every Type3 font's /CharProcs dict values
  //    - every XObject with /Subtype /Form
  // 2. For each allowed stream:
  //    - decode (inflate if /Filter is FlateDecode; else raw)
  //    - skip if !looksLikeOperatorStream(decoded)         // belt-and-braces
  //    - decoded = PDFCore.reduceOperatorPrecision(decoded, { decimals })
  //    - re-deflate (pako.deflate level 9); context.assign(ref, PDFRawStream.of(
  //        dict with /Filter /FlateDecode + updated /Length, deflated))
  // 3. Return { processed, bytesSaved } for telemetry/UI.
}
```

**Gating must be an allowlist, not a denylist (verified hazard).** Scanning this
CV, a denylist that only skips `/Subtype /Image` + `/Type /Metadata` would still
hand object **2631** — `<< /Alternate /DeviceRGB /Filter /FlateDecode /N 3 >>`, a
3 KB **ICCBased colour-profile stream of binary bytes** — to the rewriter. The
structural allowlist excludes it (it is reachable only from a `/ColorSpace`, never
from `/Contents`/`/CharProcs`/Form), and the `looksLikeOperatorStream` guard
rejects it independently (high bytes). Two layers, so a single mistake can't
corrupt output.

**Pipeline order in `buildMergedRgbPdf` / `buildSingleRgbPdf`:**
`copyPages` → crop marks/bleed → **`optimizeStreams` (if enabled)** →
`dedupeStreams` → `doc.save({ useObjectStreams: true })`.

Optimize *before* dedupe so that glyph streams differing only in precision noise
become byte-identical and are then collapsed (dedupe compares deterministic,
re-deflated bytes — pako level 9 is deterministic). `useObjectStreams` is pdf-lib
default; keep it on for the `/ObjStm` packing win.

### 4.3 UI — `src/ui.html`

In the sRGB (vector) section only (raster CMYK is unaffected), a 3-way control:

- **Wył.** — no optimization (current behavior; dedupe still runs).
- **Standardowa (2 miejsca)** — default. Subcopy: "≈ −55%, wizualnie identyczny".
- **Maksymalna (1 miejsce)** — shows a `warn` banner:
  *"Maksymalna kompresja zaokrągla geometrię do ~0.035 mm. Plik jest najmniejszy,
  ale drobne elementy mogą się minimalnie zmienić — sprawdź podgląd przed
  wysłaniem."*

State: `S.optimize ∈ {'off','standard','max'}` → `decimals = {off:null, standard:2,
max:1}`. Persist via `collectSettings`/`applySettings`. Hide the control when
`profile === 'cmyk'`. Results card already shows the output size, which makes the
win visible.

### 4.4 Tests — `test/pdf-core.test.mjs`

`reduceOperatorPrecision` (tokenizer correctness — the high-value tests):
- geometry rounds: `'1.234567 0.000000 m'` → `'1.23 0 m'` (2 dp); integers untouched; `-0`→`0`.
- **colour preserved**: `'0.054902 0.0549 0.062745 scn'` is returned **unchanged**.
- **string-safe**: a decimal inside a literal string `(/V3.5  q 1.2)` and a hex
  string `<312e35>` are byte-for-byte preserved.
- **inline image-safe**: `BI /W 2 /H 2 /BPC 8 /CS /G ID <4 raw bytes incl. '(' and digits> EI`
  round-trips byte-for-byte (binary block untouched), and a number *after* `EI` is
  still rounded.
- non-ASCII / high bytes inside a string token survive untouched.
- `looksLikeOperatorStream`: true for operators; false for bytes with NUL or an
  ICC/binary blob.

`optimizeStreams` (integration): construct a small PDF (pdf-lib) with an
uncompressed operator stream of 6-dp numbers **plus** an ICCBased colour-profile
stream; assert the content stream decodes to reduced precision and carries
`/Filter /FlateDecode`, the **ICC stream is byte-identical** (allowlist skipped
it), the doc re-opens/parses, output is smaller, and a sentinel coordinate stays
within `0.5·10^-decimals`.

### 4.5 Build

No new inject markers. After edits: `npm run build` to regenerate `ui.html`, then
`npm test`, then re-import in Figma to eyeball a real CV at 2 dp and 1 dp.

---

## 5. Risks & limits

- **Parsing correctness is the main risk** — addressed by the tokenizer (§4.0/4.1):
  strings, hex strings, names, comments, **inline images (`BI…ID…EI`) and their
  raw binary**, and unknown tokens are passed through verbatim; only geometry/text
  numeric operands are touched. The blind regex is prototype-only.
- **Binary streams mis-selected.** Prevented by the structural allowlist *and* the
  `looksLikeOperatorStream` guard — concretely the ICCBased profile stream (obj
  2631) a denylist would miss is caught by both (§4.2).
- **Colour banding.** Avoided by keeping colour operands at full precision (~3 KB,
  §3); the size win is geometry-only.
- **Images.** This CV had none; the win is geometry, not pixels. If a frame has a
  raster photo, that data is image streams we deliberately skip — the separate
  "image downscale/JPEG in RGB path" idea (roadmap) is the complementary lever.
- **Determinism.** Dedupe-after-optimize relies on pako level 9 being
  deterministic (it is) so identical glyphs collapse.
- **1 dp** can visibly shift hairline strokes/very small type — gated behind the
  "Maksymalna" mode + warning, per user intent (extreme-limit escape hatch).

---

## 6. Checklist

- [x] `reduceOperatorPrecision` (tokenizer, operator-aware) + `looksLikeOperatorStream` in `pdf-core.js`
- [x] `optimizeStreams` (allowlist gating) in `pdf-merge.js`
- [x] Wire into `buildMergedRgbPdf` / `buildSingleRgbPdf`
- [x] UI control via shared quality presets (highest = off, medium = 2 dp, low = 1 dp) + persistence
- [x] Tests (tokenizer: strings/hex/inline-image/colour-preserve/binary-reject + end-to-end optimize) — 13 new tests, 31 total
- [x] `npm run build` ✓ · `npm test` 31/31 ✓ · manual Figma check — done; surfaced `pako` global/build-injection issues; fixed with `getPako()` / `resolvePako()` and replacement callbacks in `build.mjs`
- [x] Update AGENTS.md §5/§6/§7/§8 — done
