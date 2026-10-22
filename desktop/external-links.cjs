// Only the workbench's main page may hand web links to the default browser.
function webLink(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function trustedPage(event, contents, base) {
  try {
    const frame = event.senderFrame;
    const url = new URL(frame.url);
    return event.sender === contents && frame === contents.mainFrame && url.origin === base && url.pathname === '/';
  } catch { return false; }
}

function installExternalLinks({win, ipcMain, shell, dialog, base}) {
  ipcMain.handle('workbench:open-web-link', async (event, value) => {
    const url = webLink(value);
    if (!url || win.isDestroyed() || !trustedPage(event, win.webContents, base)) return false;
    try { await shell.openExternal(url); return true; }
    catch { dialog.showMessageBox(win, {type:'error', title:'网页未能打开', message:'请检查默认浏览器设置后重试。'}); return false; }
  });
  // Unhandled popups (including artifact frames) stay blocked.
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
}

module.exports = {webLink, trustedPage, installExternalLinks};
