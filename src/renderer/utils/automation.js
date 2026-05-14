/**
 * automation.js — FastAPI backend client
 *
 * Typed, named functions for every automation endpoint exposed by the
 * local Python FastAPI server. All calls are proxied through the Electron
 * main process via window.cortexa.automate() so the session token never
 * touches renderer memory.
 *
 * Pure JS — no React state. Import individual functions wherever needed.
 */

import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

const EP = {
  APP:     '/automate/app',
  SYSTEM:  '/automate/system',
  BROWSER: '/automate/browser',
  FILES:   '/automate/files',
  SCREEN:  '/screenshot',
};

const TIMEOUT_MS = CONFIG.backend.requestTimeoutMs ?? 10_000;

// ─── Error type ───────────────────────────────────────────────────────────────

export class AutomationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name         = 'AutomationError';
    this.endpoint     = meta.endpoint     ?? null;
    this.payload      = meta.payload      ?? null;
    this.backendError = meta.backendError ?? null;
  }
}

// ─── Core dispatcher ──────────────────────────────────────────────────────────

async function dispatch(endpoint, payload) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new AutomationError(`Timed out after ${TIMEOUT_MS / 1000}s`, { endpoint, payload })),
      TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      window.cortexa.automate(endpoint, payload),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
    if (!result.ok) throw new AutomationError(result.error ?? 'Backend error', { endpoint, payload, backendError: result.error });
    return result.data ?? {};
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof AutomationError) throw err;
    throw new AutomationError(err.message, { endpoint, payload });
  }
}

