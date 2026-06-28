// Post-merge optimisation for the RGB (vector) path.
//
// The plugin builds a multi-page PDF by loading each frame's PDF separately and
// copyPages-ing them together. pdf-lib does NOT deduplicate objects across
// different source documents, so an identical embedded font program (or an
// image such as a repeated logo/photo) is stored once PER PAGE. For a multi-page
// CV with a full (non-subset) font this can add megabytes.
//
// dedupeStreams collapses byte-for-byte identical stream objects (font files,
// images, …) to a single copy and repoints every reference to it. It only ever
// merges streams that are provably identical (hash + full byte compare), so it
// can never change how the document renders.
//
// UMD: PDFLib is injected so this works both inlined in the browser (global
// PDFLib) and required from Node tests (require('pdf-lib')).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PDFMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  function bytesEqual(a, b) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function streamContents(obj) {
    if (typeof obj.getContents === 'function') {
      try { return obj.getContents(); } catch (e) { /* fall through */ }
    }
    return obj.contents || null;
  }

  // Returns the number of duplicate stream objects removed.
  function dedupeStreams(PDFLib, doc) {
    const { PDFStream, PDFDict, PDFArray, PDFRef } = PDFLib;
    const ctx = doc.context;

    // 1. Group streams by (length, hash); verify equality before treating as dup.
    const groups = new Map();                 // key -> [{ ref, bytes }]
    const remap = new Map();                   // dup ref.tag -> canonical PDFRef
    const dupRefs = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFStream)) continue;
      const bytes = streamContents(obj);
      if (!bytes || !bytes.length) continue;
      const key = bytes.length + ':' + fnv1a(bytes);
      const bucket = groups.get(key);
      if (!bucket) { groups.set(key, [{ ref, bytes }]); continue; }
      const match = bucket.find(e => bytesEqual(e.bytes, bytes));
      if (match) { remap.set(ref.tag, match.ref); dupRefs.push(ref); }
      else bucket.push({ ref, bytes });
    }
    if (!remap.size) return 0;

    // 2. Repoint every reference that points at a duplicate to its canonical ref.
    const fix = r => (r instanceof PDFRef && remap.has(r.tag)) ? remap.get(r.tag) : r;
    const visit = obj => {
      if (obj instanceof PDFArray) {
        for (let i = 0; i < obj.size(); i++) {
          const v = obj.get(i);
          const n = fix(v);
          if (n !== v) obj.set(i, n);
          else if (v instanceof PDFDict || v instanceof PDFArray) visit(v);
        }
        return;
      }
      const dict = obj instanceof PDFStream ? obj.dict : (obj instanceof PDFDict ? obj : null);
      if (!dict) return;
      for (const [k, v] of dict.entries()) {
        const n = fix(v);
        if (n !== v) dict.set(k, n);
        else if (v instanceof PDFDict || v instanceof PDFArray) visit(v);
      }
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);

    // 3. Drop the now-unreferenced duplicates.
    for (const ref of dupRefs) ctx.delete(ref);
    return remap.size;
  }

  return { dedupeStreams };
});
