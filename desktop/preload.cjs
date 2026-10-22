const {ipcRenderer} = require('electron');

// Keep the renderer sandboxed. No Node API or generic IPC bridge is exposed.
if (process.isMainFrame) {
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
