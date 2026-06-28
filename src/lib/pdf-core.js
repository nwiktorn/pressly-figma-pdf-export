// Pure, environment-agnostic PDF building logic for the CMYK export path.
//
// UMD wrapper so the same source can be:
//   • inlined into ui.html (browser) where `pako` is a global, and
//   • required from Node test harnesses where `pako` is an npm dependency.
//
// Nothing here touches the DOM — inputs are plain typed arrays / numbers — which
// is what makes it unit-testable in Node without Figma or a browser.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('pako'));
  } else {
    root.PDFCore = factory(root.pako);
  }
})(typeof self !== 'undefined' ? self : this, function (pako) {
  'use strict';

  const MM_TO_PT = 2.834645669; // 1 mm in PostScript points (72 dpi)

  // ── Color ────────────────────────────────────────────────────────────────
  // Naive RGB→CMYK with optional GCR/ink-limit. Not colorimetric (see P2/ICC),
  // but deterministic and good enough for the "fast" path.
  //
  //   rgba       Uint8ClampedArray|Uint8Array, length w*h*4
  //   inkLimit   max total ink coverage 0..400 (%). 320 ≈ typical coated stock.
  // Returns interleaved CMYK bytes (length w*h*4).
  function rgbaToCmyk(rgba, w, h, inkLimit) {
    const limit = (inkLimit == null ? 400 : inkLimit) / 100; // as 0..4 fraction sum
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
      let c, m, y, k;
      k = 1 - Math.max(r, g, b);
      if (k >= 1) { c = m = y = 0; k = 1; }
      else {
        const d = 1 / (1 - k);
        c = (1 - r - k) * d;
        m = (1 - g - k) * d;
        y = (1 - b - k) * d;
      }
      // Enforce total ink limit by shifting coverage from CMY into K (basic GCR).
      let total = c + m + y + k;
      if (total > limit && total > 0) {
        const excess = total - limit;
        // Pull the overshoot out of the chromatic channels proportionally.
        const cmy = c + m + y;
        if (cmy > 0) {
          const scale = Math.max(0, 1 - excess / cmy);
          c *= scale; m *= scale; y *= scale;
        }
      }
      out[i * 4] = Math.round(c * 255);
      out[i * 4 + 1] = Math.round(m * 255);
      out[i * 4 + 2] = Math.round(y * 255);
      out[i * 4 + 3] = Math.round(k * 255);
    }
    return out;
  }

  // ── PDF helpers ────────────────────────────────────────────────────────────
  function pdfDate(d) {
    const p = n => String(n).padStart(2, '0');
    const tz = -d.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    const tzh = p(Math.floor(Math.abs(tz) / 60));
    const tzm = p(Math.abs(tz) % 60);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${tzh}'${tzm}'`;
  }

  function pdfTextEscape(s) {
    return String(s == null ? '' : s).replace(/([\\()])/g, '\\$1').replace(/[\r\n]/g, ' ');
  }

  // Tiny deterministic hash → hex, used for the required PDF /ID.
  function hashHex(bytesArr) {
    let h1 = 0x12345678, h2 = 0x9abcdef0;
    for (const bytes of bytesArr) {
      const step = Math.max(1, Math.floor(bytes.length / 4096));
      for (let i = 0; i < bytes.length; i += step) {
        h1 = (h1 ^ bytes[i]) * 16777619 >>> 0;
        h2 = (h2 + bytes[i] * (i + 1)) >>> 0;
      }
    }
    const hex = n => ('00000000' + (n >>> 0).toString(16)).slice(-8);
    return (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0)).toUpperCase();
  }

  // ── CMYK PDF assembler ──────────────────────────────────────────────────────
  // pages: [{ cmyk:Uint8Array, imgW, imgH, ptW, ptH, bleedPt }]
  // opts:  { cropMarks, meta:{title,author,creator}, pdfx, iccProfile, outputCondition }
  function assembleCmykPdf(pages, opts) {
    opts = opts || {};
    const meta = opts.meta || {};
    const cropMarks = !!opts.cropMarks;
    const iccProfile = opts.iccProfile || null;
    // PDF/X-1a conformance is only claimed when we can embed the output ICC.
    const pdfx = !!opts.pdfx && !!iccProfile;
    const outputCondition = opts.outputCondition || 'Coated FOGRA39 (ISO 12647-2:2004)';
    const conditionId = opts.outputConditionIdentifier || 'FOGRA39';

    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const xref = {};
    const push = data => {
      const b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      offset += b.length;
    };

    // Dynamic object allocator (no fragile fixed arithmetic).
    let nextObj = 1;
    const alloc = () => nextObj++;
    const startObj = n => { xref[n] = offset; push(`${n} 0 obj\n`); };
    const endObj = () => push('endobj\n');

    const compressed = pages.map(p => pako.deflate(p.cmyk));

    // Reserve object numbers.
    const catalogN = alloc();
    const pagesN = alloc();
    const infoN = alloc();
    let outputIntentN = 0, iccN = 0;
    if (pdfx || iccProfile) {
      outputIntentN = alloc();
      if (iccProfile) iccN = alloc();
    }
    const pageObjs = pages.map(() => ({ pageN: alloc(), contentN: alloc(), imageN: alloc() }));

    push('%PDF-1.5\n%\xFF\xFF\xFF\xFF\n');

    // Catalog
    startObj(catalogN);
    let cat = `<< /Type /Catalog /Pages ${pagesN} 0 R`;
    if (outputIntentN) cat += ` /OutputIntents [${outputIntentN} 0 R]`;
    cat += ' >>\n';
    push(cat);
    endObj();

    // Pages tree
    const kids = pageObjs.map(o => `${o.pageN} 0 R`).join(' ');
    startObj(pagesN);
    push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\n`);
    endObj();

    // Info dict (metadata + dates). PDF/X requires Title + dates + GTS_PDFXVersion.
    const now = opts.now ? new Date(opts.now) : new Date();
    startObj(infoN);
    let info = '<<';
    if (meta.title) info += ` /Title (${pdfTextEscape(meta.title)})`;
    if (meta.author) info += ` /Author (${pdfTextEscape(meta.author)})`;
    info += ` /Creator (${pdfTextEscape(meta.creator || 'PDF Export Pro')})`;
    info += ` /Producer (PDF Export Pro)`;
    info += ` /CreationDate (${pdfDate(now)}) /ModDate (${pdfDate(now)})`;
    if (pdfx) info += ` /GTS_PDFXVersion (PDF/X-1:2001) /GTS_PDFXConformance (PDF/X-1a:2001) /Trapped /False`;
    info += ' >>\n';
    push(info);
    endObj();

    // OutputIntent (+ embedded ICC profile stream)
    if (outputIntentN) {
      if (iccN) {
        const iccComp = pako.deflate(iccProfile);
        startObj(iccN);
        push(`<< /N 4 /Filter /FlateDecode /Length ${iccComp.length} >>\nstream\n`);
        push(iccComp);
        push('\nendstream\n');
        endObj();
      }
      startObj(outputIntentN);
      let oi = `<< /Type /OutputIntent /S /GTS_PDFX` +
        ` /OutputConditionIdentifier (${pdfTextEscape(conditionId)})` +
        ` /OutputCondition (${pdfTextEscape(outputCondition)})` +
        ` /Info (${pdfTextEscape(outputCondition)})`;
      if (iccN) oi += ` /DestOutputProfile ${iccN} 0 R`;
      oi += ' >>\n';
      push(oi);
      endObj();
    }

    const gap = 5.67, mlen = 14.17; // ≈2mm gap, ≈5mm mark length

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const { ptW, ptH, imgW, imgH } = p;
      const bleedPt = p.bleedPt || 0;
      const o = pageObjs[i];

      // Media margin reserves room for bleed and (if enabled) crop marks so they
      // are never clipped. Marks start at the bleed edge and extend outward.
      const markReserve = cropMarks ? (Math.max(bleedPt, gap) + mlen + MM_TO_PT) : 0;
      const m = Math.max(bleedPt, markReserve); // distance trim→media edge
      const pageW = ptW + m * 2;
      const pageH = ptH + m * 2;

      // Trim box placed at (m, m); artwork raster fills exactly the trim.
      const trimL = m, trimB = m, trimR = m + ptW, trimT = m + ptH;

      let ops = `q ${ptW.toFixed(3)} 0 0 ${ptH.toFixed(3)} ${m.toFixed(3)} ${m.toFixed(3)} cm /Im0 Do Q`;

      if (cropMarks) {
        const off = bleedPt > 0 ? bleedPt : gap; // start marks at bleed edge
        const f = v => v.toFixed(2);
        // Registration color (prints on all separations): CMYK 1 1 1 1.
        ops += `\n0.5 w 1 1 1 1 K\n` + [
          // bottom-left
          `${f(trimL - off - mlen)} ${f(trimB)} m ${f(trimL - off)} ${f(trimB)} l S`,
          `${f(trimL)} ${f(trimB - off)} m ${f(trimL)} ${f(trimB - off - mlen)} l S`,
          // bottom-right
          `${f(trimR + off)} ${f(trimB)} m ${f(trimR + off + mlen)} ${f(trimB)} l S`,
          `${f(trimR)} ${f(trimB - off)} m ${f(trimR)} ${f(trimB - off - mlen)} l S`,
          // top-left
          `${f(trimL - off - mlen)} ${f(trimT)} m ${f(trimL - off)} ${f(trimT)} l S`,
          `${f(trimL)} ${f(trimT + off)} m ${f(trimL)} ${f(trimT + off + mlen)} l S`,
          // top-right
          `${f(trimR + off)} ${f(trimT)} m ${f(trimR + off + mlen)} ${f(trimT)} l S`,
          `${f(trimR)} ${f(trimT + off)} m ${f(trimR)} ${f(trimT + off + mlen)} l S`,
        ].join('\n');
      }

      const opsBytes = enc.encode(ops);
      const comp = compressed[i];

      // Page dict — MediaBox always [0 0 pageW pageH]; Trim/Bleed boxes consistent
      // with the actual artwork placement at (m, m).
      let pageDict = `<< /Type /Page /Parent ${pagesN} 0 R` +
        ` /MediaBox [0 0 ${pageW.toFixed(3)} ${pageH.toFixed(3)}]` +
        ` /TrimBox [${trimL.toFixed(3)} ${trimB.toFixed(3)} ${trimR.toFixed(3)} ${trimT.toFixed(3)}]`;
      if (bleedPt > 0) {
        pageDict += ` /BleedBox [${(trimL - bleedPt).toFixed(3)} ${(trimB - bleedPt).toFixed(3)} ` +
          `${(trimR + bleedPt).toFixed(3)} ${(trimT + bleedPt).toFixed(3)}]`;
      }
      pageDict += ` /Resources << /XObject << /Im0 ${o.imageN} 0 R >> >> /Contents ${o.contentN} 0 R >>\n`;

      startObj(o.pageN); push(pageDict); endObj();

      startObj(o.contentN);
      push(`<< /Length ${opsBytes.length} >>\nstream\n`);
      push(opsBytes);
      push('\nendstream\n');
      endObj();

      startObj(o.imageN);
      push(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH}` +
        ` /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`);
      push(comp);
      push('\nendstream\n');
      endObj();
    }

    // xref
    const totalObjs = nextObj - 1;
    const xrefOffset = offset;
    push(`xref\n0 ${totalObjs + 1}\n`);
    push('0000000000 65535 f \n');
    for (let i = 1; i <= totalObjs; i++) {
      push(`${String(xref[i] || 0).padStart(10, '0')} 00000 n \n`);
    }

    const id = hashHex(compressed);
    push(`trailer\n<< /Size ${totalObjs + 1} /Root ${catalogN} 0 R /Info ${infoN} 0 R` +
      ` /ID [<${id}> <${id}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  return { MM_TO_PT, rgbaToCmyk, assembleCmykPdf, pdfDate, pdfTextEscape };
});
