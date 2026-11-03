'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, clipboard } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { DownloadManager } = require('./downloadManager');
const { NativeServer } = require('./nativeServer');

let win = null;
let tray = null;
let manager = null;
let store = null;
let bridge = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 680,
    minWidth: 760,
    minHeight: 460,
    backgroundColor: '#0f1420',
    title: 'WalDM',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function wireManagerToRenderer() {
  manager.on('item', (rec) => win && win.webContents.send('dm:item', rec));
  manager.on('removed', (id) => win && win.webContents.send('dm:removed', id));
  manager.on('captured', (rec) => {
    if (win) {
      win.webContents.send('dm:captured', rec);
      if (win.isMinimized()) win.restore();
      win.show();
    }
  });
}

function setupIpc() {
  ipcMain.handle('dm:list', () => manager.list());
  ipcMain.handle('dm:add', (_e, opts) => manager.add(opts));
  ipcMain.handle('dm:pause', (_e, id) => manager.pause(id));
  ipcMain.handle('dm:resume', (_e, id) => manager.resume(id));
  ipcMain.handle('dm:retry', (_e, id) => manager.retry(id));
  ipcMain.handle('dm:remove', (_e, { id, deleteFile }) => manager.remove(id, deleteFile));
  ipcMain.handle('dm:getSettings', () => manager.getSettings());
  ipcMain.handle('dm:updateSettings', (_e, patch) => manager.updateSettings(patch));
  ipcMain.handle('dm:probeVideo', (_e, url) => manager.probeVideoFormats(url));
  ipcMain.handle('dm:bridgeInfo', () => ({ port: bridge.port, token: bridge.token }));

  ipcMain.handle('dm:openFile', (_e, id) => {
    const rec = manager.records.get(id);
    if (rec && rec.filePath) shell.openPath(rec.filePath);
  });
  ipcMain.handle('dm:openFolder', (_e, id) => {
    const rec = manager.records.get(id);
    if (rec && rec.filePath) shell.showItemInFolder(rec.filePath);
  });
  ipcMain.handle('dm:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
}

function setupTray() {
  try {
    tray = new Tray(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    tray.setToolTip('WalDM');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open WalDM', click: () => (win ? win.show() : createWindow()) },
        {
          label: 'Add from clipboard',
          click: () => {
            const text = clipboard.readText().trim();
            if (/^https?:\/\//i.test(text)) {
              manager.add({ url: text });
              if (win) win.show();
            }
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    tray.on('click', () => (win ? win.show() : createWindow()));
  } catch {
    /* tray may be unavailable on some headless Linux setups */
  }
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  store.load();
  if (!store.getSetting('downloadDir', null)) {
    store.setSetting('downloadDir', app.getPath('downloads'));
  }
  manager = new DownloadManager(store);
  bridge = new NativeServer({ manager, store, port: 7611 });
  bridge.start();

  createWindow();
  wireManagerToRenderer();
  setupIpc();
  setupTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows/Linux; standard quit on macOS behavior.
  if (process.platform !== 'darwin') {
    // stay alive in tray; comment out next line to quit on close
  }
});

app.on('before-quit', () => bridge && bridge.stop());
