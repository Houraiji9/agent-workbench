const {ipcRenderer, contextBridge} = require('electron');

// Keep the renderer sandboxed. No Node API or generic IPC bridge is exposed.
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('workbenchUpdates', Object.freeze({
    status: () => ipcRenderer.invoke('workbench:update', 'status'),
    check: () => ipcRenderer.invoke('workbench:update', 'check'),
    download: () => ipcRenderer.invoke('workbench:update', 'download'),
    install: () => ipcRenderer.invoke('workbench:update', 'install'),
    openDownload: () => ipcRenderer.invoke('workbench:update', 'open-download'),
  }));
  const openLink = event => {
    if (!event.isTrusted || event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
    const target = event.target;
    const link = target instanceof Element ? target.closest('a[target="_blank"][href]') : null;
    if (!link) return;
    event.preventDefault();
    void ipcRenderer.invoke('workbench:open-web-link', link.href).catch(() => {});
  };
  document.addEventListener('click', openLink);
  document.addEventListener('auxclick', openLink);
}
