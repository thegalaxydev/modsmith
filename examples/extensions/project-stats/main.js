const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const walk = (nodes, out) => {
  for (const n of nodes) {
    if (n.dir) walk(n.children || [], out);
    else out.push(n.path);
  }
  return out;
};

modsmith.registerPanel('stats', async (root) => {
  const render = async () => {
    const tree = await modsmith.call('workspace.tree', { dir: 'src', depth: 8 });
    const files = walk(tree, []);
    const counts = new Map();
    for (const f of files) {
      const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '(none)';
      counts.set(ext, (counts.get(ext) || 0) + 1);
    }
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    const refresh = el('button', { textContent: 'Refresh', onclick: render });
    root.replaceChildren(
      el('div', { className: 'head' }, el('h2', { textContent: modsmith.context.workspace.name }), refresh),
      el('p', { className: 'mute', textContent: `${files.length} files under src` }),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', { textContent: 'Type' }), el('th', { textContent: 'Files' }))), el('tbody', {}, ...rows.map(([ext, n]) => el('tr', {}, el('td', { textContent: ext }), el('td', { textContent: String(n) })))))
    );
  };
  modsmith.onFilesChanged(render);
  await render();
});

modsmith.registerViewer('mcmeta', async (root, ctx) => {
  const render = async () => {
    const file = await modsmith.readFile(ctx.file);
    let pack;
    try {
      pack = JSON.parse(file.content).pack || {};
    } catch (err) {
      root.replaceChildren(el('p', { className: 'error', textContent: `pack.mcmeta is not valid JSON: ${err.message}` }));
      return;
    }
    const description = typeof pack.description === 'string' ? pack.description : JSON.stringify(pack.description);
    root.replaceChildren(
      el('h2', { textContent: 'Pack metadata' }),
      el('dl', {}, el('dt', { textContent: 'Pack format' }), el('dd', { textContent: String(pack.pack_format ?? 'not set') }), el('dt', { textContent: 'Description' }), el('dd', { textContent: description ?? 'not set' })),
      el('p', { className: 'mute', textContent: ctx.file })
    );
  };
  modsmith.onFilesChanged(render);
  await render();
});
