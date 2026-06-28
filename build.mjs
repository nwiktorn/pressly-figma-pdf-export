// Build script for Pressly - PDF Export.
//
// Figma plugin UIs are a single self-contained HTML document with no access to
// the local filesystem or relative URLs. To avoid depending on a CDN at runtime
// (which newer Figma blocks unless declared in manifest.networkAccess), we inline
// the vendored libraries directly into the HTML at build time.
//
//   src/ui.html  --(inject libs)-->  ui.html   (referenced by manifest.json)
//
// Usage:
//   node build.mjs           one-off build
//   node build.mjs --watch    rebuild on src changes

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Vendored libraries, inlined in order. Each must self-register on window.
const VENDOR = [
  { name: 'pdf-lib', path: 'node_modules/pdf-lib/dist/pdf-lib.min.js' },
  { name: 'jszip', path: 'node_modules/jszip/dist/jszip.min.js' },
  { name: 'pako', path: 'node_modules/pako/dist/pako.min.js' },
];

// First-party modules, inlined after the vendor libs (they depend on `pako`).
const APP_MODULES = [
  { name: 'pdf-core', path: 'src/lib/pdf-core.js' },
  { name: 'pdf-merge', path: 'src/lib/pdf-merge.js' },
];

// Bundled default CMYK output profile for PDF/X. ECI's Coated FOGRA39 is free to
// use and redistribute (see NOTICE). Stored deflated+base64 and inflated at load.
const ICC_PROFILE = { path: 'assets/CoatedFOGRA39.icc', name: 'Coated FOGRA39 (ISO 12647-2:2004)' };

const VENDOR_MARKER = '<!-- @INJECT:VENDOR_LIBS -->';
const MODULES_MARKER = '<!-- @INJECT:APP_MODULES -->';
const ICC_MARKER = '<!-- @INJECT:ICC_PROFILE -->';

async function buildIccBlock() {
  const { deflate } = await import('pako');
  const raw = await readFile(join(root, ICC_PROFILE.path));
  const b64 = Buffer.from(deflate(raw)).toString('base64');
  // Runs after pako (vendor) is inlined; exposes the profile to the export code.
  return `<!-- bundled ICC: ${ICC_PROFILE.name} -->\n<script>(function(){` +
    `var b="${b64}",s=atob(b),a=new Uint8Array(s.length);` +
    `for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);` +
    `window.__ICC_CMYK__=pako.inflate(a);` +
    `window.__ICC_CMYK_NAME__=${JSON.stringify(ICC_PROFILE.name)};` +
    `})();</script>`;
}

async function inlineScripts(list) {
  const parts = [];
  for (const item of list) {
    const code = await readFile(join(root, item.path), 'utf8');
    parts.push(`<!-- ${item.name} -->\n<script>${code}</script>`);
  }
  return parts.join('\n');
}

async function build() {
  const src = await readFile(join(root, 'src/ui.html'), 'utf8');
  for (const marker of [VENDOR_MARKER, MODULES_MARKER, ICC_MARKER]) {
    if (!src.includes(marker)) {
      throw new Error(`Injection marker "${marker}" not found in src/ui.html`);
    }
  }
  const vendor = await inlineScripts(VENDOR);
  const modules = await inlineScripts(APP_MODULES);
  const icc = await buildIccBlock();
  const banner = '<!-- GENERATED FILE — do not edit. Source: src/ui.html. Build: npm run build -->';
  const out = `${banner}\n${src
    .replace(VENDOR_MARKER, vendor)
    .replace(MODULES_MARKER, modules)
    .replace(ICC_MARKER, icc)}`;
  await writeFile(join(root, 'ui.html'), out, 'utf8');
  const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
  console.log(`✓ built ui.html (${kb} KB, inlined ${VENDOR.length} libs + ${APP_MODULES.length} modules + ICC)`);
}

await build();

if (process.argv.includes('--watch')) {
  const { default: chokidar } = await import('chokidar');
  console.log('watching src/ …');
  chokidar.watch(join(root, 'src')).on('change', () => {
    build().catch(err => console.error('build failed:', err.message));
  });
}
