/**
 * config.js — CORTEXA runtime configuration
 *
 * Single source of truth for every tunable value in the app.
 * Change values here — nowhere else. Components import CONFIG
 * and read what they need; nothing is hard-coded in components.
 *
 * All values can be overridden at runtime via localStorage so
 * users can tweak settings without rebuilding.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read a value from localStorage, falling back to `defaultVal`.
 * Automatically parses numbers and booleans.
 */
function ls(key, defaultVal) {
    try {
      const raw = localStorage.getItem(`cortexa.${key}`);
      if (raw === null) return defaultVal;
      if (typeof defaultVal === 'boolean') return raw === 'true';
      if (typeof defaultVal === 'number')  return Number(raw) || defaultVal;
      return raw;
    } catch (_) {
      return defaultVal;
    }
  }
  
  // ─── Config Object ────────────────────────────────────────────────────────────
  
  export const CONFIG = {
  
    // ── Vision ──────────────────────────────────────────────────────────────────
    vision: {
      /**
       * How often (ms) to capture a frame and send it to the Claude vision API.
       */
      intervalMs: ls('vision.intervalMs', 100),
  
      /**
       * How often (ms) to send the frame to the Claude vision API for deep scene analysis.
       * Defaulted to 15000 (15s) to avoid hitting rate limits.
       */
      apiIntervalMs: ls('vision.apiIntervalMs', 15000),
  
      /**
       * JPEG quality for frames sent to the API (0.0–1.0).
       * Lower quality reduces token usage; 0.75 is a good balance.
       */
      frameQuality: ls('vision.frameQuality', 0.75),
  
      /**
       * Maximum frame width (px) before downscaling.
       * The camera feed may be 1280px wide — we don't need to send that.
       */
      maxFrameWidth: ls('vision.maxFrameWidth', 640),
  
      /**
       * Minimum confidence threshold (0–1) to show a detection overlay.
       * Detections below this are silently dropped.
       */
      minConfidence: ls('vision.minConfidence', 0.60),
  
      /**
       * Camera resolution hint passed to getUserMedia.
       */
      camera: {
        width:  ls('vision.camera.width',  1280),
        height: ls('vision.camera.height',  720),
        facingMode: 'user',
      },
    },
  
    // ── Agent ────────────────────────────────────────────────────────────────────
    agent: {
      /**
       * Claude model used for the chat agent.
       */
      model: 'claude-sonnet-4-20250514',
  
      /**
       * Maximum tokens the agent may generate per response.
       */
      maxTokens: ls('agent.maxTokens', 1024),
  
      /**
       * How many conversation turns (user + assistant pairs) to keep
       * in the rolling history sent with each request.
       * Higher = better memory, more tokens per call.
       */
      maxHistoryTurns: ls('agent.maxHistoryTurns', 20),
  
      /**
       * Temperature for chat responses (0.0–1.0).
       * Lower = more deterministic; higher = more creative.
       */
      temperature: ls('agent.temperature', 0.7),
    },
  
    // ── Voice ────────────────────────────────────────────────────────────────────
    voice: {
      /**
       * Whether voice input is enabled at all.
       */
      enabled: ls('voice.enabled', true),
  
      /**
       * Speech-to-text provider.
       *   'webSpeechApi' — Chromium built-in, zero latency, no backend required
       *   'whisper'      — OpenAI Whisper via local backend, higher accuracy
       */
      sttProvider: ls('voice.sttProvider', 'webSpeechApi'),
  
      /**
       * Text-to-speech provider.
       *   'browser'    — speechSynthesis API, built-in, no API key required
       *   'elevenlabs' — ElevenLabs API, premium voice quality
       */
      ttsProvider: ls('voice.ttsProvider', 'browser'),
  
      /**
       * Whether to auto-read agent responses aloud.
       */
      autoSpeak: ls('voice.autoSpeak', false),
  
      /**
       * BCP-47 language tag for the Web Speech API recogniser.
       */
      language: ls('voice.language', 'en-US'),
  
      /**
       * Maximum recording duration (ms) before auto-stopping.
       * Prevents accidental open-mic sessions.
       */
      maxRecordMs: ls('voice.maxRecordMs', 30_000),
  
      /**
       * Wake word phrase (lower-cased). Compared against interim transcript.
       * Set to '' to disable wake word detection.
       */
      wakeWord: ls('voice.wakeWord', 'hey cortexa'),
    },
  
    // ── Barcode Scanning ────────────────────────────────────────────────────────
    barcode: {
      /**
       * Whether ZXing.js barcode/QR scanning is active.
       */
      enabled: ls('barcode.enabled', true),
  
      /**
       * How often (ms) to run the ZXing decoder against the canvas.
       * 500 ms gives near-instant detection without hammering the CPU.
       */
      intervalMs: ls('barcode.intervalMs', 500),
    },
  
    // ── Emotion Detection ───────────────────────────────────────────────────────
    emotion: {
      /**
       * Whether face-api.js emotion detection is active.
       */
      enabled: ls('emotion.enabled', true),
  
      /**
       * How often (ms) to run emotion inference (runs in a Web Worker).
       */
      intervalMs: ls('emotion.intervalMs', 5000),
  
      /**
       * Minimum score (0–1) for an expression to be considered dominant.
       */
      minScore: ls('emotion.minScore', 0.5),
    },
  
    // ── UI ───────────────────────────────────────────────────────────────────────
    ui: {
      /**
       * Initial split percentage for the left (camera) panel.
       * 54 means the camera panel is 54 % of the window width.
       */
      defaultSplitPct: ls('ui.defaultSplitPct', 54),
  
      /**
       * Animation duration (ms) for UI transitions.
       */
      transitionMs: 150,
  
      /**
       * Maximum number of chat messages to render in the DOM.
       * Older messages are trimmed to keep the list performant.
       */
      maxRenderedMessages: ls('ui.maxRenderedMessages', 200),
    },
  
    // ── Backend ──────────────────────────────────────────────────────────────────
    backend: {
      /**
       * FastAPI server base URL. Always localhost — never changes.
       * The actual port is read from window.cortexa.backendStatus().
       */
      baseUrl: 'http://127.0.0.1',
  
      /**
       * Fallback port if backendStatus() hasn't resolved yet.
       */
      defaultPort: 8000,
  
      /**
       * Request timeout for automation commands (ms).
       */
      requestTimeoutMs: ls('backend.requestTimeoutMs', 10_000),
    },
  };
  