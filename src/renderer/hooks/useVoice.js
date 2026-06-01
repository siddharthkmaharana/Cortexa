import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max characters sent to TTS in one call — long responses are chunked */
const TTS_CHUNK_LIMIT = 500;

/** Silence gap (ms) before an interim transcript is considered abandoned */
const INTERIM_TIMEOUT_MS = 4_000;

/** Wake word poll debounce — how often to check transcript for wake phrase */
const WAKE_DEBOUNCE_MS = 300;

// ─── Sentence chunker for TTS ─────────────────────────────────────────────────

/**
 * Splits text into speakable chunks at sentence boundaries.
 * Keeps chunks under TTS_CHUNK_LIMIT characters so the TTS engine
 * doesn't truncate long responses.
 *
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  // Strip markdown — bold, code, headers
  const clean = text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > TTS_CHUNK_LIMIT) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// ─── STT: Web Speech API ──────────────────────────────────────────────────────

/**
 * Creates a Web Speech API recognition session.
 * Returns { start, stop, abort } — same interface as the Whisper recorder.
 */
function createWebSpeechSession({
  onInterim, onFinal, onEnd, onError, language,
}) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    onError('Web Speech API not available in this browser.');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = language;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (interim) onInterim(interim.trim());
    if (final) onFinal(final.trim());
  };

  rec.onend = onEnd;
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError(`Speech recognition error: ${e.error}`);
  };

  return {
    start: () => { try { rec.start(); } catch (_) { } },
    stop: () => { try { rec.stop(); } catch (_) { } },
    abort: () => { try { rec.abort(); } catch (_) { } },
  };
}

// ─── STT: Whisper via FastAPI backend ─────────────────────────────────────────

/**
 * Creates a MediaRecorder-based Whisper session.
 * Returns { start, stop, abort } — same interface as Web Speech session.
 */
function createWhisperSession({ onFinal, onEnd, onError, onAudioLevel, port }) {
  let mediaRecorder = null;
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let rafHandle = null;
  let chunks = [];
  let aborted = false;

  // ── Audio level sampler ──
  function startLevelSampler(s) {
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        onAudioLevel?.(Math.min(avg / 80, 1));
        rafHandle = requestAnimationFrame(tick);
      }
      rafHandle = requestAnimationFrame(tick);
    } catch (_) { }
  }

  function stopLevelSampler() {
    cancelAnimationFrame(rafHandle);
    try { analyser?.disconnect(); audioCtx?.close(); } catch (_) { }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      startLevelSampler(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      chunks = [];
      aborted = false;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stopLevelSampler();
        stream?.getTracks().forEach(t => t.stop());

        if (aborted || chunks.length === 0) { onEnd(); return; }

        try {
          const blob = new Blob(chunks, { type: mimeType });
          const form = new FormData();
          form.append('audio', blob, 'recording.webm');

          const res = await fetch(
            `http://127.0.0.1:${port}/voice/transcribe`,
            { method: 'POST', body: form },
          );
          const data = await res.json();
          if (data.text?.trim()) onFinal(data.text.trim());
        } catch (err) {
          onError(`Whisper error: ${err.message}`);
        }
        onEnd();
      };

      mediaRecorder.start(250); // collect chunks every 250 ms
    } catch (err) {
      onError(`Mic access failed: ${err.message}`);
    }
  }

  function stop() { try { mediaRecorder?.stop(); } catch (_) { } }
  function abort() { aborted = true; stop(); }

  return { start, stop, abort };
}

// ─── TTS: Browser speechSynthesis ────────────────────────────────────────────

/**
 * Speaks a text string using the browser's speechSynthesis.
 * Resolves when speaking completes, rejects on error.
 *
 * @param {string} text
 * @param {object} opts  { rate, pitch, volume, voiceHint }
 */
function speakBrowser(text, opts = {}) {
  return new Promise((resolve, reject) => {
    window.speechSynthesis.cancel(); // clear any queued utterances

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = CONFIG.voice.language;
    utter.rate = opts.rate ?? 1.05;
    utter.pitch = opts.pitch ?? 0.95;
    utter.volume = opts.volume ?? 1.0;

    // Prefer a natural-sounding voice if available
    const voices = window.speechSynthesis.getVoices();
    const hints = [opts.voiceHint, 'Google', 'Natural', 'Neural', 'Samantha', 'Alex'];
    for (const hint of hints) {
      if (!hint) continue;
      const match = voices.find(v =>
        v.name.includes(hint) && v.lang.startsWith(CONFIG.voice.language.slice(0, 2))
      );
      if (match) { utter.voice = match; break; }
    }

    utter.onend = resolve;
    utter.onerror = (e) => {
      if (e.error === 'interrupted') resolve(); // user cancelled — not an error
      else reject(new Error(`TTS error: ${e.error}`));
    };

    window.speechSynthesis.speak(utter);
  });
}

// ─── TTS: ElevenLabs ─────────────────────────────────────────────────────────

