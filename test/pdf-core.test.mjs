// Node test harness for the pure CMYK PDF core. Run: npm test
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as PDFLib from 'pdf-lib';
const { PDFDocument, PDFName, PDFRawStream } = PDFLib;

const require = createRequire(import.meta.url);
const PDFCore = require('../src/lib/pdf-core.js');
const PDFMerge = require('../src/lib/pdf-merge.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const dec = new TextDecoder('latin1');
function makeCmykPage(w, h, ptW, ptH, bleedPt) {
  // Solid mid-gray CMYK plane.
  const cmyk = new Uint8Array(w * h * 4).fill(40);
  return { cmyk, imgW: w, imgH: h, ptW, ptH, bleedPt: bleedPt || 0 };
}

console.log('pdf-core');

await test('rgbaToCmyk: white→0000, black→K only', () => {
  const white = PDFCore.rgbaToCmyk(new Uint8Array([255, 255, 255, 255]), 1, 1, 400);
  assert.deepEqual([...white], [0, 0, 0, 0]);
  const black = PDFCore.rgbaToCmyk(new Uint8Array([0, 0, 0, 255]), 1, 1, 400);
  assert.deepEqual([...black], [0, 0, 0, 255]);
});

await test('rgbaToCmyk: pure red = magenta+yellow', () => {
  const red = PDFCore.rgbaToCmyk(new Uint8Array([255, 0, 0, 255]), 1, 1, 400);
  assert.equal(red[0], 0);            // C
  assert.equal(red[1], 255);          // M
  assert.equal(red[2], 255);          // Y
  assert.equal(red[3], 0);            // K
});

await test('rgbaToCmyk: ink limit reduces total coverage', () => {
  // Saturated blue would be C+M heavy; cap at 200%.
  const out = PDFCore.rgbaToCmyk(new Uint8Array([10, 10, 200, 255]), 1, 1, 200);
  const total = (out[0] + out[1] + out[2] + out[3]) / 255 * 100;
  assert.ok(total <= 200.5, `total ink ${total.toFixed(1)} should be ≤200%`);
});

await test('assembleCmykPdf: parseable, correct page count & size', async () => {
  const pages = [makeCmykPage(100, 50, 300, 150), makeCmykPage(80, 80, 240, 240)];
  const bytes = PDFCore.assembleCmykPdf(pages, { meta: { title: 'T' } });
  const s = dec.decode(bytes);
  assert.ok(s.startsWith('%PDF-1.5'), 'header');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'EOF');
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
  assert.equal(doc.getPageCount(), 2);
  const p0 = doc.getPage(0);
  assert.equal(Math.round(p0.getWidth()), 300);
  assert.equal(Math.round(p0.getHeight()), 150);
});

await test('assembleCmykPdf: metadata written to Info (CMYK path no longer drops it)', async () => {
  const bytes = PDFCore.assembleCmykPdf([makeCmykPage(40, 40, 120, 120)], {
    meta: { title: 'Hello Print', author: 'Jan Kowalski' },
  });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), 'Hello Print');
  assert.equal(doc.getAuthor(), 'Jan Kowalski');
});

