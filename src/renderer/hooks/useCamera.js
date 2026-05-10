import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many FPS samples to average for a stable reading */
const FPS_WINDOW = 30;

/** Minimum ms between captured frames sent externally (anti-flood) */
const CAPTURE_DEBOUNCE_MS = 100;

// ─── Error classifier ─────────────────────────────────────────────────────────

/**
 * Turns a raw getUserMedia DOMException into a human-readable message
 * and a machine-readable code for the UI to act on.
 */
function classifyError(err) {
  const map = {
    NotAllowedError:     { code: 'PERMISSION_DENIED',   message: 'Camera access denied — allow access in System Preferences → Privacy → Camera.' },
    NotFoundError:       { code: 'NO_DEVICE',           message: 'No camera found. Connect a webcam and try again.' },
    NotReadableError:    { code: 'IN_USE',               message: 'Camera is in use by another application.' },
    OverconstrainedError:{ code: 'OVERCONSTRAINED',      message: 'Camera does not support the requested resolution. Trying a lower resolution...' },
    AbortError:          { code: 'ABORTED',              message: 'Camera stream was aborted unexpectedly.' },
    SecurityError:       { code: 'SECURITY',             message: 'Camera access blocked by browser security policy.' },
  };
  const entry = map[err.name] ?? { code: 'UNKNOWN', message: `Camera error: ${err.message}` };
  return { ...entry, raw: err };
}

// ─── Build getUserMedia constraints ──────────────────────────────────────────

function buildConstraints(deviceId, overrides = {}) {
  const base = {
    width:     { ideal: CONFIG.vision.camera.width,  min: 320 },
    height:    { ideal: CONFIG.vision.camera.height, min: 240 },
    facingMode: CONFIG.vision.camera.facingMode,
    frameRate:  { ideal: 30 },
  };
  if (deviceId) {
    delete base.facingMode;
    base.deviceId = { exact: deviceId };
  }
  return { video: { ...base, ...overrides }, audio: false };
}

// ─── Frame capture helper (exported for use in CameraPanel) ──────────────────

/**
 * Draws the current video frame onto an offscreen canvas,
 * downscales it to CONFIG.vision.maxFrameWidth, and returns
 * a base64-encoded JPEG string (without the data: prefix).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {number}           quality  JPEG quality 0–1
 * @returns {string | null}           base64 JPEG or null if not ready
 */
