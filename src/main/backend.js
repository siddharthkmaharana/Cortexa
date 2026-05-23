'use strict';

/**
 * backend.js — FastAPI process manager
 *
 * Responsible for:
 *   1. Locating the correct backend binary/script (PyInstaller vs. raw uvicorn)
 *   2. Generating a random per-session auth token
 *   3. Spawning the FastAPI process on a free port
 *   4. Waiting for the server to become healthy before resolving
 *   5. Restarting on unexpected crashes (with a backoff limit)
 *   6. Cleanly terminating on app quit
 *   7. Forwarding status events to the renderer via BrowserWindow
 */

const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');

// ─── Configuration ────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';
const BASE_PORT = parseInt(process.env.BACKEND_PORT || '8000', 10);
const MAX_RESTARTS = 3;
const HEALTH_TIMEOUT_MS = 15_000;   // wait up to 15 s for server to come up
const HEALTH_POLL_MS = 300;         // poll /health every 300 ms

// ─── Module State ─────────────────────────────────────────────────────────────

let _process = null;         // ChildProcess
let _port = BASE_PORT;       // actual port in use
let _token = '';             // session auth token
let _running = false;
let _restarts = 0;
let _stopping = false;       // true when app is quitting — don't restart

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random hex token for this session.
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Find an available TCP port starting from `preferred`.
 */
function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // preferred is taken — let the OS pick any free port
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const { port } = fallback.address();
        fallback.close(() => resolve(port));
      });
      fallback.on('error', reject);
    });
  });
}

/**
 * Poll GET /health until it responds 200 or we time out.
 */
async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch (_) {
      // server not up yet — keep polling
    }
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

/**
 * Resolve the path to the backend entrypoint.
 *
 * Priority order:
 *   1. Bundled PyInstaller binary  (production, inside app resources)
 *   2. Raw Python + uvicorn        (development, inside repo)
 */
function resolveBackendPath() {
  // 1. Production binary
  const binaryName = process.platform === 'win32' ? 'cortexa-backend.exe' : 'cortexa-backend';
  const binaryPath = path.join(process.resourcesPath || '', 'bin', binaryName);
  if (fs.existsSync(binaryPath)) {
    return { type: 'binary', path: binaryPath };
  }

  // 2. Development — point at the Python source
  const devScript = path.join(__dirname, '../../backend/main.py');
  if (fs.existsSync(devScript)) {
    return { type: 'python', path: devScript };
  }

  throw new Error('CORTEXA backend not found. Run `pip install -r backend/requirements.txt` and ensure backend/main.py exists.');
}

/**
 * Build the spawn arguments for the resolved backend.
 */
function buildSpawnArgs(resolved, port, token) {
  if (resolved.type === 'binary') {
    return {
      cmd: resolved.path,
      args: [],
      env: { ...process.env, CORTEXA_PORT: String(port), CORTEXA_TOKEN: token },
    };
  }

  // Development: find the virtualenv python
  const venvPaths = [
    path.join(__dirname, '../../backend/venv/bin/python'),     // macOS/Linux venv
    path.join(__dirname, '../../backend/venv/Scripts/python.exe'), // Windows venv
    path.join(__dirname, '../../backend/venv/Scripts/python'), // Windows venv fallback
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ];
  const pythonBin = venvPaths.find(p => {
    if (!p.startsWith('/') && !p.includes('\\')) return true; // system python
    return fs.existsSync(p);
  }) || 'python';

  return {
    cmd: pythonBin,
    args: [
      '-m', 'uvicorn',
      'main:app',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--log-level', IS_DEV ? 'info' : 'warning',
    ],
    env: {
      ...process.env,
      CORTEXA_TOKEN: token,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: path.dirname(resolved.path),
    },
  };
}

/**
 * Emit an event to all renderer windows.
 */
function emitToRenderer(channel, payload) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the FastAPI backend process.
 * Resolves once the /health endpoint responds OK.
 * Rejects if the server doesn't come up within HEALTH_TIMEOUT_MS.
 */
async function start() {
  if (_running) return;
  _stopping = false;
  _token = generateToken();

  try {
    _port = await findFreePort(BASE_PORT);
  } catch (err) {
    throw new Error(`Could not find a free port: ${err.message}`);
  }

  let resolved;
  try {
    resolved = resolveBackendPath();
  } catch (err) {
    emitToRenderer('backend:error', { message: err.message });
    throw err;
  }

  const { cmd, args, env } = buildSpawnArgs(resolved, _port, _token);

  console.log(`[backend] Starting (${resolved.type}) on port ${_port}`);
  console.log(`[backend] cmd: ${cmd} ${args.join(' ')}`);

  _process = spawn(cmd, args, {
    env,
    cwd: resolved.type === 'python' ? path.dirname(resolved.path) : undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,  // no console window on Windows
  });

  // Forward stdout/stderr to Electron's console
  _process.stdout?.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[backend] ${line}`);
  });
  _process.stderr?.on('data', d => {
    const line = d.toString().trim();
    if (line) console.error(`[backend:err] ${line}`);
  });

  _process.on('error', err => {
    console.error('[backend] Spawn error:', err.message);
    emitToRenderer('backend:error', { message: err.message });
    _running = false;
  });

  _process.on('exit', (code, signal) => {
    _running = false;
    console.warn(`[backend] Exited — code=${code} signal=${signal}`);

    if (_stopping) return; // intentional quit

    emitToRenderer('backend:stopped', { code, signal });

    // Auto-restart on unexpected exit, up to MAX_RESTARTS times
    if (_restarts < MAX_RESTARTS) {
      _restarts++;
      const delay = _restarts * 2000;
      console.log(`[backend] Restarting in ${delay}ms (attempt ${_restarts}/${MAX_RESTARTS})`);
      setTimeout(start, delay);
    } else {
      console.error('[backend] Max restarts reached. Giving up.');
      emitToRenderer('backend:error', { message: 'Backend crashed repeatedly and could not be restarted.' });
    }
  });

  // Wait for the health endpoint
  const healthy = await waitForHealth(_port, HEALTH_TIMEOUT_MS);
  if (!healthy) {
    stop();
    throw new Error(`Backend did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
  }

  _running = true;
  _restarts = 0;
  console.log(`[backend] Healthy on http://127.0.0.1:${_port}`);
  emitToRenderer('backend:ready', { port: _port });
}

/**
 * Stop the backend process cleanly.
 * Called by index.js on app 'before-quit'.
 */
function stop() {
  _stopping = true;
  if (!_process) return;

  console.log('[backend] Stopping process...');
  try {
    // Prefer SIGTERM for a graceful uvicorn shutdown
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(_process.pid), '/f', '/t']);
    } else {
      _process.kill('SIGTERM');
      // Escalate to SIGKILL after 3 s if still alive
      setTimeout(() => {
        if (_process && !_process.killed) {
          _process.kill('SIGKILL');
        }
      }, 3000);
    }
  } catch (err) {
    console.warn('[backend] Error stopping process:', err.message);
  }

  _process = null;
  _running = false;
}

/**
 * Returns the current session auth token.
 * Only ever read from index.js — never exposed to the renderer.
 */
function getSessionToken() {
  return _token;
}

/**
 * Returns the port the backend is (or will be) listening on.
 */
function getPort() {
  return _port;
}

/**
 * Returns a status snapshot for the renderer.
 */
function getStatus() {
  return {
    running: _running,
    pid: _process?.pid ?? null,
    port: _port,
    restarts: _restarts,
  };
}

module.exports = { start, stop, getSessionToken, getPort, getStatus };