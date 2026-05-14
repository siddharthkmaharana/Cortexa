/**
 * barcodeScanner.js — ZXing barcode and QR code scanner
 *
 * Wraps @zxing/library into a clean, self-contained scanner that can be
 * attached to any HTMLVideoElement or HTMLCanvasElement. Handles:
 *
 *   • Multi-format detection (QR, EAN-13, EAN-8, UPC-A, UPC-E,
 *     Code128, Code39, ITF, PDF417, DataMatrix, Aztec)
 *   • Lazy ZXing import — library only loads when scanning is first started
 *   • Scan debounce — same barcode won't fire twice within the cooldown window
 *   • Result classification — differentiates product codes, URLs, text, Wi-Fi
 *   • Scan history — keeps a rolling list of unique results this session
 *   • Off-screen canvas capture — reads from live <video> without touching the DOM
 *
 * Pure JS — no React state. Callers create a scanner instance and subscribe
 * to results via callbacks.
 */

import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long (ms) to ignore duplicate scans of the same value */
const DUPLICATE_COOLDOWN_MS = 4_000;

/** Max results kept in session history */
const HISTORY_LIMIT = 50;

/** ZXing hint key for disabling slow formats we don't need */
const SLOW_FORMATS_TO_SKIP = ['MAXICODE', 'RSS_14', 'RSS_EXPANDED'];

// ─── Barcode format metadata ──────────────────────────────────────────────────

/**
 * Human-readable label and category for every ZXing BarcodeFormat value.
 * Category drives what action CORTEXA takes after a scan.
 */
const FORMAT_META = {
  QR_CODE:      { label: 'QR Code',     category: 'qr'      },
  DATA_MATRIX:  { label: 'Data Matrix', category: 'qr'      },
  AZTEC:        { label: 'Aztec',       category: 'qr'      },
  PDF_417:      { label: 'PDF417',      category: 'qr'      },
  EAN_13:       { label: 'EAN-13',      category: 'product' },
  EAN_8:        { label: 'EAN-8',       category: 'product' },
  UPC_A:        { label: 'UPC-A',       category: 'product' },
  UPC_E:        { label: 'UPC-E',       category: 'product' },
  CODE_128:     { label: 'Code 128',    category: 'code'    },
  CODE_39:      { label: 'Code 39',     category: 'code'    },
  CODE_93:      { label: 'Code 93',     category: 'code'    },
  ITF:          { label: 'ITF',         category: 'code'    },
  CODABAR:      { label: 'Codabar',     category: 'code'    },
};

// ─── Result classifier ────────────────────────────────────────────────────────

/**
 * Analyse a raw scan value and return a richer classification.
 *
 * @param {string} value        raw decoded string
 * @param {string} formatName   ZXing BarcodeFormat name
 * @returns {{
 *   value:      string,
 *   format:     string,       ZXing format name
 *   formatLabel:string,       human-readable format
 *   category:   'url'|'wifi'|'email'|'phone'|'product'|'qr'|'code'|'text',
 *   url:        string|null,  if the value is or contains a URL
 *   searchUrl:  string,       Amazon/Google search link for product codes
 *   isProduct:  boolean,
 *   isUrl:      boolean,
 *   ts:         number,       Date.now()
 * }}
 */
export function classifyResult(value, formatName) {
  const meta     = FORMAT_META[formatName] ?? { label: formatName, category: 'text' };
  const trimmed  = value.trim();

  const isUrl    = /^https?:\/\//i.test(trimmed);
  const isWifi   = /^WIFI:/i.test(trimmed);
  const isEmail  = /^mailto:/i.test(trimmed) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const isPhone  = /^tel:/i.test(trimmed)    || /^\+?\d[\d\s\-().]{6,}$/.test(trimmed);
  const isProduct = meta.category === 'product';

  let category = meta.category;
  if (isUrl)   category = 'url';
  if (isWifi)  category = 'wifi';
  if (isEmail) category = 'email';
  if (isPhone) category = 'phone';

  // Build a search URL for product barcodes
  const searchUrl = isProduct
    ? `https://www.amazon.com/s?k=${encodeURIComponent(trimmed)}`
    : isUrl ? trimmed
    : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;

  return {
    value:       trimmed,
    format:      formatName,
    formatLabel: meta.label,
    category,
    url:         isUrl ? trimmed : null,
    searchUrl,
    isProduct,
    isUrl,
    ts:          Date.now(),
  };
}