/**
 * Calls the ElevenLabs API and plays the returned audio.
 * Requires elevenLabsKey and voiceId from stored keys.
 *
 * @param {string} text
 * @param {object} keys  { elevenLabsKey, elevenLabsVoiceId }
 */
async function speakElevenLabs(text, keys) {
  const { elevenLabsKey, elevenLabsVoiceId } = keys;
  if (!elevenLabsKey || !elevenLabsVoiceId) {
    throw new Error('ElevenLabs API key or voice ID not configured.');
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  return new Promise((resolve, reject) => {
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Audio playback failed')); };
    audio.play().catch(reject);
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useVoice
 *
 * Full voice pipeline: STT (Web Speech or Whisper), TTS (browser or ElevenLabs),
 * and always-on wake word detection. Exposes a unified interface to the UI.
 *
 * @param {object}   params
 * @param {Function} params.onTranscript  (text: string, isFinal: boolean) => void
 * @param {boolean}  [params.autoSpeak]   auto-TTS agent replies
 *
 * @returns {{
 *   listening:       boolean,
 *   speaking:        boolean,
 *   audioLevel:      number,         0–1 mic amplitude
 *   interimText:     string,         live interim transcript
 *   wakeWordArmed:   boolean,        background listener active
 *   error:           string | null,
 *   startListening:  () => void,
 *   stopListening:   () => void,
 *   speak:           (text: string) => Promise<void>,
 *   cancelSpeaking:  () => void,
 *   armWakeWord:     () => void,
 *   disarmWakeWord:  () => void,
 * }}
 */
export function useVoice({ onTranscript, autoSpeak = CONFIG.voice.autoSpeak }) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [interimText, setInterimText] = useState('');
  const [wakeWordArmed, setWakeWordArmed] = useState(false);
  const [error, setError] = useState(null);

  const sessionRef = useRef(null);   // active STT session
  const wakeSessionRef = useRef(null);   // background wake word session
  const speakQueueRef = useRef([]);     // pending TTS chunks
  const isSpeakingRef = useRef(false);
  const mountedRef = useRef(true);
  const interimTimer = useRef(null);   // auto-clear interim after silence
  const storedKeysRef = useRef({});     // ElevenLabs keys from safeStorage

  // ─── Load stored keys ───────────────────────────────────────────────────

  useEffect(() => {
    window.cortexa.loadKeys().then(({ keys }) => {
      if (keys) storedKeysRef.current = keys;
    });
  }, []);

  // ─── Cleanup on unmount ─────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current?.abort();
      wakeSessionRef.current?.abort();
      window.speechSynthesis?.cancel();
      clearTimeout(interimTimer.current);
    };
  }, []);

  // ─── Interim transcript timeout ─────────────────────────────────────────

  function resetInterimTimer() {
    clearTimeout(interimTimer.current);
    interimTimer.current = setTimeout(() => {
      if (mountedRef.current) setInterimText('');
    }, INTERIM_TIMEOUT_MS);
  }

  // ─── Start listening ────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!CONFIG.voice.enabled || listening) return;

    // Stop any active wake word listener — main session takes over
    wakeSessionRef.current?.abort();
    wakeSessionRef.current = null;
    setWakeWordArmed(false);

    setError(null);
    setListening(true);
    setInterimText('');

    const provider = CONFIG.voice.sttProvider;

    // ── Web Speech API ──
    if (provider === 'webSpeechApi') {
      const session = createWebSpeechSession({
        language: CONFIG.voice.language,
        onInterim: (text) => {
          if (!mountedRef.current) return;
          setInterimText(text);
          onTranscript?.(text, false);
          resetInterimTimer();
        },
        onFinal: (text) => {
          if (!mountedRef.current) return;
          setInterimText('');
          clearTimeout(interimTimer.current);
          onTranscript?.(text, true);
        },
        onEnd: () => {
          if (!mountedRef.current) return;
          // Web Speech auto-stops on silence — restart to keep session alive
          if (listening && sessionRef.current) {
            try { sessionRef.current.start(); } catch (_) { }
          }
        },
        onError: (msg) => {
          if (!mountedRef.current) return;
          setError(msg);
          setListening(false);
        },
      });

      if (!session) { setListening(false); return; }
      sessionRef.current = session;
      session.start();
      return;
    }

    // ── Whisper ──
    if (provider === 'whisper') {
      const session = createWhisperSession({
        port: CONFIG.backend.defaultPort,
        onFinal: (text) => { if (mountedRef.current) onTranscript?.(text, true); },
        onEnd: () => { if (mountedRef.current) setListening(false); },
        onError: (msg) => { if (mountedRef.current) { setError(msg); setListening(false); } },
        onAudioLevel: (lvl) => { if (mountedRef.current) setAudioLevel(lvl); },
      });
      sessionRef.current = session;
      session.start();

      // Auto-stop Whisper after max duration
      setTimeout(() => {
        if (mountedRef.current && listening) stopListening();
      }, CONFIG.voice.maxRecordMs);

      return;
    }

    setError('No speech recognition provider available.');
    setListening(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, onTranscript]);

  // ─── Stop listening ─────────────────────────────────────────────────────

  const stopListening = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    clearTimeout(interimTimer.current);
    if (mountedRef.current) {
      setListening(false);
      setInterimText('');
      setAudioLevel(0);
    }
  }, []);

  // ─── TTS speak queue ────────────────────────────────────────────────────

  /**
   * Internal function that drains the speak queue one chunk at a time.
   * Pauses if the user starts speaking (STT takes priority).
   */
  const drainQueue = useCallback(async () => {
    if (isSpeakingRef.current) return;

    while (speakQueueRef.current.length > 0) {
      if (!mountedRef.current) break;

      // Pause TTS if user is actively speaking
      if (listening) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const chunk = speakQueueRef.current.shift();
      if (!chunk) break;

      isSpeakingRef.current = true;
      if (mountedRef.current) setSpeaking(true);

      try {
        const provider = CONFIG.voice.ttsProvider;

        if (provider === 'elevenlabs') {
          await speakElevenLabs(chunk, storedKeysRef.current);
        } else {
          await speakBrowser(chunk);
        }
      } catch (err) {
        console.warn('[useVoice TTS]', err.message);
        // Fall back to browser TTS if ElevenLabs fails
        try { await speakBrowser(chunk); } catch (_) { }
      } finally {
        isSpeakingRef.current = false;
        if (mountedRef.current) setSpeaking(speakQueueRef.current.length > 0);
      }
    }

    isSpeakingRef.current = false;
    if (mountedRef.current) setSpeaking(false);
  }, [listening]);

  /**
   * Public speak API — enqueues text chunks and starts draining.
   * Safe to call with any length of text.
   *
   * @param {string} text
   */
  const speak = useCallback(async (text) => {
    if (!CONFIG.voice.enabled || !text?.trim()) return;
    const chunks = chunkText(text);
    speakQueueRef.current.push(...chunks);
    drainQueue();
  }, [drainQueue]);

  /** Cancel all pending and active TTS immediately. */
  const cancelSpeaking = useCallback(() => {
    speakQueueRef.current = [];
    window.speechSynthesis?.cancel();
    isSpeakingRef.current = false;
    if (mountedRef.current) setSpeaking(false);
  }, []);

  // ─── Wake word listener ─────────────────────────────────────────────────

  const armWakeWord = useCallback(() => {
    const wake = CONFIG.voice.wakeWord?.toLowerCase();
    if (!wake || !CONFIG.voice.enabled || wakeWordArmed) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = CONFIG.voice.language;

    let debounceTimer = null;

    rec.onresult = (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text = e.results[i][0].transcript.toLowerCase();
          if (text.includes(wake)) {
            rec.abort();
            wakeSessionRef.current = null;
            if (mountedRef.current) {
              setWakeWordArmed(false);
              startListening();
            }
            return;
          }
        }
      }, WAKE_DEBOUNCE_MS);
    };

    rec.onend = () => {
      // Auto-restart to keep always-on
      if (wakeSessionRef.current && mountedRef.current) {
        try { rec.start(); } catch (_) { }
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('[useVoice wake]', e.error);
    };

    try {
      rec.start();
      wakeSessionRef.current = {
        abort: () => { clearTimeout(debounceTimer); try { rec.abort(); } catch (_) { } },
      };
      setWakeWordArmed(true);
    } catch (_) { }
  }, [wakeWordArmed, startListening]);

  const disarmWakeWord = useCallback(() => {
    wakeSessionRef.current?.abort();
    wakeSessionRef.current = null;
    if (mountedRef.current) setWakeWordArmed(false);
  }, []);

  // ─── Auto-arm wake word on mount ────────────────────────────────────────

  useEffect(() => {
    if (CONFIG.voice.enabled && CONFIG.voice.wakeWord) {
      // Small delay — let the browser finish loading voices first
      const t = setTimeout(armWakeWord, 1500);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Audio level decay when not recording (Whisper) ─────────────────────

  useEffect(() => {
    if (listening && CONFIG.voice.sttProvider === 'webSpeechApi') {
      // Web Speech doesn't give us level — simulate a gentle pulse
      let v = 0; let dir = 1;
      const id = setInterval(() => {
        v += dir * 0.05;
        if (v >= 0.6 || v <= 0.1) dir *= -1;
        if (mountedRef.current) setAudioLevel(v);
      }, 80);
      return () => clearInterval(id);
    }
    if (!listening) setAudioLevel(0);
  }, [listening]);

  // ─── Return ─────────────────────────────────────────────────────────────

  return {
    listening,
    speaking,
    audioLevel,
    interimText,
    wakeWordArmed,
    error,
    startListening,
    stopListening,
    speak,
    cancelSpeaking,
    armWakeWord,
    disarmWakeWord,
  };
}