async function safeDispatch(endpoint, payload) {
  try   { const data = await dispatch(endpoint, payload); return { ok: true, data }; }
  catch (err) { console.warn(`[automation] ${endpoint}:`, err.message); return { ok: false, error: err.message }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

export const openApp        = (appName, args = '') => safeDispatch(EP.APP, { action: 'open',  target: appName, args });
export const closeApp       = (appName)            => safeDispatch(EP.APP, { action: 'close', target: appName });
export const focusApp       = (appName)            => safeDispatch(EP.APP, { action: 'focus', target: appName });
export const listRunningApps = ()                  => safeDispatch(EP.APP, { action: 'list'  });

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

export const setDarkMode      = (on)    => safeDispatch(EP.SYSTEM, { setting: 'dark_mode',    value: Boolean(on) });
export const setVolume        = (lvl)   => safeDispatch(EP.SYSTEM, { setting: 'volume',       value: Math.min(100, Math.max(0, Math.round(lvl))) });
export const muteVolume       = ()      => setVolume(0);
export const setBrightness    = (lvl)   => safeDispatch(EP.SYSTEM, { setting: 'brightness',   value: Math.min(100, Math.max(0, Math.round(lvl))) });
export const setWifi          = (on)    => safeDispatch(EP.SYSTEM, { setting: 'wifi',         value: Boolean(on) });
export const setBluetooth     = (on)    => safeDispatch(EP.SYSTEM, { setting: 'bluetooth',    value: Boolean(on) });
export const lockScreen       = ()      => safeDispatch(EP.SYSTEM, { setting: 'lock_screen'   });
export const sleepDisplay     = ()      => safeDispatch(EP.SYSTEM, { setting: 'sleep_display' });
export const getSystemInfo    = ()      => safeDispatch(EP.SYSTEM, { setting: 'info'          });
export const sendNotification = (title, message, subtitle = '') =>
  safeDispatch(EP.SYSTEM, { setting: 'notification', value: { title, message, subtitle } });

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER AUTOMATION
// ═══════════════════════════════════════════════════════════════════════════════

export const navigateTo    = (url)            => safeDispatch(EP.BROWSER, { action: 'navigate',    url: url.startsWith('http') ? url : `https://${url}` });
export const searchGoogle  = (query)          => safeDispatch(EP.BROWSER, { action: 'search',      engine: 'google',  query });
export const searchAmazon  = (query)          => safeDispatch(EP.BROWSER, { action: 'search',      engine: 'amazon',  query });
export const searchYouTube = (query)          => safeDispatch(EP.BROWSER, { action: 'search',      engine: 'youtube', query });
export const clickElement  = (selector)       => safeDispatch(EP.BROWSER, { action: 'click',       selector });
export const fillField     = (selector, val)  => safeDispatch(EP.BROWSER, { action: 'fill',        selector, value: val });
export const getPageContent = ()              => safeDispatch(EP.BROWSER, { action: 'get_content'  });
export const openNewTab    = (url = '')       => safeDispatch(EP.BROWSER, { action: 'new_tab',     url });
export const closeTab      = ()               => safeDispatch(EP.BROWSER, { action: 'close_tab'   });
export const goBack        = ()               => safeDispatch(EP.BROWSER, { action: 'back'         });

// ═══════════════════════════════════════════════════════════════════════════════
// FILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export const createFolder   = (path)                => safeDispatch(EP.FILES, { action: 'create_folder', path });
export const renameFile     = (path, newName)       => safeDispatch(EP.FILES, { action: 'rename',        path, new_name: newName });
export const moveFile       = (path, dest)          => safeDispatch(EP.FILES, { action: 'move',          path, destination: dest });
export const copyFile       = (path, dest)          => safeDispatch(EP.FILES, { action: 'copy',          path, destination: dest });
export const deleteFile     = (path, trash = true)  => safeDispatch(EP.FILES, { action: 'delete',        path, trash });
export const listDirectory  = (path = '~')          => safeDispatch(EP.FILES, { action: 'list',          path });
export const openFile       = (path)                => safeDispatch(EP.FILES, { action: 'open',          path });
export const revealInFinder = (path)                => safeDispatch(EP.FILES, { action: 'reveal',        path });
export const writeFile      = (path, content)       => safeDispatch(EP.FILES, { action: 'write',         path, content });

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT
// ═══════════════════════════════════════════════════════════════════════════════

export async function takeScreenshot(options = {}) {
  try {
    const result = await window.cortexa.screenshot();
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, data: result.data };
  } catch (_) {
    return safeDispatch(EP.SCREEN, { target: options.target ?? 'screen', save: options.save ?? false });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

export async function isBackendHealthy() {
  try { const s = await window.cortexa.backendStatus(); return Boolean(s?.running); }
  catch (_) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND PARSER — agent JSON block → typed function call
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a structured command object emitted by the agent.
 * useAgent calls this after parsing the ```command``` block from a reply.
 *
 * @param {{ type, action, target, value }} cmd
 * @returns {Promise<{ ok, data?, error? }>}
 */
export async function executeCommand(cmd = {}) {
  const { type, action, target, value } = cmd;
  try {
    switch (type) {
      case 'app':
        if (action === 'open'  || action === 'launch') return openApp(target);
        if (action === 'close' || action === 'quit')   return closeApp(target);
        if (action === 'focus' || action === 'switch') return focusApp(target);
        break;
      case 'system':
        if (action === 'dark_mode')     return setDarkMode(value !== false && value !== 'false');
        if (action === 'volume')        return setVolume(Number(value ?? target ?? 50));
        if (action === 'mute')          return muteVolume();
        if (action === 'brightness')    return setBrightness(Number(value ?? target ?? 50));
        if (action === 'wifi')          return setWifi(String(value).toLowerCase() !== 'off');
        if (action === 'bluetooth')     return setBluetooth(String(value).toLowerCase() !== 'off');
        if (action === 'lock_screen')   return lockScreen();
        if (action === 'sleep_display') return sleepDisplay();
        if (action === 'screenshot')    return takeScreenshot();
        if (action === 'notification')  return sendNotification(target, String(value ?? ''));
        break;
      case 'browser':
        if (action === 'navigate')     return navigateTo(target ?? value);
        if (action === 'search') {
          const eng = String(value ?? '').toLowerCase();
          if (eng === 'amazon')        return searchAmazon(target);
          if (eng === 'youtube')       return searchYouTube(target);
          return searchGoogle(target);
        }
        if (action === 'click')        return clickElement(target);
        if (action === 'fill')         return fillField(target, String(value ?? ''));
        if (action === 'new_tab')      return openNewTab(target);
        if (action === 'close_tab')    return closeTab();
        if (action === 'back')         return goBack();
        if (action === 'get_content')  return getPageContent();
        break;
      case 'files':
        if (action === 'create_folder') return createFolder(target);
        if (action === 'rename')        return renameFile(target, String(value ?? ''));
        if (action === 'move')          return moveFile(target, String(value ?? ''));
        if (action === 'copy')          return copyFile(target, String(value ?? ''));
        if (action === 'delete')        return deleteFile(target);
        if (action === 'open')          return openFile(target);
        if (action === 'reveal')        return revealInFinder(target);
        if (action === 'write')         return writeFile(target, String(value ?? ''));
        if (action === 'list')          return listDirectory(target);
        break;
      default:
        return { ok: false, error: `Unknown command type: "${type}"` };
    }
    return { ok: false, error: `Unknown action "${action}" for type "${type}"` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Format a one-line status label for the chat system message.
 * @param {{ action, target }} cmd
 * @param {{ ok, error? }}     result
 * @returns {string}
 */
export function describeResult(cmd, result) {
  if (!result.ok) return `⚠ Failed — ${result.error ?? 'unknown error'}`;
  return `⚙ Executed: ${[cmd.action, cmd.target].filter(Boolean).join(' ')}`;
}