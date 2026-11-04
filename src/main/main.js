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
  // When the window is closed the app stays alive in the tray, but the
  // BrowserWindow object is destroyed. Drop the reference so later sends don't
  // throw "Object has been destroyed" (which was surfacing to the browser
  // bridge as HTTP 500 on every capture).
  win.on('closed', () => {
    win = null;
  });
}

// True only when we have a live, usable window.
function winAlive() {
  return !!win && !win.isDestroyed();
}

// Send to the renderer only if it's alive; never let a dead window throw.
function safeSend(channel, payload) {
  if (winAlive()) {
    try {
      win.webContents.send(channel, payload);
    } catch (_) {
      /* window went away mid-send */
    }
  }
}

// Bring the app to the foreground, recreating the window if it was closed.
function showWindow() {
  if (!winAlive()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
}

function wireManagerToRenderer() {
  manager.on('item', (rec) => safeSend('dm:item', rec));
  manager.on('removed', (id) => safeSend('dm:removed', id));
  manager.on('captured', (rec) => {
    safeSend('dm:captured', rec);
    showWindow();
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
    const r = await dialog.showOpenDialog(winAlive() ? win : undefined, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
}

function setupTray() {
  try {
    tray = new Tray(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    tray.setToolTip('WalDM');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open WalDM', click: () => showWindow() },
        {
          label: 'Add from clipboard',
          click: () => {
            const text = clipboard.readText().trim();
            if (/^https?:\/\//i.test(text)) {
              manager.add({ url: text });
              showWindow();
            }
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    tray.on('click', () => showWindow());
  } catch {
    /* tray may be unavailable on some headless Linux setups */
  }
}

// Only one WalDM may run: a second instance would fight over port 7611 (the
// browser bridge) and the userData files. Hand focus to the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

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
}

app.on('window-all-closed', () => {
  // Keep running in tray on Windows/Linux; standard quit on macOS behavior.
  if (process.platform !== 'darwin') {
    // stay alive in tray; comment out next line to quit on close
  }
});

app.on('before-quit', () => bridge && bridge.stop());