export function captureFrame(videoEl, quality = CONFIG.vision.frameQuality) {
  if (!videoEl || videoEl.readyState < 2) return null;
  if (!videoEl.videoWidth || !videoEl.videoHeight) return null;

  const maxW  = CONFIG.vision.maxFrameWidth;
  const scale = Math.min(1, maxW / videoEl.videoWidth);
  const w     = Math.round(videoEl.videoWidth  * scale);
  const h     = Math.round(videoEl.videoHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);

  // Strip "data:image/jpeg;base64," prefix
  return canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useCamera
 *
 * Manages the full camera lifecycle: device enumeration, stream acquisition,
 * resolution tracking, FPS measurement, device switching, and torch control.
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef  ref to the <video> element
 *
 * @returns {{
 *   stream:          MediaStream | null,
 *   error:           { code, message, raw } | null,
 *   isLoading:       boolean,
 *   devices:         MediaDeviceInfo[],
 *   activeDeviceId:  string,
 *   resolution:      { width: number, height: number } | null,
 *   fps:             number,
 *   torchAvailable:  boolean,
 *   torchOn:         boolean,
 *   switchDevice:    (deviceId: string) => Promise<void>,
 *   toggleTorch:     () => Promise<void>,
 *   retryCamera:     () => void,
 *   capture:         (quality?: number) => string | null,
 * }}
 */
export function useCamera(videoRef) {
  const [stream,         setStream]         = useState(null);
  const [error,          setError]          = useState(null);
  const [isLoading,      setIsLoading]      = useState(true);
  const [devices,        setDevices]        = useState([]);
  const [activeDeviceId, setActiveDeviceId] = useState('');
  const [resolution,     setResolution]     = useState(null);
  const [fps,            setFps]            = useState(0);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn,        setTorchOn]        = useState(false);
  const [retryCount,     setRetryCount]     = useState(0);

  const streamRef       = useRef(null);  // mirrors state, accessible in callbacks
  const fpsTimestamps   = useRef([]);    // ring buffer of frame timestamps
  const rafRef          = useRef(null);  // requestAnimationFrame handle
  const mountedRef      = useRef(true);  // guards async state updates after unmount
  const lastCaptureRef  = useRef(0);     // last captureFrame call timestamp

  // ─── Enumerate video input devices ────────────────────────────────────────

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = all.filter(d => d.kind === 'videoinput');
      if (mountedRef.current) setDevices(videoDevices);
    } catch (_) {}
  }, []);

  // ─── Stop an existing stream cleanly ─────────────────────────────────────

  const stopStream = useCallback((s) => {
    if (!s) return;
    s.getTracks().forEach(track => {
      try { track.stop(); } catch (_) {}
    });
  }, []);

  // ─── Stop FPS counter loop ────────────────────────────────────────────────

  const stopFpsCounter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // ─── Start FPS counter loop ───────────────────────────────────────────────

  const startFpsCounter = useCallback((video) => {
    stopFpsCounter();
    fpsTimestamps.current = [];

    function tick(now) {
      if (!mountedRef.current) return;

      // Push current timestamp, trim to window size
      fpsTimestamps.current.push(now);
      if (fpsTimestamps.current.length > FPS_WINDOW) {
        fpsTimestamps.current.shift();
      }

      // Compute FPS from oldest → newest timestamps in the ring buffer
      const len = fpsTimestamps.current.length;
      if (len >= 2) {
        const span = fpsTimestamps.current[len - 1] - fpsTimestamps.current[0];
        setFps(Math.round(((len - 1) / span) * 1000));
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [stopFpsCounter]);

  // ─── Attach a new stream to the video element ─────────────────────────────

  const attachStream = useCallback(async (newStream, deviceId) => {
    const video = videoRef.current;
    if (!video || !mountedRef.current) return;

    // Detach any previous stream
    if (streamRef.current) {
      stopStream(streamRef.current);
      video.srcObject = null;
    }

    streamRef.current = newStream;
    video.srcObject   = newStream;

    await video.play().catch(() => {});

    // Read actual track settings
    const track    = newStream.getVideoTracks()[0];
    const settings = track?.getSettings() ?? {};

    if (mountedRef.current) {
      setStream(newStream);
      setActiveDeviceId(deviceId || settings.deviceId || '');
      setResolution(
        settings.width && settings.height
          ? { width: settings.width, height: settings.height }
          : null
      );
      setError(null);
      setIsLoading(false);

      // Check torch (flashlight) support
      const caps = track?.getCapabilities?.() ?? {};
      setTorchAvailable(Boolean(caps.torch));
    }

    startFpsCounter(video);
    await refreshDevices();
  }, [videoRef, stopStream, startFpsCounter, refreshDevices]);

  // ─── Open camera (main acquisition function) ──────────────────────────────

  const openCamera = useCallback(async (deviceId, resolutionOverride) => {
    if (!mountedRef.current) return;

    setIsLoading(true);
    setError(null);

    let constraints = buildConstraints(deviceId, resolutionOverride);

    try {
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      await attachStream(newStream, deviceId);
    } catch (err) {
      const classified = classifyError(err);

      // ── Auto-retry: OverconstrainedError → relax to VGA ──
      if (classified.code === 'OVERCONSTRAINED' && !resolutionOverride) {
        console.warn('[useCamera] Overconstrained, retrying at 640×480');
        try {
          const fallback = await navigator.mediaDevices.getUserMedia(
            buildConstraints(deviceId, { width: 640, height: 480 })
          );
          await attachStream(fallback, deviceId);
          return;
        } catch (err2) {
          if (mountedRef.current) {
            setError(classifyError(err2));
            setIsLoading(false);
          }
          return;
        }
      }

      if (mountedRef.current) {
        setError(classified);
        setIsLoading(false);
      }
    }
  }, [attachStream]);

  // ─── Initial camera open + device change listener ────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    openCamera('');

    // Re-enumerate when devices plug/unplug
    const handleDeviceChange = () => refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      mountedRef.current = false;
      stopFpsCounter();
      stopStream(streamRef.current);
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount]);  // retryCount bump triggers a full restart

  // ─── Public API: switch to a different camera device ─────────────────────

  const switchDevice = useCallback(async (deviceId) => {
    if (deviceId === activeDeviceId) return;
    setTorchOn(false);
    await openCamera(deviceId);
  }, [activeDeviceId, openCamera]);

  // ─── Public API: toggle torch / flashlight ────────────────────────────────

  const toggleTorch = useCallback(async () => {
    if (!torchAvailable || !streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;

    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (err) {
      console.warn('[useCamera] Torch toggle failed:', err.message);
    }
  }, [torchAvailable, torchOn]);

  // ─── Public API: retry after error ───────────────────────────────────────

  const retryCamera = useCallback(() => {
    setRetryCount(c => c + 1);
  }, []);

  // ─── Public API: capture current frame ───────────────────────────────────

  const capture = useCallback((quality) => {
    const now = Date.now();
    if (now - lastCaptureRef.current < CAPTURE_DEBOUNCE_MS) return null;
    lastCaptureRef.current = now;
    return captureFrame(videoRef.current, quality);
  }, [videoRef]);

  // ─── Return ───────────────────────────────────────────────────────────────

  return {
    stream,
    error,
    isLoading,
    devices,
    activeDeviceId,
    resolution,
    fps,
    torchAvailable,
    torchOn,
    switchDevice,
    toggleTorch,
    retryCamera,
    capture,
  };
}