await test('assembleCmykPdf: bleed expands MediaBox and adds BleedBox/TrimBox', async () => {
  const bleedPt = 3 * PDFCore.MM_TO_PT;
  const bytes = PDFCore.assembleCmykPdf([makeCmykPage(100, 100, 300, 300, bleedPt)], {});
  const s = dec.decode(bytes);
  assert.ok(/\/TrimBox \[/.test(s), 'TrimBox present');
  assert.ok(/\/BleedBox \[/.test(s), 'BleedBox present');
  const doc = await PDFDocument.load(bytes);
  // MediaBox must be larger than the 300pt trim because of bleed margin.
  assert.ok(doc.getPage(0).getWidth() > 300, 'media wider than trim with bleed');
});

await test('assembleCmykPdf: crop marks add registration color ops, no clip', () => {
  const bytes = PDFCore.assembleCmykPdf([makeCmykPage(100, 100, 300, 300)], { cropMarks: true });
  const s = dec.decode(bytes);
  assert.ok(s.includes('1 1 1 1 K'), 'registration stroke color present');
  assert.ok(/ l S/.test(s), 'line/stroke ops present');
});

await test('assembleCmykPdf: PDF/X claims conformance only with embedded ICC', async () => {
  const fakeIcc = new Uint8Array(2048).fill(7); // stand-in profile bytes
  const withIcc = PDFCore.assembleCmykPdf([makeCmykPage(40, 40, 120, 120)], {
    pdfx: true, iccProfile: fakeIcc, meta: { title: 'X' },
  });
  let s = dec.decode(withIcc);
  assert.ok(s.includes('/OutputIntents'), 'OutputIntents present');
  assert.ok(s.includes('/GTS_PDFX'), 'OutputIntent subtype');
  assert.ok(s.includes('/DestOutputProfile'), 'embedded profile referenced');
  assert.ok(s.includes('GTS_PDFXVersion'), 'PDF/X version claimed');
  await PDFDocument.load(withIcc); // still parseable

  // Without an ICC, we must NOT falsely claim PDF/X conformance.
  const noIcc = PDFCore.assembleCmykPdf([makeCmykPage(40, 40, 120, 120)], { pdfx: true });
  s = dec.decode(noIcc);
  assert.ok(!s.includes('GTS_PDFXVersion'), 'no false PDF/X claim without ICC');
});

await test('assembleCmykPdf: trailer has /ID (required by PDF/X)', () => {
  const bytes = PDFCore.assembleCmykPdf([makeCmykPage(40, 40, 120, 120)], {});
  const s = dec.decode(bytes);
  assert.ok(/\/ID \[<[0-9A-F]+> <[0-9A-F]+>\]/.test(s), '/ID array present');
});

await test('bundled FOGRA39 profile: valid CMYK printer ICC', async () => {
  const { readFile } = await import('node:fs/promises');
  const b = await readFile(new URL('../assets/CoatedFOGRA39.icc', import.meta.url));
  const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  assert.equal(b.readUInt32BE(0), b.length, 'size field matches file');
  assert.equal(tag(12), 'prtr', 'output/printer class');
  assert.equal(tag(16), 'CMYK', 'CMYK data color space');
  assert.equal(tag(36), 'acsp', 'ICC signature');
});

await test('ICC deflate→base64→inflate roundtrip (build embedding)', async () => {
  const { readFile } = await import('node:fs/promises');
  const pako = require('pako');
  const raw = new Uint8Array(await readFile(new URL('../assets/CoatedFOGRA39.icc', import.meta.url)));
  const b64 = Buffer.from(pako.deflate(raw)).toString('base64');
  const back = pako.inflate(Buffer.from(b64, 'base64'));
  assert.equal(back.length, raw.length, 'length preserved');
  assert.deepEqual(back.slice(0, 64), raw.slice(0, 64), 'header bytes preserved');
});

await test('PDF/X with real FOGRA39: conformant + embeds profile', async () => {
  const { readFile } = await import('node:fs/promises');
  const icc = new Uint8Array(await readFile(new URL('../assets/CoatedFOGRA39.icc', import.meta.url)));
  const bytes = PDFCore.assembleCmykPdf([makeCmykPage(60, 60, 180, 180)], {
    pdfx: true, iccProfile: icc, meta: { title: 'Print job' },
    outputCondition: 'Coated FOGRA39 (ISO 12647-2:2004)',
  });
  const s = dec.decode(bytes);
  assert.ok(s.includes('GTS_PDFXVersion'), 'claims PDF/X');
  assert.ok(s.includes('/DestOutputProfile'), 'embeds output profile');
  assert.ok(s.includes('FOGRA39'), 'FOGRA39 output condition');
  await PDFDocument.load(bytes);
});

const jpeg = require('jpeg-js');

function solidCmyk(w, h, r, g, b) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255; }
  return PDFCore.rgbaToCmyk(rgba, w, h, 400);
}

await test('encodeCmykJpeg: valid JPEG markers + Adobe APP14', () => {
  const jpg = PDFCore.encodeCmykJpeg(solidCmyk(16, 16, 128, 64, 32), 16, 16, 85);
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);                 // SOI
  assert.equal(jpg[jpg.length - 2], 0xff); assert.equal(jpg[jpg.length - 1], 0xd9); // EOI
  const s = String.fromCharCode(...jpg.slice(0, 64));
  assert.ok(s.includes('Adobe'), 'Adobe APP14 marker present');
});

await test('encodeCmykJpeg: round-trips colours through jpeg-js (PDF-reader heuristic)', () => {
  const w = 16, h = 16;
  const cases = [
    [[255, 255, 255], [255, 255, 255]],
    [[0, 0, 0], [0, 0, 0]],
    [[255, 0, 0], [255, 0, 0]],
    [[0, 128, 255], [0, 128, 255]],
  ];
  for (const [inRgb, expect] of cases) {
    const jpg = PDFCore.encodeCmykJpeg(solidCmyk(w, h, ...inRgb), w, h, 92);
    const dec = jpeg.decode(Buffer.from(jpg), { formatAsRGBA: true, tolerantDecoding: true });
    const i = ((h / 2) * w + (w / 2)) * 4;
    const out = [dec.data[i], dec.data[i + 1], dec.data[i + 2]];
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(out[c] - expect[c]) <= 6,
        `${inRgb} → got ${out} expected ~${expect} (no inversion/scramble)`);
    }
  }
});

