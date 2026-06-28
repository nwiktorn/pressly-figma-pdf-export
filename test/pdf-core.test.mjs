// Node test harness for the pure CMYK PDF core. Run: npm test
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const PDFCore = require('../src/lib/pdf-core.js');

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

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
