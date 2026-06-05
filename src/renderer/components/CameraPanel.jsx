import React, {
    useRef, useState, useEffect, useCallback, useLayoutEffect,
  } from 'react';
  import DetectionOverlay from './DetectionOverlay';
  import { CONFIG } from '../config';
import { analyseImage } from '../utils/llmService';
import { BarcodeScanner } from '../utils/barcodeScanner';
import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
  
  // ─── Constants ────────────────────────────────────────────────────────────────
  
  const TOOLBAR_H = 36;   // px — must match CSS
  const SCENE_H   = 68;   // px — must match CSS
  
  // Object-category colour map — label prefix → hex colour
  const CATEGORY_COLORS = {
    person: '#e84040', face: '#e84040', hand: '#e84040',
    laptop: '#3ecfb2', keyboard: '#3ecfb2', monitor: '#3ecfb2', phone: '#3ecfb2',
    book:   '#e8a628', notebook: '#e8a628', paper: '#e8a628', pen: '#e8a628',
    cup:    '#a78bfa', mug: '#a78bfa', bottle: '#a78bfa', glass: '#a78bfa',
    default: '#60a5fa',
  };
  
  function colorForLabel(label = '') {
    const key = Object.keys(CATEGORY_COLORS).find(k =>
      label.toLowerCase().includes(k)
    );
    return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.default;
  }
  
  // ─── Vision API call ──────────────────────────────────────────────────────────
  
  /**
   * Sends a base64 JPEG frame to Claude vision and returns
   * { description: string, objects: Array<{ label, confidence, bbox }> }
   *
   * bbox values are normalised 0–1 (x, y, w, h relative to frame dimensions).
   */
  async function analyseFrame(base64Jpeg, llmProvider, llmApiKey) {
    const prompt = `Analyse this image. Return ONLY valid JSON — no markdown, no explanation:
  {
    "description": "<one sentence summary>",
    "objects": [
      { "label": "<name>", "confidence": <0-1>, "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> } }
    ]
  }
  Include every clearly visible object. Confidence reflects how certain you are.`;
  
    const text = await analyseImage(llmProvider, llmApiKey, base64Jpeg, prompt);
  
    // Strip possible markdown fences before parsing
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
  
    return {
      description: parsed.description ?? '',
      objects: (parsed.objects ?? [])
        .filter(o => o.confidence >= CONFIG.vision.minConfidence)
        .map(o => ({ ...o, color: colorForLabel(o.label) })),
    };
  }
  
  // ─── Capture a downscaled JPEG from the video element ────────────────────────
  
  function captureFrame(videoEl, quality = CONFIG.vision.frameQuality) {
    const maxW = CONFIG.vision.maxFrameWidth;
    const scale = Math.min(1, maxW / videoEl.videoWidth);
    const w = Math.round(videoEl.videoWidth  * scale);
    const h = Math.round(videoEl.videoHeight * scale);
  
    const offscreen = document.createElement('canvas');
    offscreen.width  = w;
    offscreen.height = h;
    offscreen.getContext('2d').drawImage(videoEl, 0, 0, w, h);
    // Returns "data:image/jpeg;base64,..." — strip the prefix
    return offscreen.toDataURL('image/jpeg', quality).split(',')[1];
  }
  
  // ─── Component ────────────────────────────────────────────────────────────────
  
  export default function CameraPanel({ onVisionUpdate, onFreezeToggle, frozenFrame, llmProvider, llmApiKey, onBarcodeScan }) {
    const videoRef   = useRef(null);
    const wrapperRef = useRef(null);
  
    const [stream,        setStream]        = useState(null);
    const [cameraError,   setCameraError]   = useState(null);
    const [camDims,       setCamDims]       = useState({ w: 0, h: 0 }); // rendered px
    const [scanning,      setScanning]      = useState(false);
    const [overlayOn,     setOverlayOn]     = useState(true);
    const [isFrozen,      setIsFrozen]      = useState(false);
    const [isAnalysing,   setIsAnalysing]   = useState(false);
    const [detections,    setDetections]    = useState([]);
    const [sceneDesc,     setSceneDesc]     = useState('Waiting for camera...');
    const [barcodeResult, setBarcodeResult] = useState(null);
    const [barcodeOn,     setBarcodeOn]     = useState(CONFIG.barcode.enabled);
    const [fps,           setFps]           = useState(0);
    const [resolution,    setResolution]    = useState('—');
  
    const scanLineRef  = useRef(0);
    const animFrameRef = useRef(null);
    const visionTimer  = useRef(null);
    const barcodeTimer = useRef(null);
    const fpsCounter   = useRef({ frames: 0, last: performance.now() });
    const lastAnalysis = useRef(null);
    const cocoModelRef = useRef(null);
    const localTimerRef = useRef(null);
  
    // API keys are now passed down via props.

    // ─── Fast Local Vision (Frame-wise Bounding Boxes) ────────────────────────
    useEffect(() => {
      let mounted = true;
      cocoSsd.load().then(model => {
        if (mounted) cocoModelRef.current = model;
      }).catch(err => console.warn('[coco-ssd] load failed', err));
      return () => { mounted = false; };
    }, []);

    useEffect(() => {
      if (!stream || isFrozen) {
        clearTimeout(localTimerRef.current);
        return;
      }
      function scheduleNext() {
        clearTimeout(localTimerRef.current);
        localTimerRef.current = setTimeout(async () => {
          const video = videoRef.current;
          const model = cocoModelRef.current;
          if (video && video.readyState >= 2 && model && !isFrozen) {
            try {
              const preds = await model.detect(video);
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              const localDets = preds.map(p => ({
                label: p.class,
                confidence: p.score,
                bbox: {
                  x: Math.max(0, Math.min(1, p.bbox[0] / vw)),
                  y: Math.max(0, Math.min(1, p.bbox[1] / vh)),
                  w: Math.max(0, Math.min(1, p.bbox[2] / vw)),
                  h: Math.max(0, Math.min(1, p.bbox[3] / vh)),
                },
                color: colorForLabel(p.class),
                isLocal: true
              })).filter(d => d.confidence >= CONFIG.vision.minConfidence);
              
              const claudeDets = lastAnalysis.current?.objects || [];
              setDetections([...claudeDets, ...localDets]);
            } catch(e) {}
          }
          scheduleNext();
        }, CONFIG.vision.intervalMs || 100);
      }
      scheduleNext();
      return () => clearTimeout(localTimerRef.current);
    }, [stream, isFrozen]);
  
    // ─── Start camera ─────────────────────────────────────────────────────────
  
    useEffect(() => {
      let localStream = null;
  
      async function initCamera() {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width:  { ideal: CONFIG.vision.camera.width },
              height: { ideal: CONFIG.vision.camera.height },
              facingMode: CONFIG.vision.camera.facingMode,
            },
            audio: false,
          });
          if (videoRef.current) {
            videoRef.current.srcObject = localStream;
            await videoRef.current.play();
            const track = localStream.getVideoTracks()[0];
            const { width, height } = track.getSettings();
            setResolution(`${width}×${height}`);
          }
          setStream(localStream);
          setCameraError(null);
        } catch (err) {
          setCameraError(err.name === 'NotAllowedError'
            ? 'Camera access denied — check permissions in System Preferences.'
            : `Camera error: ${err.message}`
          );
        }
      }
  
      initCamera();
  
      return () => {
        localStream?.getTracks().forEach(t => t.stop());
      };
    }, []);
  
    // ─── Measure rendered video dimensions (for overlay scaling) ──────────────
  
    useLayoutEffect(() => {
      if (!wrapperRef.current) return;
      const ro = new ResizeObserver(() => {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        setCamDims({ w: width, h: height });
      });
      ro.observe(wrapperRef.current);
      return () => ro.disconnect();
    }, []);
  
    // ─── FPS counter (measures actual video decoded frames) ───────────────────
  
    useEffect(() => {
      if (!stream) return;
      const tick = () => {
        const now = performance.now();
        fpsCounter.current.frames++;
        if (now - fpsCounter.current.last >= 1000) {
          setFps(fpsCounter.current.frames);
          fpsCounter.current.frames = 0;
          fpsCounter.current.last = now;
        }
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(animFrameRef.current);
    }, [stream]);
  
    // ─── Vision polling ───────────────────────────────────────────────────────
  
    const runVision = useCallback(async () => {
      if (!videoRef.current || isFrozen || !llmApiKey || isAnalysing) return;
      if (videoRef.current.readyState < 2) return; // not enough data yet
  
      setIsAnalysing(true);
      try {
        const base64 = captureFrame(videoRef.current);
        const result = await analyseFrame(base64, llmProvider, llmApiKey);
        lastAnalysis.current = result;
        setDetections(prev => {
          const locals = prev.filter(d => d.isLocal);
          return [...(result.objects || []), ...locals];
        });
        setSceneDesc(result.description);
        onVisionUpdate?.(result);
      } catch (err) {
        console.warn('[vision]', err.message);
      } finally {
        setIsAnalysing(false);
      }
    }, [isFrozen, llmProvider, llmApiKey, isAnalysing, onVisionUpdate]);
  
    useEffect(() => {
      if (!stream || !llmApiKey) return;
      runVision();
      visionTimer.current = setInterval(runVision, CONFIG.vision.apiIntervalMs);
      return () => clearInterval(visionTimer.current);
    }, [stream, llmApiKey, runVision]);
  
    // ─── Barcode scanning (ZXing — lazy-loaded) ───────────────────────────────
  
    useEffect(() => {
      if (!stream || !barcodeOn || isFrozen) return;
  
      let scanner = null;
  
      async function startScanning() {
        try {
          scanner = new BarcodeScanner(videoRef.current, {
            onResult: (classified) => {
              setBarcodeResult(`[${classified.formatLabel}] ${classified.value}`);
              onBarcodeScan?.(classified);
              
              // Open URLs instantly
              if (classified.isUrl && classified.url) {
                window.open(classified.url, '_blank');
              } else if (classified.category === 'qr' && classified.searchUrl) {
                window.open(classified.searchUrl, '_blank');
              }
              
              // Auto-clear after 4 s
              setTimeout(() => setBarcodeResult(null), 4000);
            },
            onError: (err) => {
              console.warn('[barcode]', err);
            }
          });
          await scanner.start();
        } catch (err) {
          console.warn('[barcode] Init failed:', err.message);
        }
      }
  
      startScanning();
      return () => {
        scanner?.stop();
      };
    }, [stream, barcodeOn, isFrozen, onBarcodeScan]);
  
    // ─── Freeze frame ─────────────────────────────────────────────────────────
  
    const handleFreeze = useCallback(() => {
      if (!videoRef.current) return;
      const next = !isFrozen;
      setIsFrozen(next);
      const frameB64 = next ? captureFrame(videoRef.current, 0.92) : null;
      onFreezeToggle?.(frameB64);
    }, [isFrozen, onFreezeToggle]);
  
    // ─── Toolbar actions ──────────────────────────────────────────────────────
  
    const toggleScan = () => setScanning(s => !s);
    const toggleOverlay = () => setOverlayOn(o => !o);
  
    // ─── Styles ───────────────────────────────────────────────────────────────
  
    const S = styles;
  
    // ─── Render ───────────────────────────────────────────────────────────────
  
    return (
      <div style={S.root}>
  
        {/* ── Toolbar ── */}
        <div style={S.toolbar}>
          <div style={S.toolbarLeft}>
            <span style={S.recDot} />
            <span style={S.toolbarLabel}>CAMERA</span>
            <span style={S.sep}>·</span>
            <span style={S.toolbarLabel}>{resolution}</span>
            <span style={S.sep}>·</span>
            <span style={S.toolbarLabel}>{fps} FPS</span>
            {isAnalysing && <span style={S.analysing}>◌ analysing</span>}
          </div>
          <div style={S.toolbarRight}>
            <ToolBtn active={isFrozen}  onClick={handleFreeze}   title={isFrozen ? 'Unfreeze' : 'Freeze frame'}>⏸</ToolBtn>
            <ToolBtn active={scanning}  onClick={toggleScan}     title="Scan sweep">⌖</ToolBtn>
            <ToolBtn active={overlayOn} onClick={toggleOverlay}  title="Toggle overlays">◫</ToolBtn>
            <ToolBtn active={barcodeOn} onClick={() => setBarcodeOn(b => !b)} title="Barcode mode">▦</ToolBtn>
          </div>
        </div>
  
        {/* ── Camera viewport ── */}
        <div style={S.viewport} ref={wrapperRef}>
  
          {/* Live video */}
          <video
            ref={videoRef}
            style={{ ...S.video, opacity: isFrozen ? 0 : 1 }}
            autoPlay
            playsInline
            muted
          />
  
          {/* Frozen frame image */}
          {isFrozen && frozenFrame && (
            <img
              src={`data:image/jpeg;base64,${frozenFrame}`}
              style={S.frozenImg}
              alt="Frozen frame"
            />
          )}
  
          {/* Camera error state */}
          {cameraError && (
            <div style={S.errorOverlay}>
              <div style={S.errorIcon}>⚠</div>
              <div style={S.errorText}>{cameraError}</div>
            </div>
          )}
  
          {/* Scan sweep line */}
          {scanning && <ScanLine height={camDims.h} />}
  
          {/* Bounding box overlay */}
          {overlayOn && camDims.w > 0 && (
            <DetectionOverlay
              detections={detections}
              canvasW={camDims.w}
              canvasH={camDims.h}
            />
          )}
  
          {/* Frozen badge */}
          {isFrozen && (
            <div style={S.frozenBadge}>FROZEN</div>
          )}
  
          {/* REC badge */}
          {!isFrozen && stream && (
            <div style={S.recBadge}>● REC</div>
          )}
  
          {/* Barcode result toast */}
          {barcodeResult && (
            <div style={S.barcodeToast}>
              <span style={S.barcodeIcon}>▦</span>
              <span style={S.barcodeText}>{barcodeResult}</span>
            </div>
          )}
  
          {/* Resolution watermark */}
          {camDims.w > 0 && (
            <div style={S.watermark}>
              {Math.round(camDims.w)}×{Math.round(camDims.h)}
              {' · '}
              {new Date().toLocaleTimeString('en-US', { hour12: false })}
            </div>
          )}
        </div>
  
        {/* ── Scene info strip ── */}
        <div style={S.sceneStrip}>
          <div style={S.sceneRow}>
            <span style={S.sceneLabel}>SCENE ·</span>
            <span style={S.sceneDesc}>{sceneDesc}</span>
          </div>
          <div style={S.chipsRow}>
            {detections.slice(0, 8).map((d, i) => (
              <span key={i} style={{ ...S.chip, borderColor: d.color + '55', color: d.color, background: d.color + '12' }}>
                {d.label}
              </span>
            ))}
          </div>
        </div>
  
      </div>
    );
  }
  
  // ─── Scan Line sub-component ──────────────────────────────────────────────────
  
  function ScanLine({ height }) {
    const [y, setY] = useState(0);
    useEffect(() => {
      let pos = 0;
      const id = setInterval(() => {
        pos = (pos + 1.5) % (height || 400);
        setY(pos);
      }, 16);
      return () => clearInterval(id);
    }, [height]);
  
    return (
      <div style={{
        position: 'absolute', left: 0, right: 0,
        top: y, height: 32, pointerEvents: 'none',
        background: 'linear-gradient(to bottom, transparent, #3ecfb218, transparent)',
        zIndex: 5,
      }} />
    );
  }
  
  // ─── Toolbar button sub-component ─────────────────────────────────────────────
  
  function ToolBtn({ active, onClick, title, children }) {
    return (
      <button
        title={title}
        onClick={onClick}
        style={{
          width: 26, height: 26, borderRadius: 5,
          border: `1px solid ${active ? '#3ecfb2' : '#2a2f42'}`,
          background: active ? '#3ecfb218' : 'transparent',
          color: active ? '#3ecfb2' : '#7a8099',
          cursor: 'pointer', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}
      >
        {children}
      </button>
    );
  }
  
  // ─── Styles ───────────────────────────────────────────────────────────────────
  
  const styles = {
    root: {
      display: 'flex', flexDirection: 'column',
      height: '100%', background: '#080a0f', overflow: 'hidden',
    },
    toolbar: {
      height: TOOLBAR_H, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 12px', borderBottom: '1px solid #1e2333',
      background: '#0e1118',
    },
    toolbarLeft: {
      display: 'flex', alignItems: 'center', gap: 6,
    },
    toolbarRight: {
      display: 'flex', alignItems: 'center', gap: 3,
    },
    toolbarLabel: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 9, color: '#3d4259', letterSpacing: '0.1em',
    },
    sep: { color: '#2a2f42', fontSize: 9 },
    recDot: {
      width: 5, height: 5, borderRadius: '50%',
      background: '#e84040', boxShadow: '0 0 5px #e84040',
      display: 'inline-block', animation: 'pulse 2s infinite',
    },
    analysing: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 9, color: '#3ecfb2', marginLeft: 4,
      animation: 'pulse 1.2s infinite',
    },
    viewport: {
      flex: 1, position: 'relative', overflow: 'hidden',
      background: '#080a0f',
    },
    video: {
      position: 'absolute', inset: 0,
      width: '100%', height: '100%',
      objectFit: 'cover', transition: 'opacity 0.2s',
    },
    frozenImg: {
      position: 'absolute', inset: 0,
      width: '100%', height: '100%', objectFit: 'cover',
    },
    errorOverlay: {
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#080a0fee', gap: 10,
    },
    errorIcon: { fontSize: 28, color: '#e84040' },
    errorText: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 11, color: '#7a8099',
      textAlign: 'center', maxWidth: 280, lineHeight: 1.6, padding: '0 20px',
    },
    recBadge: {
      position: 'absolute', top: 8, right: 10,
      fontFamily: "'Syne Mono', monospace", fontSize: 8,
      color: '#fff', background: '#e84040cc',
      padding: '3px 7px', borderRadius: 3, zIndex: 20,
    },
    frozenBadge: {
      position: 'absolute', top: 8, right: 10,
      fontFamily: "'Syne Mono', monospace", fontSize: 8,
      color: '#fff', background: '#e8a628cc',
      padding: '3px 7px', borderRadius: 3, zIndex: 20,
      letterSpacing: '0.1em',
    },
    barcodeToast: {
      position: 'absolute', bottom: 10, left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: 8,
      background: '#0e1118ee', border: '1px solid #3ecfb244',
      borderRadius: 6, padding: '6px 12px', zIndex: 30,
    },
    barcodeIcon: { fontSize: 14, color: '#3ecfb2' },
    barcodeText: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 11, color: '#eef0f5', letterSpacing: '0.05em',
    },
    watermark: {
      position: 'absolute', bottom: 6, left: 8,
      fontFamily: "'Syne Mono', monospace",
      fontSize: 8, color: '#3ecfb244', zIndex: 5,
      letterSpacing: '0.05em',
    },
    sceneStrip: {
      height: SCENE_H, flexShrink: 0,
      padding: '7px 12px',
      borderTop: '1px solid #1e2333', background: '#0e1118',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    },
    sceneRow: { display: 'flex', alignItems: 'center', gap: 6 },
    sceneLabel: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 8.5, color: '#3d4259', letterSpacing: '0.1em', flexShrink: 0,
    },
    sceneDesc: { fontSize: 11.5, color: '#7a8099', lineHeight: 1.3 },
    chipsRow: { display: 'flex', gap: 4, flexWrap: 'nowrap', overflow: 'hidden' },
    chip: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 9, padding: '2px 7px', borderRadius: 3,
      border: '1px solid', whiteSpace: 'nowrap',
    },
  };