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

  // Walk the page resources to collect refs for Type3 CharProcs and Form XObjects.
  function _walkResources(PDFLib, ctx, resVal, allowed) {
    const { PDFName, PDFRef, PDFArray } = PDFLib;
    const res = (resVal instanceof PDFRef) ? ctx.lookup(resVal) : resVal;
    if (!res || typeof res.get !== 'function') return;

    const fontDictRaw = res.get(PDFName.of('Font'));
    const fontDict = (fontDictRaw instanceof PDFRef) ? ctx.lookup(fontDictRaw) : fontDictRaw;
    if (fontDict && typeof fontDict.entries === 'function') {
      for (const [, fv] of fontDict.entries()) {
        const fobj = (fv instanceof PDFRef) ? ctx.lookup(fv) : fv;
        if (!fobj || typeof fobj.get !== 'function') continue;
        const sub = fobj.get(PDFName.of('Subtype'));
        if (sub && sub.toString() === '/Type3') {
          const cpRaw = fobj.get(PDFName.of('CharProcs'));
          const cp = (cpRaw instanceof PDFRef) ? ctx.lookup(cpRaw) : cpRaw;
          if (cp && typeof cp.entries === 'function') {
            for (const [, cv] of cp.entries()) {
              if (cv instanceof PDFRef) allowed.add(cv.tag);
            }
          }
        }
      }
    }

    const xoDictRaw = res.get(PDFName.of('XObject'));
    const xoDict = (xoDictRaw instanceof PDFRef) ? ctx.lookup(xoDictRaw) : xoDictRaw;
    if (xoDict && typeof xoDict.entries === 'function') {
      for (const [, xv] of xoDict.entries()) {
        const xobj = (xv instanceof PDFRef) ? ctx.lookup(xv) : xv;
        if (!xobj || typeof xobj.get !== 'function') continue;
        const sub = xobj.get(PDFName.of('Subtype'));
        if (sub && sub.toString() === '/Form') {
          if (xv instanceof PDFRef) allowed.add(xv.tag);
          _walkResources(PDFLib, ctx, xobj.get(PDFName.of('Resources')), allowed);
        }
      }
    }
  }

  // Walk the document structure and collect refs that are safe to process as
  // operator streams: page /Contents, Type3 /CharProcs, Form XObjects.
  // Everything else (images, ICC profiles, metadata, font data) is excluded.
  function _collectAllowedRefs(PDFLib, ctx, doc) {
    const { PDFName, PDFRef, PDFArray } = PDFLib;
    const allowed = new Set();

    function addContents(val) {
      if (!val) return;
      const obj = (val instanceof PDFRef) ? ctx.lookup(val) : val;
      if (val instanceof PDFRef) {
        if (obj instanceof PDFArray) {
          for (let i = 0; i < obj.size(); i++) {
            const item = obj.get(i);
            if (item instanceof PDFRef) allowed.add(item.tag);
          }
        } else {
          allowed.add(val.tag);  // ref points directly to a stream
        }
      } else if (val instanceof PDFArray) {
        for (let i = 0; i < val.size(); i++) {
          const item = val.get(i);
          if (item instanceof PDFRef) allowed.add(item.tag);
        }
      }
    }

    for (const page of doc.getPages()) {
      const node = page.node;
      addContents(node.get(PDFName.of('Contents')));
      _walkResources(PDFLib, ctx, node.get(PDFName.of('Resources')), allowed);
    }

    return allowed;
  }

  // Reduce coordinate precision in all operator streams of `doc`, then re-deflate
  // at zlib level 9. Only processes streams on an explicit allowlist built by
  // walking the document structure (page /Contents, Type3 /CharProcs, Form
  // XObjects). Binary streams such as ICC profiles or image data are never touched.
  //   PDFLib   pdf-lib module (injected)
  //   pako     pako module (injected)
  //   PDFCore  pdf-core.js module (injected; provides reduceOperatorPrecision)
  //   doc      PDFDocument instance to modify in place
  //   opts     { decimals: number }  — 2 = standard, 1 = maximum
  function optimizeStreams(PDFLib, pako, PDFCore, doc, opts) {
    const decimals = opts && opts.decimals != null ? opts.decimals : 2;
    const { PDFName, PDFNumber, PDFRawStream, PDFStream } = PDFLib;
    const ctx = doc.context;

    const allowed = _collectAllowedRefs(PDFLib, ctx, doc);
    let processed = 0, bytesSaved = 0;

    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!allowed.has(ref.tag)) continue;
      if (!(obj instanceof PDFStream)) continue;

      const raw = streamContents(obj);
      if (!raw || !raw.length) continue;

      const filterVal = obj.dict.get(PDFName.of('Filter'));
      let decoded;
      try {
        if (!filterVal) {
          decoded = raw;
        } else if (filterVal.toString() === '/FlateDecode') {
          decoded = pako.inflate(raw);
        } else {
          continue;                 // other filter (LZW etc.) — skip safely
        }
      } catch (e) { continue; }

      if (!PDFCore.looksLikeOperatorStream(decoded)) continue;

      let reduced;
      try { reduced = PDFCore.reduceOperatorPrecision(decoded, { decimals }); }
      catch (e) { continue; }

      const deflated = pako.deflate(reduced, { level: 9 });

      // Build a new stream dict: copy all keys except Filter / Length / DecodeParms,
      // then set the new values.
      const newDict = ctx.obj({});
      for (const [k, v] of obj.dict.entries()) {
        const ks = k.toString();
        if (ks !== '/Filter' && ks !== '/Length' && ks !== '/DecodeParms') newDict.set(k, v);
      }
      newDict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      newDict.set(PDFName.of('Length'), PDFNumber.of(deflated.length));
      ctx.assign(ref, PDFRawStream.of(newDict, deflated));

      bytesSaved += raw.length - deflated.length;
      processed++;
    }

    return { processed, bytesSaved };
  }

  return { dedupeStreams, optimizeStreams };
});
