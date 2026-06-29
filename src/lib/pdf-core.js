// Pure, environment-agnostic PDF building logic for the CMYK export path.
//
// UMD wrapper so the same source can be:
//   • inlined into ui.html (browser) where `pako` is a global, and
//   • required from Node test harnesses where `pako` is an npm dependency.
//
// Nothing here touches the DOM — inputs are plain typed arrays / numbers — which
// is what makes it unit-testable in Node without Figma or a browser.
(function (root, factory) {
  function resolvePako(root) {
    const roots = [root];
    if (typeof globalThis !== 'undefined') roots.push(globalThis);
    if (typeof self !== 'undefined') roots.push(self);
    if (typeof window !== 'undefined') roots.push(window);

    for (let i = 0; i < roots.length; i++) {
      const z = roots[i] && roots[i].pako;
      const mod = z && z.default && typeof z.default.deflate === 'function' ? z.default : z;
      if (mod && typeof mod.deflate === 'function' && typeof mod.inflate === 'function') return mod;
    }
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('pako'));
  } else {
    root.PDFCore = factory(resolvePako(root));
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

    // Image encoding: lossless Flate (default) or lossy DCTDecode (CMYK JPEG).
    const useJpeg = opts.compression === 'jpeg';
    const imageFilter = useJpeg ? 'DCTDecode' : 'FlateDecode';
    const encoded = pages.map(p => useJpeg
      ? encodeCmykJpeg(p.cmyk, p.imgW, p.imgH, opts.jpegQuality || 85)
      : pako.deflate(p.cmyk));

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
    info += ` /Creator (${pdfTextEscape(meta.creator || 'Pressly - PDF Export')})`;
    info += ` /Producer (Pressly - PDF Export)`;
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
      const comp = encoded[i];

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
        ` /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /${imageFilter} /Length ${comp.length} >>\nstream\n`);
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

    const id = hashHex(encoded);
    push(`trailer\n<< /Size ${totalObjs + 1} /Root ${catalogN} 0 R /Info ${infoN} 0 R` +
      ` /ID [<${id}> <${id}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  // ── Baseline CMYK JPEG encoder (DCTDecode) ──────────────────────────────────
  // A self-contained baseline (sequential, Huffman) JPEG encoder producing a
  // 4-component CMYK stream for embedding in a PDF with /Filter /DCTDecode.
  //
  // Convention: samples are stored INVERTED (255 - ink) and an Adobe APP14 marker
  // (transform 0) is written. This matches Photoshop/Acrobat CMYK JPEGs, which is
  // what PDF readers and prepress RIPs invert back on decode — so no /Decode array
  // is needed on the PDF image. (Verified by round-tripping through jpeg-js, which
  // implements the same Adobe heuristic as pdf.js/Acrobat.)
  //
  // The DCT / quantisation / Huffman internals follow the well-known public
  // implementation by Thinh Nguyen Quang / Andreas Ritter, generalised so all four
  // components share one quantisation table and one DC/AC Huffman pair.
  const ZIGZAG = [
    0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42,
    3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60,
    21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
  const STD_DC_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const STD_DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const STD_AC_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const STD_AC_VALUES = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa];

  function computeHuffmanTbl(nrcodes, values) {
    let code = 0, k = 0;
    const ht = [];
    for (let bits = 1; bits <= 16; bits++) {
      for (let j = 1; j <= nrcodes[bits]; j++) {
        ht[values[k]] = [bits, code]; // [length, code]
        k++; code++;
      }
      code <<= 1;
    }
    return ht;
  }

  function buildCategoryTables() {
    const category = new Array(65535);
    const bitcode = new Array(65535);
    let nrlower = 1, nrupper = 2;
    for (let cat = 1; cat <= 15; cat++) {
      for (let nr = nrlower; nr < nrupper; nr++) {
        category[32767 + nr] = cat; bitcode[32767 + nr] = [cat, nr];
      }
      for (let nrneg = -(nrupper - 1); nrneg <= -nrlower; nrneg++) {
        category[32767 + nrneg] = cat; bitcode[32767 + nrneg] = [cat, (nrupper - 1) + nrneg];
      }
      nrlower <<= 1; nrupper <<= 1;
    }
    return { category, bitcode };
  }

  function buildQuant(quality) {
    let sf;
    quality = Math.min(100, Math.max(1, quality || 85));
    sf = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
    const YQT = [
      16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
      14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
      18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
      49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
    const table = new Array(64);   // natural order quant table (for DQT)
    for (let i = 0; i < 64; i++) {
      let t = Math.floor((YQT[i] * sf + 50) / 100);
      table[ZIGZAG[i]] = Math.min(255, Math.max(1, t));
    }
    const aasf = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
    const fdtbl = new Array(64);
    let k = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        fdtbl[k] = 1.0 / (table[ZIGZAG[k]] * aasf[row] * aasf[col] * 8.0);
        k++;
      }
    }
    return { table, fdtbl };
  }

  function fdctAndQuant(data, fdtbl, out) {
    let d0, d1, d2, d3, d4, d5, d6, d7;
    let tmp0, tmp1, tmp2, tmp3, tmp4, tmp5, tmp6, tmp7, tmp10, tmp11, tmp12, tmp13, z1, z2, z3, z4, z5, z11, z13;
    for (let i = 0; i < 8; ++i) {
      const o = i * 8;
      d0 = data[o]; d1 = data[o + 1]; d2 = data[o + 2]; d3 = data[o + 3];
      d4 = data[o + 4]; d5 = data[o + 5]; d6 = data[o + 6]; d7 = data[o + 7];
      tmp0 = d0 + d7; tmp7 = d0 - d7; tmp1 = d1 + d6; tmp6 = d1 - d6;
      tmp2 = d2 + d5; tmp5 = d2 - d5; tmp3 = d3 + d4; tmp4 = d3 - d4;
      tmp10 = tmp0 + tmp3; tmp13 = tmp0 - tmp3; tmp11 = tmp1 + tmp2; tmp12 = tmp1 - tmp2;
      data[o] = tmp10 + tmp11; data[o + 4] = tmp10 - tmp11;
      z1 = (tmp12 + tmp13) * 0.707106781;
      data[o + 2] = tmp13 + z1; data[o + 6] = tmp13 - z1;
      tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
      z5 = (tmp10 - tmp12) * 0.382683433; z2 = 0.541196100 * tmp10 + z5; z4 = 1.306562965 * tmp12 + z5;
      z3 = tmp11 * 0.707106781; z11 = tmp7 + z3; z13 = tmp7 - z3;
      data[o + 5] = z13 + z2; data[o + 3] = z13 - z2; data[o + 1] = z11 + z4; data[o + 7] = z11 - z4;
    }
    for (let i = 0; i < 8; ++i) {
      d0 = data[i]; d1 = data[i + 8]; d2 = data[i + 16]; d3 = data[i + 24];
      d4 = data[i + 32]; d5 = data[i + 40]; d6 = data[i + 48]; d7 = data[i + 56];
      tmp0 = d0 + d7; tmp7 = d0 - d7; tmp1 = d1 + d6; tmp6 = d1 - d6;
      tmp2 = d2 + d5; tmp5 = d2 - d5; tmp3 = d3 + d4; tmp4 = d3 - d4;
      tmp10 = tmp0 + tmp3; tmp13 = tmp0 - tmp3; tmp11 = tmp1 + tmp2; tmp12 = tmp1 - tmp2;
      data[i] = tmp10 + tmp11; data[i + 32] = tmp10 - tmp11;
      z1 = (tmp12 + tmp13) * 0.707106781;
      data[i + 16] = tmp13 + z1; data[i + 48] = tmp13 - z1;
      tmp10 = tmp4 + tmp5; tmp11 = tmp5 + tmp6; tmp12 = tmp6 + tmp7;
      z5 = (tmp10 - tmp12) * 0.382683433; z2 = 0.541196100 * tmp10 + z5; z4 = 1.306562965 * tmp12 + z5;
      z3 = tmp11 * 0.707106781; z11 = tmp7 + z3; z13 = tmp7 - z3;
      data[i + 40] = z13 + z2; data[i + 24] = z13 - z2; data[i + 8] = z11 + z4; data[i + 56] = z11 - z4;
    }
    for (let i = 0; i < 64; ++i) {
      const v = data[i] * fdtbl[i];
      out[i] = v > 0 ? ((v + 0.5) | 0) : ((v - 0.5) | 0);
    }
    return out;
  }

  function encodeCmykJpeg(cmyk, width, height, quality) {
    const { table: QT, fdtbl } = buildQuant(quality);
    const DC_HT = computeHuffmanTbl(STD_DC_NRCODES, STD_DC_VALUES);
    const AC_HT = computeHuffmanTbl(STD_AC_NRCODES, STD_AC_VALUES);
    const { category, bitcode } = buildCategoryTables();

    const out = [];
    let byteNew = 0, bytePos = 7;
    const writeByte = b => out.push(b & 0xff);
    const writeWord = w => { writeByte(w >> 8); writeByte(w & 0xff); };
    const writeBits = bs => {
      const value = bs[1];
      let pos = bs[0] - 1;
      while (pos >= 0) {
        if (value & (1 << pos)) byteNew |= (1 << bytePos);
        pos--; bytePos--;
        if (bytePos < 0) {
          if (byteNew === 0xff) { writeByte(0xff); writeByte(0); } else writeByte(byteNew);
          bytePos = 7; byteNew = 0;
        }
      }
    };

    writeWord(0xffd8); // SOI

    // APP14 Adobe, transform 0 (signals CMYK should be inverted on decode)
    writeWord(0xffee); writeWord(14);
    'Adobe'.split('').forEach(c => writeByte(c.charCodeAt(0)));
    writeWord(100); writeWord(0); writeWord(0); writeByte(0);

    // DQT (one table, id 0)
    writeWord(0xffdb); writeWord(0x0043); writeByte(0);
    for (let i = 0; i < 64; i++) writeByte(QT[i]);

    // SOF0 — 4 components, all 1x1 sampling, quant table 0
    writeWord(0xffc0); writeWord(8 + 3 * 4); writeByte(8);
    writeWord(height); writeWord(width); writeByte(4);
    for (let c = 1; c <= 4; c++) { writeByte(c); writeByte(0x11); writeByte(0); }

    // DHT — DC table (class 0, id 0) + AC table (class 1, id 0)
    let dhtLen = 2;
    dhtLen += 1 + 16 + STD_DC_VALUES.length;
    dhtLen += 1 + 16 + STD_AC_VALUES.length;
    writeWord(0xffc4); writeWord(dhtLen);
    writeByte(0x00);
    for (let i = 1; i <= 16; i++) writeByte(STD_DC_NRCODES[i]);
    STD_DC_VALUES.forEach(writeByte);
    writeByte(0x10);
    for (let i = 1; i <= 16; i++) writeByte(STD_AC_NRCODES[i]);
    STD_AC_VALUES.forEach(writeByte);

    // SOS — 4 components, all using DC/AC table 0
    writeWord(0xffda); writeWord(6 + 2 * 4); writeByte(4);
    for (let c = 1; c <= 4; c++) { writeByte(c); writeByte(0x00); }
    writeByte(0); writeByte(63); writeByte(0);

    // Entropy-coded data
    const block = new Float64Array(64);
    const quantized = new Int32Array(64);
    const DC = [0, 0, 0, 0];

    const processBlock = (comp, bx, by) => {
      let k = 0;
      for (let row = 0; row < 8; row++) {
        const yy = Math.min(by + row, height - 1);
        for (let col = 0; col < 8; col++) {
          const xx = Math.min(bx + col, width - 1);
          // true ink → inverted (Adobe) → level shift by 128
          block[k++] = (255 - cmyk[(yy * width + xx) * 4 + comp]) - 128;
        }
      }
      fdctAndQuant(block, fdtbl, quantized);
      // reorder to zig-zag scan order
      const du = new Int32Array(64);
      for (let j = 0; j < 64; j++) du[ZIGZAG[j]] = quantized[j];

      const diff = du[0] - DC[comp];
      DC[comp] = du[0];
      if (diff === 0) writeBits(DC_HT[0]);
      else { writeBits(DC_HT[category[32767 + diff]]); writeBits(bitcode[32767 + diff]); }

      let end = 63;
      while (end > 0 && du[end] === 0) end--;
      if (end === 0) { writeBits(AC_HT[0x00]); return; }
      let i = 1;
      while (i <= end) {
        const start = i;
        while (du[i] === 0 && i <= end) i++;
        let run = i - start;
        if (run >= 16) {
          const n = run >> 4;
          for (let z = 0; z < n; z++) writeBits(AC_HT[0xf0]);
          run &= 0x0f;
        }
        const val = du[i];
        writeBits(AC_HT[(run << 4) + category[32767 + val]]);
        writeBits(bitcode[32767 + val]);
        i++;
      }
      if (end !== 63) writeBits(AC_HT[0x00]);
    };

    for (let by = 0; by < height; by += 8) {
      for (let bx = 0; bx < width; bx += 8) {
        for (let comp = 0; comp < 4; comp++) processBlock(comp, bx, by);
      }
    }

    // flush remaining bits with 1s
    if (bytePos >= 0) writeBits([bytePos + 1, (1 << (bytePos + 1)) - 1]);
    writeWord(0xffd9); // EOI
    return Uint8Array.from(out);
  }

  // ── Content-stream precision reducer ─────────────────────────────────────────

  // Returns false when bytes clearly cannot be a PDF operator stream:
  // any NUL byte (binary PDF data) or fewer than 85% printable ASCII + whitespace.
  function looksLikeOperatorStream(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return false;
    }
    if (bytes.length < 16) return true;
    let ok = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) ok++;
    }
    return ok / bytes.length >= 0.85;
  }

  // Advance `pos` past an inline image block (BI…ID…raw binary…EI).
  // Returns position just after EI, or n if not found.
  function _skipInlineImage(bytes, pos, n) {
    function isWS(b) { return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C; }
    while (pos < n - 2) {
      if (isWS(bytes[pos]) && bytes[pos + 1] === 0x49 && bytes[pos + 2] === 0x44 &&
          (pos + 3 >= n || isWS(bytes[pos + 3]))) {
        pos += 3;                                         // skip ws + 'I' + 'D'
        if (pos < n && isWS(bytes[pos])) pos++;           // skip 1-byte separator
        while (pos < n) {
          if (pos > 0 && isWS(bytes[pos - 1]) &&
              bytes[pos] === 0x45 && pos + 1 < n && bytes[pos + 1] === 0x49 &&
              (pos + 2 >= n || isWS(bytes[pos + 2]))) {
            return pos + 2;                               // after 'EI'
          }
          pos++;
        }
        return n;
      }
      pos++;
    }
    return n;
  }

  // Operator-aware precision reducer for a decoded PDF content stream.
  //
  // Tokenizes `bytes` per ISO 32000 §7.8.2 grammar. Rewrites only the numeric
  // operands of geometry/text operators to `opts.decimals` decimal places.
  // Everything else — literal strings (…), hex strings <…>, names /…, comments
  // %…, dicts << >>, inline images BI…ID…EI, colour-operator operands, and any
  // unrecognised token — is emitted byte-for-byte unchanged.
  //   bytes   Uint8Array of the DECODED (inflated) stream
  //   opts    { decimals: number }
  function reduceOperatorPrecision(bytes, opts) {
    const decimals = opts && opts.decimals != null ? opts.decimals : 2;

    const COLOUR = new Set(['g','G','rg','RG','k','K','sc','scn','SC','SCN','cs','CS']);
    const REDUCE = new Set([
      'm','l','c','v','y','re','h',                   // path construction
      'cm','w','M','J','j','i','d',                   // graphics state (numeric params)
      'Td','TD','Tm','Tc','Tw','Tz','TL','Ts','Tr','Tf', // text state & positioning
    ]);

    function isWS(b) {
      return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C;
    }

    function bstr(from, to) {
      let s = '';
      for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }

    function roundNum(str, d) {
      if (str.indexOf('.') === -1) return str;          // integer — untouched
      const v = parseFloat(str);
      if (!isFinite(v)) return str;
      const factor = Math.pow(10, d);
      const r = (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * factor) / factor;
      let s = r.toFixed(d).replace(/\.?0+$/, '');
      return s === '-0' || s === '' ? '0' : s;
    }

    function strBytes(s) {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    }

    const chunks = [];
    let lastCopied = 0, pos = 0;
    const n = bytes.length;
    let pending = [];  // {start, end, str}[] — nums buffered since last operator

    function pushRange(from, to) {
      if (to > from) chunks.push(bytes.subarray(from, to));
    }

    // Flush the buffered number tokens. If `reduce`, rewrite them; else keep verbatim.
    function flushPending(reduce) {
      if (reduce) {
        for (const { start, end, str } of pending) {
          pushRange(lastCopied, start);
          chunks.push(strBytes(roundNum(str, decimals)));
          lastCopied = end;
        }
      }
      pending = [];
    }

    while (pos < n) {
      const c = bytes[pos];

      if (isWS(c)) { pos++; continue; }

      if (c === 0x25) {                                 // comment % to EOL
        while (pos < n && bytes[pos] !== 0x0A && bytes[pos] !== 0x0D) pos++;
        continue;                                        // comments don't reset operand run
      }

      if (c === 0x28) {                                 // literal string (…)
        pos++;
        let depth = 1;
        while (pos < n && depth > 0) {
          const b = bytes[pos++];
          if (b === 0x5C) pos++;                        // backslash escape: skip next byte
          else if (b === 0x28) depth++;
          else if (b === 0x29) depth--;
        }
        pending = [];
        continue;
      }

      if (c === 0x3C) {                                 // << or <hex string>
        if (pos + 1 < n && bytes[pos + 1] === 0x3C) { pos += 2; pending = []; continue; }
        pos++;
        while (pos < n && bytes[pos] !== 0x3E) pos++;
        if (pos < n) pos++;
        pending = [];
        continue;
      }

      if (c === 0x3E) {                                 // > or >>
        if (pos + 1 < n && bytes[pos + 1] === 0x3E) pos++;
        pos++;
        pending = [];
        continue;
      }

      if (c === 0x2F) {                                 // name /…
        pos++;
        while (pos < n) {
          const b = bytes[pos];
          if (isWS(b) || b === 0x2F || b === 0x28 || b === 0x29 ||
              b === 0x3C || b === 0x3E || b === 0x5B || b === 0x5D ||
              b === 0x7B || b === 0x7D || b === 0x25) break;
          pos += b === 0x23 ? 3 : 1;                    // #xx hex escape counts as 3
        }
        pending = [];
        continue;
      }

      if (c === 0x5B || c === 0x5D || c === 0x7B || c === 0x7D) { // [ ] { }
        pos++;
        pending = [];
        continue;
      }

      // Number: [+-]?(\d+\.?\d*|\.d+)
      if ((c >= 0x30 && c <= 0x39) || c === 0x2E ||
          ((c === 0x2B || c === 0x2D) && pos + 1 < n &&
           (bytes[pos + 1] >= 0x30 && bytes[pos + 1] <= 0x39 || bytes[pos + 1] === 0x2E))) {
        const start = pos;
        if (c === 0x2B || c === 0x2D) pos++;
        while (pos < n && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
        if (pos < n && bytes[pos] === 0x2E) {
          pos++;
          while (pos < n && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
        }
        if (pos > start) pending.push({ start, end: pos, str: bstr(start, pos) });
        continue;
      }

      // Keyword / operator: [A-Za-z'"*]+
      if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x27 || c === 0x22) {
        const kwStart = pos;
        while (pos < n) {
          const b = bytes[pos];
          if ((b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) ||
              b === 0x2A || b === 0x27 || b === 0x22) pos++;
          else break;
        }
        const kw = bstr(kwStart, pos);
        if (kw === 'BI') {
          pending = [];
          pos = _skipInlineImage(bytes, pos, n);        // copy BI…EI verbatim
          continue;
        }
        flushPending(REDUCE.has(kw));
        continue;
      }

      pos++;                                             // unknown byte — skip
    }

    pushRange(lastCopied, n);

    let total = 0;
    for (const ch of chunks) total += ch.length;
    const result = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) { result.set(ch, off); off += ch.length; }
    return result;
  }

  return { MM_TO_PT, rgbaToCmyk, assembleCmykPdf, encodeCmykJpeg, pdfDate, pdfTextEscape, looksLikeOperatorStream, reduceOperatorPrecision };
});
