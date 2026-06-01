import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import { CONFIG } from '../config';

// ─── Browser support check ────────────────────────────────────────────────────

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

const HAS_WEB_SPEECH = Boolean(SpeechRecognition);
const HAS_MEDIA_RECORDER = Boolean(window.MediaRecorder);

// ─── Audio level sampler ──────────────────────────────────────────────────────

/**
 * Attaches a Web Audio analyser to a MediaStream and calls
 * onLevel(0–1) at ~30 fps. Returns a cleanup function.
 */
function createLevelSampler(stream, onLevel) {
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let raf;

    function tick() {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      onLevel(Math.min(avg / 80, 1)); // normalise to 0–1
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      ctx.close();
    };
  } catch (_) {
    return () => { };
  }
}

// ─── Web Speech API STT ───────────────────────────────────────────────────────

/**
 * Wraps the browser's SpeechRecognition into a simple start/stop API.
 *
 * onTranscript(text, isFinal)  — called with interim + final results
 * onEnd()                       — called when recognition stops (any reason)
 * onError(message)              — called on recognition error
 */
function createWebSpeechRecogniser({ onTranscript, onEnd, onError }) {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = CONFIG.voice.language;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    let finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    if (finalText) onTranscript(finalText.trim(), true);
    else if (interim) onTranscript(interim.trim(), false);
  };

  rec.onend = onEnd;
  rec.onerror = (e) => {
    if (e.error === 'no-speech') return; // silence — not an error
    onError(`Speech recognition error: ${e.error}`);
  };

  return {
    start: () => { try { rec.start(); } catch (_) { } },
    stop: () => { try { rec.stop(); } catch (_) { } },
    abort: () => { try { rec.abort(); } catch (_) { } },
  };
}

// ─── Whisper STT (via local FastAPI backend) ──────────────────────────────────

/**
 * Records audio with MediaRecorder, sends the blob to the backend's
 * /voice/transcribe endpoint, and calls onTranscript with the result.
 */
function createWhisperRecorder({ onTranscript, onEnd, onError }) {
  let mediaRecorder = null;
  let stream = null;
  let chunks = [];
  let cleanupLevel = () => { };
  let stopped = false;

  async function start(onLevel) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      cleanupLevel = createLevelSampler(stream, onLevel);

      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunks = [];
      stopped = false;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        cleanupLevel();
        stream?.getTracks().forEach(t => t.stop());

        if (stopped || chunks.length === 0) { onEnd(); return; }

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'recording.webm');

        try {
          const res = await fetch(
            `http://127.0.0.1:${CONFIG.backend.defaultPort}/voice/transcribe`,
            { method: 'POST', body: form }
          );
          const data = await res.json();
          if (data.text?.trim()) onTranscript(data.text.trim(), true);
        } catch (err) {
          onError(`Whisper transcription failed: ${err.message}`);
        }
        onEnd();
      };

      mediaRecorder.start(200); // collect chunks every 200 ms
    } catch (err) {
      onError(`Microphone access failed: ${err.message}`);
    }
  }

  function stop() {
    try { mediaRecorder?.stop(); } catch (_) { }
  }

  function abort() {
    stopped = true;
    try { mediaRecorder?.stop(); } catch (_) { }
  }

  return { start, stop, abort };
}

// ─── Wake word detector ───────────────────────────────────────────────────────

/**
 * Runs a passive SpeechRecognition in the background, always listening.
 * Calls onWakeWord() when CONFIG.voice.wakeWord is detected in the transcript.
 * Returns a stop() function.
 */
function startWakeWordListener(onWakeWord) {
  if (!HAS_WEB_SPEECH || !CONFIG.voice.wakeWord) return () => { };

  const wake = CONFIG.voice.wakeWord.toLowerCase();
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = CONFIG.voice.language;

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.toLowerCase();
      if (text.includes(wake)) {
        rec.abort();
        onWakeWord();
        return;
      }
    }
  };

  rec.onend = () => {
    // Restart automatically to keep always-on listening
    try { rec.start(); } catch (_) { }
  };

  try { rec.start(); } catch (_) { }
  return () => { try { rec.abort(); } catch (_) { } };
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * VoiceButton
 *
 * Props:
 *   active        — boolean, controlled from parent
 *   onToggle      — (nextActive: boolean) => void
 *   onTranscript  — (text: string, isFinal: boolean) => void
 */
