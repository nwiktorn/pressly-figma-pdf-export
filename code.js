const EXPORTABLE = ['FRAME', 'COMPONENT', 'SECTION'];
const SETTINGS_KEY = 'pressly-pdf-export-settings';
const THUMB_WIDTH = 64; // px wide preview per frame
const DEFAULT_UI_SIZE = { width: 900, height: 660 };
const MIN_UI_SIZE = { width: 760, height: 520 };
const MAX_UI_SIZE = { width: 1200, height: 860 };

let cachedSettings = null;

figma.showUI(__html__, { ...DEFAULT_UI_SIZE, title: 'Pressly - PDF Export' });

function clampUiSize(size) {
  const width = Math.round(Number(size && size.width) || DEFAULT_UI_SIZE.width);
  const height = Math.round(Number(size && size.height) || DEFAULT_UI_SIZE.height);
  return {
    width: Math.min(MAX_UI_SIZE.width, Math.max(MIN_UI_SIZE.width, width)),
    height: Math.min(MAX_UI_SIZE.height, Math.max(MIN_UI_SIZE.height, height)),
  };
}

function getFrames() {
  return figma.currentPage.children
    .filter(n => EXPORTABLE.includes(n.type))
    .map(n => ({
      id: n.id,
      name: n.name,
      width: Math.round(n.width),
      height: Math.round(n.height),
    }));
}

function getSelectedFrameIds() {
  return figma.currentPage.selection
    .filter(n => EXPORTABLE.includes(n.type))
    .map(n => n.id);
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
  const frames = getFrames();
  const selectedFrameIds = getSelectedFrameIds();
  if (!cachedSettings) {
    try { cachedSettings = await figma.clientStorage.getAsync(SETTINGS_KEY); } catch (e) {}
  }
  figma.ui.postMessage({ type: 'init', frames, selectedFrameIds, settings: cachedSettings || null });
  sendThumbnails(frames);
}

async function start() {
  try { cachedSettings = await figma.clientStorage.getAsync(SETTINGS_KEY); } catch (e) {}
  const uiSize = clampUiSize(cachedSettings && cachedSettings.uiSize);
  if (uiSize.width !== DEFAULT_UI_SIZE.width || uiSize.height !== DEFAULT_UI_SIZE.height) {
    figma.ui.resize(uiSize.width, uiSize.height);
  }
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

  if (msg.type === 'resizeUi') {
    const size = clampUiSize(msg);
    figma.ui.resize(size.width, size.height);
    return;
  }

  if (msg.type === 'saveUiSize') {
    const size = clampUiSize(msg);
    cachedSettings = { ...(cachedSettings || {}), uiSize: size };
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