// ─── Wi-Fi QR parser ──────────────────────────────────────────────────────────

/**
 * Parse a Wi-Fi QR code string (WIFI:T:WPA;S:MyNetwork;P:password;;)
 * into a structured object.
 *
 * @param {string} wifiString
 * @returns {{ ssid, password, encryption } | null}
 */
export function parseWifiQr(wifiString) {
  try {
    const fields = {};
    wifiString.replace(/^WIFI:/i, '').split(';').forEach(part => {
      const [key, ...rest] = part.split(':');
      if (key && rest.length) fields[key.toUpperCase()] = rest.join(':');
    });
    return {
      ssid:       fields.S  ?? '',
      password:   fields.P  ?? '',
      encryption: fields.T  ?? 'WPA',
    };
  } catch (_) {
    return null;
  }
}

// ─── Off-screen frame capture ─────────────────────────────────────────────────

/**
 * Draws the current video frame to a temporary off-screen canvas
 * and returns the ImageData for ZXing to decode.
 * Returns null if the video isn't ready.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {number} [scale]  downscale factor (default 1.0 — full resolution for accuracy)
 */
function captureVideoFrame(videoEl, scale = 1.0) {
  if (!videoEl || videoEl.readyState < 2) return null;
  if (!videoEl.videoWidth || !videoEl.videoHeight) return null;

  const w = Math.round(videoEl.videoWidth  * scale);
  const h = Math.round(videoEl.videoHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

// ─── BarcodeScanner class ─────────────────────────────────────────────────────

/**
 * BarcodeScanner
 *
 * Attach to a <video> element to scan every CONFIG.barcode.intervalMs ms.
 *
 * Usage:
 *   const scanner = new BarcodeScanner(videoRef.current, {
 *     onResult: (result) => console.log(result),
 *     onError:  (err)    => console.warn(err),
 *   });
 *   await scanner.start();
 *   // later:
 *   scanner.stop();
 */
export class BarcodeScanner {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {object}  opts
   * @param {Function} opts.onResult   (classifiedResult) => void
   * @param {Function} [opts.onError]  (errorMessage: string) => void
   * @param {number}   [opts.intervalMs]  override CONFIG.barcode.intervalMs
   * @param {number}   [opts.frameScale]  capture scale 0–1 (default 1.0)
   */
  constructor(videoEl, opts = {}) {
    this._video       = videoEl;
    this._onResult    = opts.onResult    ?? (() => {});
    this._onError     = opts.onError     ?? (() => {});
    this._intervalMs  = opts.intervalMs  ?? CONFIG.barcode.intervalMs;
    this._frameScale  = opts.frameScale  ?? 1.0;

    this._reader      = null;      // ZXing BrowserMultiFormatReader instance
    this._timer       = null;      // setInterval handle
    this._running     = false;
    this._lastValue   = null;      // last successfully decoded string
    this._lastTs      = 0;         // timestamp of last successful decode
    this._history     = [];        // session scan history
    this._loaded      = false;     // ZXing library loaded flag
  }

  // ── Public: start scanning ────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    if (!CONFIG.barcode.enabled) return;

    try {
      await this._loadZXing();
    } catch (err) {
      this._onError(`ZXing failed to load: ${err.message}`);
      return;
    }

    this._running = true;
    this._timer   = setInterval(() => this._tick(), this._intervalMs);

    // Run first scan immediately without waiting for the first interval
    this._tick();
  }

  // ── Public: stop scanning ─────────────────────────────────────────────────

  stop() {
    this._running = false;
    clearInterval(this._timer);
    this._timer = null;
    try { this._reader?.reset(); } catch (_) {}
  }

  // ── Public: get session history ───────────────────────────────────────────

  getHistory() {
    return [...this._history];
  }

  // ── Public: clear history ────────────────────────────────────────────────

  clearHistory() {
    this._history  = [];
    this._lastValue = null;
    this._lastTs   = 0;
  }

  // ── Public: scan a single canvas / image element on demand ───────────────

  /**
   * One-shot decode of a canvas or image element — doesn't require the
   * interval loop to be running. Useful for the freeze-frame deep-dive.
   *
   * @param {HTMLCanvasElement | HTMLImageElement} source
   * @returns {Promise<import('./barcodeScanner').ClassifiedResult | null>}
   */
  async scanElement(source) {
    if (!this._loaded) {
      try { await this._loadZXing(); } catch (_) { return null; }
    }
    try {
      const result = await this._reader.decodeFromCanvas(source);
      return classifyResult(result.getText(), result.getBarcodeFormat().toString());
    } catch (_) {
      return null; // ZXing throws on no-find — that's normal
    }
  }

  // ── Private: lazy ZXing import ───────────────────────────────────────────

  async _loadZXing() {
    if (this._loaded) return;

    // Dynamic import — keeps ZXing out of the initial bundle (~200 KB)
    const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = await import('@zxing/library');

    // Configure hints to skip slow formats we never encounter
    const hints = new Map();
    const formats = Object.values(BarcodeFormat).filter(
      f => !SLOW_FORMATS_TO_SKIP.includes(String(f))
    );
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);   // more aggressive decoding

    this._reader = new BrowserMultiFormatReader(hints);
    this._loaded = true;
  }

  // ── Private: one scan tick ────────────────────────────────────────────────

  async _tick() {
    if (!this._running || !this._video) return;

    const captured = captureVideoFrame(this._video, this._frameScale);
    if (!captured) return;

    try {
      const result = await this._reader.decodeFromCanvas(captured.canvas);
      const raw    = result.getText();

      // ── Duplicate suppression ──
      const now = Date.now();
      if (raw === this._lastValue && now - this._lastTs < DUPLICATE_COOLDOWN_MS) return;

      this._lastValue = raw;
      this._lastTs    = now;

      // ── Classify and fire ──
      const formatName = result.getBarcodeFormat()?.toString() ?? 'UNKNOWN';
      const classified = classifyResult(raw, formatName);

      // Prepend to history, cap at limit
      this._history.unshift(classified);
      if (this._history.length > HISTORY_LIMIT) this._history.pop();

      this._onResult(classified);

    } catch (_) {
      // ZXing throws NotFoundException when nothing is found — completely normal.
      // Only log if it's a genuine error (has a real message).
    }
  }
}

