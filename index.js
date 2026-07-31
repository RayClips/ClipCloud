require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const settings = require('./settings');
const auth = require('./auth');
const storage = require('./storage');
const uploader = require('./uploader');

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0b0b12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));

  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());

  return win;
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.load());
  ipcMain.handle('settings:save', (_e, partial) => settings.save({ ...settings.load(), ...partial }));

  ipcMain.handle('settings:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose your clips folder',
      defaultPath: settings.load().clipsFolder,
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return null;
    const folder = settings.save({ ...settings.load(), clipsFolder: filePaths[0] }).clipsFolder;
    uploader.init(); 
    return folder;
  });

  ipcMain.handle('cloud:status', () => auth.status());
  ipcMain.handle('cloud:connect', async (_e, provider) => {
    const r = await auth.connect(provider);
    uploader.rescan(); 
    return r;
  });
  ipcMain.handle('cloud:disconnect', (_e, provider) => auth.disconnect(provider));
  ipcMain.handle('storage:get', () => storage.get());

  ipcMain.handle('clips:list', () => uploader.list());
  ipcMain.handle('clips:rescan', () => uploader.rescan());
  ipcMain.handle('clips:state', () => uploader.state());
}

app.whenReady().then(() => {
  registerIpc();
  const win = createWindow();

  uploader.setEmitter((channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  });
  win.webContents.once('did-finish-load', () => uploader.init());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
