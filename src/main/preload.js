
'use strict';

/**
 * preload.js — CORTEXA contextBridge
 *
 * This script runs in a privileged context with access to Node.js APIs,
 * but its only job is to expose a narrow, typed API surface to the renderer
 * via contextBridge. The renderer (React) never touches Node or Electron directly.
 *
 * Every method here maps to an ipcMain.handle() in index.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ─── Type-safe IPC wrapper ────────────────────────────────────────────────────

/**
 * Validates that a value is a non-empty string.
 */
function assertString(val, name) {
  if (typeof val !== 'string' || val.trim() === '') {
    throw new TypeError(`cortexa.${name}: expected a non-empty string`);
  }
}

/**
 * Validates that a value is a plain object.
 */
function assertObject(val, name) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new TypeError(`cortexa.${name}: expected a plain object`);
  }
}

// ─── Exposed API ──────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('cortexa', {

  // ── Key Management ──────────────────────────────────────────────────────────

  /**
   * Encrypt and persist API keys to the OS keychain.
   * @param {{ anthropicKey: string, elevenLabsKey?: string, picovoiceKey?: string }} keys
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  saveKeys(keys) {
    assertObject(keys, 'saveKeys');
    return ipcRenderer.invoke('keys:save', keys);
  },

  /**
   * Retrieve previously stored API keys from the OS keychain.
   * @returns {Promise<{ ok: boolean, keys: object|null, error?: string }>}
   */
  loadKeys() {
    return ipcRenderer.invoke('keys:load');
  },

  /**
   * Permanently delete stored keys.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  clearKeys() {
    return ipcRenderer.invoke('keys:clear');
  },

  // ── Automation ──────────────────────────────────────────────────────────────

  /**
   * Send a structured automation command to the FastAPI backend.
   * The main process proxies the request so the session token never
   * leaves the privileged context.
   *
   * @param {string} endpoint  e.g. '/automate/app', '/automate/system'
   * @param {object} payload   Command body — varies by endpoint
   * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
   *
   * @example
   * await window.cortexa.automate('/automate/app', { action: 'open', target: 'Spotify' })
   * await window.cortexa.automate('/automate/system', { setting: 'dark_mode', value: true })
   * await window.cortexa.automate('/automate/browser', { action: 'search', query: 'airpods' })
   * await window.cortexa.automate('/automate/files', { action: 'create_folder', path: '~/Desktop/Projects' })
   */
  automate(endpoint, payload) {
    assertString(endpoint, 'automate');
    assertObject(payload, 'automate');
    return ipcRenderer.invoke('automate', { endpoint, payload });
  },

  /**
   * Capture a screenshot of the current screen via the backend.
   * Returns a base64-encoded PNG.
   * @returns {Promise<{ ok: boolean, data?: { image: string }, error?: string }>}
   */
  screenshot() {
    return ipcRenderer.invoke('screenshot');
  },

  /**
   * Get the current status of the FastAPI backend process.
   * @returns {{ running: boolean, pid: number|null, port: number }}
   */
  backendStatus() {
    return ipcRenderer.invoke('backend:status');
  },

  // ── Native Dialogs ──────────────────────────────────────────────────────────

  /**
   * Open a native file or folder picker.
   * @param {Electron.OpenDialogOptions} options
   * @returns {Promise<Electron.OpenDialogReturnValue>}
   *
   * @example
   * const result = await window.cortexa.openDialog({
   *   title: 'Select a project folder',
   *   properties: ['openDirectory']
   * })
   */
  openDialog(options = {}) {
    return ipcRenderer.invoke('dialog:open', options);
  },

  /**
   * Open a native save dialog.
   * @param {Electron.SaveDialogOptions} options
   * @returns {Promise<Electron.SaveDialogReturnValue>}
   */
  saveDialog(options = {}) {
    return ipcRenderer.invoke('dialog:save', options);
  },

  /**
   * Open a file or folder in the system file manager (Finder / Explorer).
   * @param {string} targetPath  Absolute path to open
   * @returns {Promise<{ ok: boolean }>}
   */
  openInExplorer(targetPath) {
    assertString(targetPath, 'openInExplorer');
    return ipcRenderer.invoke('shell:open', targetPath);
  },

  // ── Event Listeners ─────────────────────────────────────────────────────────

  /**
   * Register a listener for events pushed from the main process.
   * Returns a cleanup function — call it to unsubscribe.
   *
   * @param {'backend:ready'|'backend:error'|'backend:stopped'} channel
   * @param {Function} handler
   * @returns {() => void}  Unsubscribe function
   *
   * @example
   * const unsub = window.cortexa.on('backend:ready', () => setBackendOnline(true))
   * // later:
   * unsub()
   */
  on(channel, handler) {
    const ALLOWED = new Set(['backend:ready', 'backend:error', 'backend:stopped']);
    if (!ALLOWED.has(channel)) {
      throw new Error(`cortexa.on: unknown channel "${channel}"`);
    }
    const wrapped = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /**
   * Register a one-time listener — fires once then auto-removes.
   * @param {string} channel
   * @param {Function} handler
   */
  once(channel, handler) {
    const ALLOWED = new Set(['backend:ready', 'backend:error', 'backend:stopped']);
    if (!ALLOWED.has(channel)) {
      throw new Error(`cortexa.once: unknown channel "${channel}"`);
    }
    ipcRenderer.once(channel, (_event, ...args) => handler(...args));
  },

  // ── Environment Info ────────────────────────────────────────────────────────

  /**
   * Read-only environment flags exposed to the renderer.
   */
  env: {
    isDev: process.env.NODE_ENV === 'development',
    platform: process.platform,           // 'darwin' | 'win32' | 'linux'
    version: process.env.npm_package_version || '0.0.1',
  },
});