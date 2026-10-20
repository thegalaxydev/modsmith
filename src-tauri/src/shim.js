(() => {
  if (window.workbench) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  const report = (kind, message, stack) => invoke('shell_report_error', { kind, message: String(message || ''), stack: String(stack || '') }).catch(() => {});
  window.addEventListener('error', (e) => report('error', e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => report('rejection', e.reason && e.reason.message ? e.reason.message : e.reason, e.reason && e.reason.stack));
  window.workbench = Object.freeze({
    endpoint: () => invoke('app_endpoint'),
    info: () => invoke('app_info'),
    chooseDirectory: (title) => invoke('dialog_directory', { title }),
    chooseFile: (title, filters) => invoke('dialog_file', { title, filters: filters || [] }),
    chooseSave: (title, defaultPath, filters) => invoke('dialog_save', { title, defaultPath: defaultPath || '', filters: filters || [] }),
    openPath: (path) => invoke('shell_open_path', { path }),
    showItem: (path) => invoke('shell_show_item', { path }),
    openExternal: (url) => invoke('shell_open_external', { url }),
    setNativeWayland: (enabled) => invoke('shell_set_native_wayland', { enabled }),
    viewport: Object.freeze({
      attach: (instanceId, rect) => invoke('viewport_attach', { instanceId, rect }),
      update: (rect) => invoke('viewport_update', { rect }),
      setVisible: (visible) => invoke('viewport_visible', { visible }),
      focus: () => invoke('viewport_focus'),
      detach: () => invoke('viewport_detach'),
      status: () => invoke('viewport_status'),
      bringToFront: (instanceId) => invoke('viewport_bring_to_front', { instanceId }),
      onState: (cb) => {
        let unlisten = null;
        let disposed = false;
        window.__TAURI__.event.listen('viewport:state', (e) => cb(e.payload)).then((u) => {
          if (disposed) u();
          else unlisten = u;
        });
        return () => {
          disposed = true;
          if (unlisten) unlisten();
        };
      }
    })
  });
})();