await test('assembleCmykPdf: JPEG path parses, uses DCTDecode, beats Flate on size', async () => {
  // Continuous-tone (gradient) image — the case raster JPEG is meant for.
  const w = 128, h = 128;
  const cmyk = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    cmyk[i] = (x / w * 255) | 0; cmyk[i + 1] = (y / h * 255) | 0;
    cmyk[i + 2] = ((x + y) / (w + h) * 255) | 0; cmyk[i + 3] = 0;
  }
  const page = { cmyk, imgW: w, imgH: h, ptW: 200, ptH: 200, bleedPt: 0 };

  const flate = PDFCore.assembleCmykPdf([page], { compression: 'flate' });
  const jpg = PDFCore.assembleCmykPdf([page], { compression: 'jpeg', jpegQuality: 80 });
  const s = dec.decode(jpg);
  assert.ok(s.includes('/DCTDecode'), 'image uses DCTDecode');
  assert.ok(jpg.length < flate.length / 2, `JPEG (${jpg.length}) should be << Flate (${flate.length})`);
  await PDFDocument.load(jpg);
});

await test('dedupeStreams: collapses identical streams and repoints references', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const payload = new Uint8Array(4000).fill(7);
  const mk = b => ctx.register(PDFRawStream.of(ctx.obj({ Length: b.length }), b));
  const r1 = mk(payload);
  const r2 = mk(payload.slice());                 // identical bytes → duplicate
  const r3 = mk(new Uint8Array(4000).fill(9));     // different → kept
  const page = doc.addPage();
  page.node.set(PDFName.of('S1'), r1);
  page.node.set(PDFName.of('S2'), r2);
  page.node.set(PDFName.of('S3'), r3);

  const removed = PDFMerge.dedupeStreams(PDFLib, doc);
  assert.equal(removed, 1, 'one duplicate removed');
  assert.equal(page.node.get(PDFName.of('S2')), r1, 'S2 repointed to canonical');
  assert.equal(page.node.get(PDFName.of('S3')), r3, 'distinct stream untouched');
  await PDFDocument.load(await doc.save()); // still valid
});

await test('dedupeStreams: no-op when there are no duplicates', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const mk = b => ctx.register(PDFRawStream.of(ctx.obj({ Length: b.length }), b));
  const page = doc.addPage();
  page.node.set(PDFName.of('A'), mk(new Uint8Array(100).fill(1)));
  page.node.set(PDFName.of('B'), mk(new Uint8Array(100).fill(2)));
  assert.equal(PDFMerge.dedupeStreams(PDFLib, doc), 0);
});

// Realistic end-to-end check using a full (non-subset) embedded font, mirroring
// the plugin's "load each frame separately, then merge" flow. Skipped if the
// font / fontkit aren't available so the suite stays portable.
{
  const ARIAL = 'C:/Windows/Fonts/arial.ttf';
  let fontkit = null;
  try { fontkit = require('@pdf-lib/fontkit'); fontkit = fontkit.default || fontkit; } catch (e) {}
  if (fontkit && existsSync(ARIAL)) {
    await test('dedupeStreams: multi-page merge with full font shrinks a lot', async () => {
      const arial = readFileSync(ARIAL);
      const makePage = async t => {
        const d = await PDFDocument.create();
        d.registerFontkit(fontkit);
        const f = await d.embedFont(arial, { subset: false });
        d.addPage([400, 600]).drawText(t, { x: 40, y: 540, size: 18, font: f });
        return new Uint8Array(await d.save());
      };
      const merged = await PDFDocument.create();
      for (const t of ['CV', 'Exp', 'Edu', 'Skills', 'Contact']) {
        const src = await PDFDocument.load(await makePage(t));
        (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
      }
      const before = await merged.save();
      PDFMerge.dedupeStreams(PDFLib, merged);
      const after = await merged.save();
      assert.ok(after.length < before.length * 0.4,
        `dedup should cut size hard: ${before.length} → ${after.length}`);
      assert.equal((await PDFDocument.load(after)).getPageCount(), 5, 'all pages preserved');
    });
  } else {
    console.log('  ⊘ dedupeStreams full-font merge (skipped: font/fontkit unavailable)');
  }
}

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
