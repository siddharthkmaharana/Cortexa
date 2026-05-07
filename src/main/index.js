'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const backend = require('./backend');

// ─── Constants ────────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';
const KEYS_FILE = path.join(app.getPath('userData'), 'cortexa-keys.enc');
const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 860;

// ─── Window State ─────────────────────────────────────────────────────────────

function loadWindowState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: undefined, y: undefined };
}

function saveWindowState(win) {
  try {
    if (win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getBounds();
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(bounds), 'utf8');
  } catch (_) {}
}

// ─── Create Main Window ───────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: 'hiddenInset',   // macOS: traffic lights overlay the title bar
    vibrancy: 'under-window',       // macOS: frosted glass effect
    backgroundColor: '#080a0f',
    show: false,                    // show only after content loads (prevents white flash)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,       // renderer cannot access Node APIs directly
      nodeIntegration: false,       // keep Node out of the renderer
      sandbox: false,               // required for preload to use require()
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    icon: path.join(__dirname, '../../resources/icons/icon.png'),
    title: 'CORTEXA',
  });

  // ── Load the app ──
  if (IS_DEV) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../out/renderer/index.html'));
  }

  // ── Show once ready — prevents white flash ──
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (state.isMaximized) mainWindow.maximize();
  });

  // ── Persist window position & size ──
  ['resize', 'move', 'close'].forEach(evt =>
    mainWindow.on(evt, () => saveWindowState(mainWindow))
  );

  // ── Open external links in the system browser, not Electron ──
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // ── Security: block navigation away from the app ──
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = IS_DEV ? 'http://localhost:3000' : `file://${path.join(__dirname, '../../out')}`;
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Camera Permission ────────────────────────────────────────────────────────

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'camera'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'camera'];
    return allowed.includes(permission);
  });
}

// ─── Secure Key Storage (OS Keychain via safeStorage) ─────────────────────────

/**
 * Encrypts and persists API keys to disk.
 * safeStorage uses the OS keychain — keys are bound to this machine.
 */
function saveKeys(keys) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available on this system.');
  }
  const json = JSON.stringify(keys);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(KEYS_FILE, encrypted);
}

/**
 * Reads and decrypts stored API keys.
 * Returns null if no keys have been saved yet.
 */
function loadKeys() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (!fs.existsSync(KEYS_FILE)) return null;
  try {
    const encrypted = fs.readFileSync(KEYS_FILE);
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

/**
 * Renderer → Main: save API keys securely.
 * Usage (renderer via preload): window.cortexa.saveKeys({ anthropicKey: '...' })
 */
ipcMain.handle('keys:save', async (_event, keys) => {
  try {
    saveKeys(keys);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Renderer → Main: load saved API keys.
 * Usage: window.cortexa.loadKeys()
 */
ipcMain.handle('keys:load', async () => {
  try {
    const keys = loadKeys();
    return { ok: true, keys };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Renderer → Main: delete all stored keys.
 */
ipcMain.handle('keys:clear', async () => {
  try {
    if (fs.existsSync(KEYS_FILE)) fs.unlinkSync(KEYS_FILE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Renderer → Main: send an automation command to the FastAPI backend.
 * The main process proxies this so the renderer never talks to localhost directly
 * (avoids CORS and exposes the session token only in main).
 */
ipcMain.handle('automate', async (_event, { endpoint, payload }) => {
  const token = backend.getSessionToken();
  const port = backend.getPort();

  try {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Renderer → Main: take a screenshot via the backend.
 */
ipcMain.handle('screenshot', async () => {
  const token = backend.getSessionToken();
  const port = backend.getPort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot`, {
      headers: { 'X-Session-Token': token },
    });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Renderer → Main: get current backend status.
 */
ipcMain.handle('backend:status', () => {
  return backend.getStatus();
});

/**
 * Renderer → Main: open a native file/folder picker.
 */
ipcMain.handle('dialog:open', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

/**
 * Renderer → Main: show a native save dialog.
 */
ipcMain.handle('dialog:save', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

/**
 * Renderer → Main: open a path in the system file manager.
 */
ipcMain.handle('shell:open', async (_event, targetPath) => {
  await shell.openPath(targetPath);
  return { ok: true };
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupPermissions();

  // Start the Python FastAPI backend before the window opens
  try {
    await backend.start();
  } catch (err) {
    console.error('[main] Backend failed to start:', err.message);
    // App still opens — automation features degrade gracefully
  }

  createWindow();

  // macOS: re-create window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up backend process on quit
app.on('before-quit', () => {
  backend.stop();
});

// ─── Security: disable creation of new windows from renderer ─────────────────

app.on('web-contents-created', (_event, contents) => {
  contents.on('new-window', (event) => {
    event.preventDefault();
  });
});