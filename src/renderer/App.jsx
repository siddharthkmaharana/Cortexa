import React, { useState, useEffect, useCallback } from 'react';
import CameraPanel from './components/CameraPanel';
import ChatPanel from './components/ChatPanel';
import StatusBar from './components/StatusBar';
import Settings from './components/Settings';
import { CONFIG } from './config';

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  // ── Backend status ──
  const [backendOnline, setBackendOnline] = useState(false);
  const [backendError, setBackendError]   = useState(null);

  // ── Vision state (shared between camera and agent) ──
  const [sceneDescription, setSceneDescription] = useState('');
  const [detectedObjects, setDetectedObjects]   = useState([]);   // [{ label, confidence, bbox }]
  const [frozenFrame, setFrozenFrame]           = useState(null); // base64 JPEG or null

  // ── Voice state ──
  const [voiceActive, setVoiceActive] = useState(false);

  // ── Barcode state ──
  const [scannedBarcode, setScannedBarcode] = useState(null);

  // ── Panel split (resizable) ──
  const [splitPct, setSplitPct] = useState(CONFIG.ui.defaultSplitPct); // 0–100
  const [dragging, setDragging] = useState(false);

  // ── Settings ──
  const [showSettings, setShowSettings] = useState(false);
  const [llmProvider, setLlmProvider] = useState('claude');
  const [llmApiKey, setLlmApiKey] = useState('');

  // ─── Backend lifecycle events ─────────────────────────────────────────────

  useEffect(() => {
    const offReady   = window.cortexa.on('backend:ready',   () => { setBackendOnline(true);  setBackendError(null); });
    const offStopped = window.cortexa.on('backend:stopped', () =>   setBackendOnline(false));
    const offError   = window.cortexa.on('backend:error',   ({ message }) => setBackendError(message));

    // Check current status on mount (backend may have already started)
    window.cortexa.backendStatus().then(status => {
      if (status.running) setBackendOnline(true);
    });

    return () => { offReady(); offStopped(); offError(); };
  }, []);

  // ─── Load LLM credentials ──────────────────────────────────────────────────

  useEffect(() => {
    window.cortexa.loadKeys().then(({ keys }) => {
      if (keys) {
        if (keys.llmProvider) setLlmProvider(keys.llmProvider);
        if (keys.llmApiKey) setLlmApiKey(keys.llmApiKey);
        else if (keys.anthropicKey) setLlmApiKey(keys.anthropicKey);
      }
    });
  }, []);

  // ─── Panel resize (drag the divider) ─────────────────────────────────────

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e) => {
      const pct = (e.clientX / window.innerWidth) * 100;
      setSplitPct(Math.min(Math.max(pct, 30), 70)); // clamp 30–70 %
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  // ─── Vision callbacks (Camera → App → Chat) ───────────────────────────────

  const handleVisionUpdate = useCallback(({ description, objects }) => {
    setSceneDescription(description);
    setDetectedObjects(objects);
  }, []);

  const handleFreezeToggle = useCallback((frameBase64) => {
    setFrozenFrame(prev => (prev ? null : frameBase64));
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      {/* ── Top status bar ── */}
      <StatusBar
        backendOnline={backendOnline}
        backendError={backendError}
        voiceActive={voiceActive}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* ── Main split body ── */}
      <div style={styles.body}>

        {/* Left panel — camera + vision */}
        <div style={{ ...styles.panel, width: `${splitPct}%` }}>
          <CameraPanel
            onVisionUpdate={handleVisionUpdate}
            onFreezeToggle={handleFreezeToggle}
            frozenFrame={frozenFrame}
            llmProvider={llmProvider}
            llmApiKey={llmApiKey}
            onBarcodeScan={setScannedBarcode}
          />
        </div>

        {/* Drag divider */}
        <div
          style={{ ...styles.divider, cursor: dragging ? 'col-resize' : 'col-resize' }}
          onMouseDown={onDividerMouseDown}
        >
          <div style={styles.dividerHandle} />
        </div>

        {/* Right panel — agent + chat */}
        <div style={{ ...styles.panel, flex: 1 }}>
          <ChatPanel
            sceneDescription={sceneDescription}
            detectedObjects={detectedObjects}
            frozenFrame={frozenFrame}
            backendOnline={backendOnline}
            voiceActive={voiceActive}
            onVoiceToggle={setVoiceActive}
            llmProvider={llmProvider}
            llmApiKey={llmApiKey}
            scannedBarcode={scannedBarcode}
          />
        </div>

      </div>

      {/* ── Backend error banner ── */}
      {backendError && (
        <div style={styles.errorBanner}>
          <span style={styles.errorIcon}>⚠</span>
          <span>Automation offline — {backendError}</span>
          <button style={styles.errorDismiss} onClick={() => setBackendError(null)}>✕</button>
        </div>
      )}

      {/* ── Settings Overlay ── */}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    background: '#080a0f',
    overflow: 'hidden',
    userSelect: 'none',
    fontFamily: "'Outfit', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  divider: {
    width: 4,
    background: '#1e2333',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.15s',
    zIndex: 10,
  },
  dividerHandle: {
    width: 2,
    height: 40,
    borderRadius: 2,
    background: '#2a2f42',
  },
  errorBanner: {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 16px',
    borderRadius: 8,
    background: '#1a0e0e',
    border: '1px solid #e8404055',
    color: '#e84040',
    fontSize: 12,
    fontFamily: "'Syne Mono', monospace",
    zIndex: 999,
    boxShadow: '0 4px 24px #00000066',
  },
  errorIcon: {
    fontSize: 14,
  },
  errorDismiss: {
    background: 'none',
    border: 'none',
    color: '#e8404088',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
    marginLeft: 4,
  },
};
