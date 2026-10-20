(() => {
  if (window.workbench) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  window.workbench = Object.freeze({
    endpoint: () => invoke('app_endpoint'),
    info: () => invoke('app_info'),
    chooseDirectory: (title) => invoke('dialog_directory', { title }),
    chooseFile: (title, filters) => invoke('dialog_file', { title, filters: filters || [] }),
    chooseSave: (title, defaultPath, filters) => invoke('dialog_save', { title, defaultPath: defaultPath || '', filters: filters || [] }),
    confirm: (text) => invoke('dialog_confirm', { text }),
    alert: (text) => invoke('dialog_alert', { text }),
    openPath: (path) => invoke('shell_open_path', { path }),
    showItem: (path) => invoke('shell_show_item', { path }),
    openExternal: (url) => invoke('shell_open_external', { url }),
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
