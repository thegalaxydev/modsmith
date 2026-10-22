(() => {
  const pending = new Map();
  const viewers = new Map();
  const panels = new Map();
  const themeListeners = new Set();
  const fileListeners = new Set();
  const bridgeListeners = new Set();
  let seq = 0;
  let context = null;
  const send = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      parent.postMessage(Object.assign({ __modsmith: true, type, id }, payload), '*');
    });
  const applyTheme = (vars) => {
    for (const [k, v] of Object.entries(vars || {})) document.documentElement.style.setProperty(k, v);
  };
  const start = async () => {
    const root = document.getElementById('root');
    const fn = (context.kind === 'viewer' ? viewers : panels).get(context.contribution);
    if (!fn) {
      root.textContent = 'This extension did not register the ' + context.kind + ' ' + context.contribution + '.';
      return;
    }
    try {
      await fn(root, context);
    } catch (err) {
      root.textContent = String((err && err.message) || err);
      send('error', { message: String((err && err.stack) || err) });
    }
  };
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || !m.__modsmith) return;
    if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.value);
    } else if (m.type === 'init' && !context) {
      context = Object.freeze(m.context);
      applyTheme(m.theme);
      start();
    } else if (m.type === 'theme') {
      applyTheme(m.vars);
      themeListeners.forEach((f) => f(m.vars));
    } else if (m.type === 'filesChanged') {
      fileListeners.forEach((f) => f());
    } else if (m.type === 'bridgeEvent') {
      bridgeListeners.forEach((f) => f(m.event, m.data, m.instanceId));
    }
  });
  window.modsmith = Object.freeze({
    get context() {
      return context;
    },
    call: (method, params) => send('call', { method, params: params || {} }),
    readFile: (file) => send('call', { method: 'workspace.read_file', params: { file } }),
    writeFile: (file, content, options) => send('call', { method: 'workspace.write_file', params: Object.assign({ file, content }, options || {}) }),
    asset: (file) => send('asset', { file }),
    openFile: (file) => send('openFile', { file }),
    showGame: () => send('showGame', {}),
    toast: (kind, text) => send('toast', { kind, text }),
    state: Object.freeze({ get: () => send('stateGet', {}), set: (value) => send('stateSet', { value }) }),
    onThemeChange: (fn) => {
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    onFilesChanged: (fn) => {
      fileListeners.add(fn);
      return () => fileListeners.delete(fn);
    },
    onBridgeEvent: (fn) => {
      bridgeListeners.add(fn);
      return () => bridgeListeners.delete(fn);
    },
    registerViewer: (id, fn) => {
      viewers.set(id, fn);
    },
    registerPanel: (id, fn) => {
      panels.set(id, fn);
    }
  });
  parent.postMessage({ __modsmith: true, type: 'ready', id: 0 }, '*');
})();
