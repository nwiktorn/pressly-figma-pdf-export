const EXPORTABLE = ['FRAME', 'COMPONENT'];
const WALKABLE = ['SECTION', 'GROUP'];
const SETTINGS_KEY = 'pressly-pdf-export-settings';
const THUMB_WIDTH = 64; // px wide preview per frame

let cachedSettings = null;

figma.showUI(__html__, { width: 900, height: 660, title: 'Pressly - PDF Export' });

function frameInfo(node, sectionName = '') {
  return {
    id: node.id,
    name: node.name,
    sectionName,
    width: Math.round(node.width),
    height: Math.round(node.height),
  };
}

function collectExportableFrames(nodes, out = [], sectionName = '') {
  for (const node of nodes) {
    const nextSectionName = node.type === 'SECTION' ? node.name : sectionName;
    if (EXPORTABLE.includes(node.type)) {
      out.push(frameInfo(node, sectionName));
      continue;
    }
    if (WALKABLE.includes(node.type) && node.children && node.children.length) {
      collectExportableFrames(node.children, out, nextSectionName);
    }
  }
  return out;
}

function getFrames() {
  return collectExportableFrames(figma.currentPage.children);
}

function getSelectedFrameIds() {
  return collectExportableFrames(figma.currentPage.selection).map(n => n.id);
}

// Send small PNG previews lazily so the list renders instantly, then fills in.
async function sendThumbnails(frames) {
  for (const f of frames) {
    const node = await figma.getNodeByIdAsync(f.id);
    if (!node || typeof node.exportAsync !== 'function') continue;
    try {
      const bytes = await node.exportAsync({
        format: 'PNG', constraint: { type: 'WIDTH', value: THUMB_WIDTH },
      });
      figma.ui.postMessage({ type: 'thumb', id: f.id, bytes: Array.from(bytes) });
    } catch (err) { /* a frame may be too small/large to preview; skip it */ }
  }
}

async function pushInit() {
  let frames = [];
  let selectedFrameIds = [];
  try {
    frames = getFrames();
    selectedFrameIds = getSelectedFrameIds();
  } catch (err) {
    figma.ui.postMessage({
      type: 'scanError',
      message: String(err && err.message ? err.message : err),
    });
  }
  if (!cachedSettings) {
    try { cachedSettings = await figma.clientStorage.getAsync(SETTINGS_KEY); } catch (e) {}
  }
  figma.ui.postMessage({ type: 'init', frames, selectedFrameIds, settings: cachedSettings || null });
  sendThumbnails(frames);
}

async function start() {
  try { cachedSettings = await figma.clientStorage.getAsync(SETTINGS_KEY); } catch (e) {}
  pushInit();
}

start();

// Re-scan when the user switches/edits the page so the frame list stays fresh.
figma.on('currentpagechange', () => { pushInit(); });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'refresh') {
    pushInit();
    return;
  }

  if (msg.type === 'saveSettings') {
    cachedSettings = msg.settings;
    try { await figma.clientStorage.setAsync(SETTINGS_KEY, cachedSettings); } catch (e) {}
    return;
  }

  if (msg.type === 'export') {
    const { frameIds, format, scale } = msg;
    const results = [];

    for (let i = 0; i < frameIds.length; i++) {
      // dynamic-page documentAccess requires the async node getter.
      const node = await figma.getNodeByIdAsync(frameIds[i]);
      if (!node || typeof node.exportAsync !== 'function') continue;

      figma.ui.postMessage({
        type: 'progress',
        current: i + 1,
        total: frameIds.length,
        name: node.name,
      });

      const exportSettings = format === 'PNG'
        ? { format: 'PNG', constraint: { type: 'SCALE', value: Math.min(scale || 3, 4) } }
        : { format: 'PDF' };

      try {
        const bytes = await node.exportAsync(exportSettings);
        results.push({
          name: node.name,
          bytes: Array.from(bytes),
          width: node.width,
          height: node.height,
        });
      } catch (err) {
        figma.ui.postMessage({
          type: 'exportError',
          name: node.name,
          message: String(err && err.message ? err.message : err),
        });
      }
    }

    figma.ui.postMessage({ type: 'exportDone', data: results });
    return;
  }

  if (msg.type === 'close') figma.closePlugin();
};