export default function VoiceButton({ active, onToggle, onTranscript }) {
  const [level, setLevel] = useState(0);    // audio level 0–1
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);    // recording seconds
  const [wakeReady, setWakeReady] = useState(false);
  const [tooltip, setTooltip] = useState('');
  const [hovered, setHovered] = useState(false);

  const recogniserRef = useRef(null);
  const whisperRef = useRef(null);
  const stopWakeRef = useRef(() => { });
  const elapsedRef = useRef(null);
  const levelRef = useRef(setLevel);
  const maxTimerRef = useRef(null);

  levelRef.current = setLevel;

  const provider = CONFIG.voice.sttProvider; // 'webSpeechApi' | 'whisper'

  // ─── Derived tooltip ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!CONFIG.voice.enabled) { setTooltip('Voice disabled in config'); return; }
    if (error) { setTooltip(error); return; }
    if (active) {
      setTooltip(`Recording… ${elapsed}s (max ${CONFIG.voice.maxRecordMs / 1000}s) — click to stop`);
    } else if (wakeReady) {
      setTooltip(`Say "${CONFIG.voice.wakeWord}" or click to speak`);
    } else {
      setTooltip('Click to speak');
    }
  }, [active, error, elapsed, wakeReady]);

  // ─── Wake word listener (background, when not recording) ─────────────────

  useEffect(() => {
    if (!CONFIG.voice.enabled || !CONFIG.voice.wakeWord || active) return;

    setWakeReady(true);
    stopWakeRef.current = startWakeWordListener(() => {
      setWakeReady(false);
      onToggle(true);
    });

    return () => {
      stopWakeRef.current();
      setWakeReady(false);
    };
  }, [active, onToggle]);

  // ─── Start recording ──────────────────────────────────────────────────────

  const startRecording = useCallback(() => {
    if (!CONFIG.voice.enabled) return;
    setError(null);
    setElapsed(0);

    // Elapsed timer
    elapsedRef.current = setInterval(() => setElapsed(s => s + 1), 1000);

    // Auto-stop at max duration
    maxTimerRef.current = setTimeout(() => {
      stopRecording();
    }, CONFIG.voice.maxRecordMs);

    // ── Web Speech API ──
    if (provider === 'webSpeechApi' && HAS_WEB_SPEECH) {
      recogniserRef.current = createWebSpeechRecogniser({
        onTranscript: (text, isFinal) => {
          onTranscript?.(text, isFinal);
        },
        onEnd: () => {
          // Web Speech auto-stops on silence — re-start if still active
          if (active) {
            try { recogniserRef.current?.start(); } catch (_) { }
          }
        },
        onError: (msg) => {
          setError(msg);
          onToggle(false);
        },
      });
      recogniserRef.current.start();
      return;
    }

    // ── Whisper via backend ──
    if (provider === 'whisper' && HAS_MEDIA_RECORDER) {
      whisperRef.current = createWhisperRecorder({
        onTranscript: (text, isFinal) => onTranscript?.(text, isFinal),
        onEnd: () => onToggle(false),
        onError: (msg) => { setError(msg); onToggle(false); },
      });
      whisperRef.current.start((lvl) => levelRef.current(lvl));
      return;
    }

    // ── Fallback: nothing available ──
    setError(
      HAS_WEB_SPEECH
        ? 'Voice unavailable — check microphone permissions'
        : 'Speech recognition not supported in this browser'
    );
    onToggle(false);
  }, [provider, active, onTranscript, onToggle]);

  // ─── Stop recording ───────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    clearInterval(elapsedRef.current);
    clearTimeout(maxTimerRef.current);
    setLevel(0);
    setElapsed(0);
    recogniserRef.current?.stop();
    recogniserRef.current = null;
    whisperRef.current?.stop();
    whisperRef.current = null;
  }, []);

  // ─── React to active prop change ──────────────────────────────────────────

  useEffect(() => {
    if (active) startRecording();
    else stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopRecording();
      stopWakeRef.current();
    };
  }, [stopRecording]);

  // ─── Click handler ────────────────────────────────────────────────────────

  const handleClick = () => {
    if (!CONFIG.voice.enabled) return;
    setError(null);
    onToggle(!active);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const disabled = !CONFIG.voice.enabled;

  return (
    <div style={S.wrapper}>
      {/* ── Ripple rings when active ── */}
      {active && (
        <>
          <div style={{ ...S.ring, ...S.ring1 }} />
          <div style={{ ...S.ring, ...S.ring2 }} />
        </>
      )}

      {/* ── Audio level ring ── */}
      <svg
        style={S.levelRing}
        viewBox="0 0 40 40"
        fill="none"
      >
        <circle
          cx="20" cy="20"
          r="17"
          stroke={active ? '#3ecfb2' : '#2a2f42'}
          strokeWidth="1"
          strokeOpacity={active ? 0.3 : 0.5}
          fill="none"
        />
        {active && (
          <circle
            cx="20" cy="20"
            r="17"
            stroke="#3ecfb2"
            strokeWidth="2"
            strokeDasharray={`${level * 107} 107`}  /* circumference ≈ 107 */
            strokeLinecap="round"
            fill="none"
            transform="rotate(-90 20 20)"
            style={{ transition: 'stroke-dasharray 0.1s ease-out' }}
          />
        )}
      </svg>

      {/* ── Main button ── */}
      <button
        style={{
          ...S.btn,
          ...(active ? S.btnActive : {}),
          ...(hovered ? S.btnHovered : {}),
          ...(disabled ? S.btnDisabled : {}),
          ...(wakeReady && !active ? S.btnWakeReady : {}),
        }}
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        disabled={disabled}
        title={tooltip}
        aria-label={active ? 'Stop recording' : 'Start voice input'}
        aria-pressed={active}
      >
        {active
          ? <WaveIcon level={level} />
          : <MicIcon wakeReady={wakeReady} />
        }
      </button>

      {/* ── Recording badge ── */}
      {active && (
        <div style={S.badge}>
          <span style={S.badgeDot} />
          <span style={S.badgeTime}>{elapsed}s</span>
        </div>
      )}

      {/* ── Error tooltip ── */}
      {error && (
        <div style={S.errorTip}>
          {error}
          <button style={S.errorClose} onClick={() => setError(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

// ─── Mic icon sub-component ───────────────────────────────────────────────────

function MicIcon({ wakeReady }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
      {wakeReady && (
        <circle cx="19" cy="5" r="2.5" fill="#3ecfb2" stroke="none" />
      )}
    </svg>
  );
}

// ─── Animated wave bars (shown while recording) ───────────────────────────────

function WaveIcon({ level }) {
  // 5 bars — heights scale with audio level
  const heights = [0.4, 0.7, 1.0, 0.7, 0.4].map(base =>
    Math.max(0.2, base * (0.4 + level * 0.6))
  );
  return (
    <svg viewBox="0 0 20 14" width="18" height="14" fill="currentColor">
      {heights.map((h, i) => {
        const barH = Math.round(h * 12);
        const y = (14 - barH) / 2;
        return (
          <rect
            key={i}
            x={i * 4}
            y={y}
            width={2.5}
            height={barH}
            rx={1.2}
            style={{ transition: 'height 0.1s ease, y 0.1s ease' }}
          />
        );
      })}
    </svg>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  wrapper: {
    position: 'relative',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 40, height: 40, flexShrink: 0,
  },

  // Ripple rings
  ring: {
    position: 'absolute',
    borderRadius: '50%',
    border: '1px solid #3ecfb2',
    pointerEvents: 'none',
  },
  ring1: {
    width: 52, height: 52,
    opacity: 0,
    animation: 'ripple 2s ease-out infinite',
  },
  ring2: {
    width: 60, height: 60,
    opacity: 0,
    animation: 'ripple 2s ease-out 0.6s infinite',
  },

  // SVG level ring (sits behind button)
  levelRing: {
    position: 'absolute',
    width: 40, height: 40,
    top: 0, left: 0,
    pointerEvents: 'none',
    zIndex: 0,
  },

  // Main button
  btn: {
    position: 'relative', zIndex: 1,
    width: 36, height: 36, borderRadius: 7,
    border: '1px solid #2a2f42',
    background: 'transparent',
    color: '#7a8099',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.18s',
    outline: 'none',
  },
  btnHovered: {
    borderColor: '#3ecfb255',
    color: '#3ecfb2',
    background: '#3ecfb20e',
  },
  btnActive: {
    borderColor: '#3ecfb2',
    color: '#3ecfb2',
    background: '#3ecfb218',
    boxShadow: '0 0 12px #3ecfb230',
  },
  btnWakeReady: {
    borderColor: '#3ecfb244',
    color: '#3ecfb299',
  },
  btnDisabled: {
    opacity: 0.3, cursor: 'not-allowed',
  },

  // Recording time badge (top-right of button)
  badge: {
    position: 'absolute', top: -4, right: -4,
    background: '#e84040',
    borderRadius: 6,
    padding: '1px 4px',
    display: 'flex', alignItems: 'center', gap: 2,
    zIndex: 2,
    pointerEvents: 'none',
  },
  badgeDot: {
    width: 4, height: 4, borderRadius: '50%',
    background: '#fff',
    animation: 'pulse 1s infinite',
    display: 'inline-block',
  },
  badgeTime: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 7, color: '#fff',
  },

  // Error tooltip
  errorTip: {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: '50%', transform: 'translateX(-50%)',
    background: '#1a0e0e', border: '1px solid #e8404055',
    borderRadius: 5, padding: '5px 8px',
    fontFamily: "'Syne Mono', monospace",
    fontSize: 9, color: '#e84040',
    whiteSpace: 'nowrap', zIndex: 50,
    display: 'flex', alignItems: 'center', gap: 6,
    boxShadow: '0 4px 16px #00000066',
  },
  errorClose: {
    background: 'none', border: 'none',
    color: '#e8404066', cursor: 'pointer', fontSize: 11, padding: 0,
  },
};

// ─── Global keyframe animations ───────────────────────────────────────────────

const styleTag = document.createElement('style');
styleTag.textContent = `
    @keyframes ripple {
      0%   { transform: scale(0.8); opacity: 0.5; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
  `;
document.head.appendChild(styleTag);