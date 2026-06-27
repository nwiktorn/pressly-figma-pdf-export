figma.showUI(__html__, { width: 400, height: 660, title: 'PDF Export Pro' });

function getFrames() {
  return figma.currentPage.children
    .filter(n => ['FRAME', 'COMPONENT', 'SECTION'].includes(n.type))
    .map(n => ({
      id: n.id,
      name: n.name,
      width: Math.round(n.width),
      height: Math.round(n.height),
    }));
}

figma.ui.postMessage({ type: 'init', frames: getFrames() });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export') {
    const { frameIds, format, scale } = msg;
    const results = [];

    for (let i = 0; i < frameIds.length; i++) {
      const node = figma.getNodeById(frameIds[i]);
      if (!node) continue;

      figma.ui.postMessage({
        type: 'progress',
        current: i + 1,
        total: frameIds.length,
        name: node.name,
      });

      const exportSettings = format === 'PNG'
        ? { format: 'PNG', constraint: { type: 'SCALE', value: Math.min(scale || 3, 4) } }
        : { format: 'PDF' };

      const bytes = await node.exportAsync(exportSettings);
      results.push({
        name: node.name,
        bytes: Array.from(bytes),
        width: node.width,
        height: node.height,
      });
    }

    figma.ui.postMessage({ type: 'exportDone', data: results });
  }

  if (msg.type === 'close') figma.closePlugin();
};