// ─── Convenience: create and manage a scanner tied to a React ref ────────────

/**
 * Factory helper used by CameraPanel and useCamera — creates a scanner,
 * starts it, and returns a stop() cleanup function.
 *
 * @param {HTMLVideoElement}  videoEl
 * @param {Function}          onResult   (classifiedResult) => void
 * @param {Function}          [onError]
 * @returns {Promise<() => void>}  cleanup function
 *
 * @example
 * const stopScan = await createScanner(videoRef.current, handleScan);
 * // on unmount:
 * stopScan();
 */
export async function createScanner(videoEl, onResult, onError) {
  const scanner = new BarcodeScanner(videoEl, { onResult, onError });
  await scanner.start();
  return () => scanner.stop();
}

// ─── Lookup helpers (drive the agent after a scan) ────────────────────────────

/**
 * Build a natural language prompt to send to the agent after a barcode scan.
 * The agent can then call lookupProduct() or search Amazon with this.
 *
 * @param {object} classified  result from classifyResult()
 * @returns {string}
 */
export function buildScanPrompt(classified) {
  const { value, formatLabel, category, isProduct, isUrl, url } = classified;

  if (isUrl)      return `I'm pointing my camera at a QR code that links to: ${url}. What is this, and do you want me to open it?`;
  if (category === 'wifi') {
    const wifi = parseWifiQr(value);
    return wifi
      ? `My camera scanned a Wi-Fi QR code. Network: "${wifi.ssid}", Encryption: ${wifi.encryption}. Should I connect?`
      : `My camera scanned a Wi-Fi QR code: ${value}`;
  }
  if (category === 'email') return `My camera scanned an email address: ${value}. Would you like me to compose an email?`;
  if (category === 'phone') return `My camera scanned a phone number: ${value}. Would you like me to call or copy it?`;
  if (isProduct)  return `My camera scanned a ${formatLabel} barcode: ${value}. Look this product up — find the name, specs, and price on Amazon.`;

  return `My camera scanned a ${formatLabel} code with value: ${value}. What is this?`;
}

/**
 * Return the most-likely search URL for a classified scan result.
 * Used for the quick "Search" action button in the barcode toast.
 *
 * @param {object} classified
 * @returns {string}
 */
export function getScanSearchUrl(classified) {
  const { isUrl, url, isProduct, value } = classified;
  if (isUrl)     return url;
  if (isProduct) return `https://www.amazon.com/s?k=${encodeURIComponent(value)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}