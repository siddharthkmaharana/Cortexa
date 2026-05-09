import React, { useState, useEffect, useRef } from 'react';

// ─── Individual status indicator ──────────────────────────────────────────────

/**
 * A single pill in the status bar.
 *
 * Props:
 *   label    — display name
 *   state    — 'online' | 'warn' | 'offline' | 'active'
 *   tooltip  — text shown on hover
 *   pulse    — whether the dot should animate
 */
function StatusPill({ label, state, tooltip, pulse = false }) {
  const [hovered, setHovered] = useState(false);

  const dotColor = {
    online:  '#3ecfb2',
    active:  '#3ecfb2',
    warn:    '#e8a628',
    offline: '#3d4259',
    error:   '#e84040',
  }[state] ?? '#3d4259';

  const textColor = {
    online:  '#7a8099',
    active:  '#3ecfb2',
    warn:    '#e8a628',
    offline: '#3d4259',
    error:   '#e84040',
  }[state] ?? '#3d4259';

  return (
    <div
      style={{
        ...S.pill,
        borderColor: hovered ? dotColor + '44' : 'transparent',
        background:  hovered ? dotColor + '0a' : 'transparent',
        cursor: 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={tooltip}
    >
      <div style={{
        ...S.pillDot,
        background: dotColor,
        boxShadow: (state === 'online' || state === 'active')
          ? `0 0 5px ${dotColor}`
          : 'none',
        animation: pulse ? 'breathe 2.5s ease-in-out infinite' : 'none',
      }} />
      <span style={{ ...S.pillLabel, color: textColor }}>{label}</span>
    </div>
  );
}

// ─── Separator ────────────────────────────────────────────────────────────────

function Sep() {
  return <div style={S.sep} />;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * StatusBar
 *
 * Sits at the very top of the app. Shows:
 *   Left:   CORTEXA logo + live indicator
 *   Centre: Vision / Agent / Automation / Voice status pills
 *   Right:  Session memory counter + live clock
 *
 * Props:
 *   backendOnline  — boolean: FastAPI process healthy
 *   backendError   — string | null: last backend error message
 *   voiceActive    — boolean: microphone is recording
 *   detectedCount  — number: objects detected in last vision pass
 *   memoryTurns    — number: conversation turns in memory
 *   isAnalysing    — boolean: vision API call in-flight
 */
export default function StatusBar({
  backendOnline  = false,
  backendError   = null,
  voiceActive    = false,
  detectedCount  = 0,
  memoryTurns    = 0,
  isAnalysing    = false,
}) {
  const [time,       setTime]       = useState('');
  const [date,       setDate]       = useState('');
  const [uptime,     setUptime]     = useState(0);   // seconds since app opened
  const [camOnline,  setCamOnline]  = useState(false);
  const startRef = useRef(Date.now());

  // ─── Clock + uptime tick ────────────────────────────────────────────────

  useEffect(() => {
    function tick() {
      const now = new Date();
      setTime(now.toLocaleTimeString('en-US', { hour12: false }));
      setDate(now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      setUptime(Math.floor((Date.now() - startRef.current) / 1000));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Camera availability check ──────────────────────────────────────────

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setCamOnline(devices.some(d => d.kind === 'videoinput'));
    }).catch(() => setCamOnline(false));
  }, []);

  // ─── Format uptime ──────────────────────────────────────────────────────

  function fmtUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // ─── Derive states ──────────────────────────────────────────────────────

  const visionState  = !camOnline ? 'offline'
    : isAnalysing    ? 'active'
    : 'online';

  const agentState   = 'online'; // always online while app is running

  const autoState    = backendError  ? 'error'
    : backendOnline  ? 'online'
    : 'warn';

  const voiceState   = voiceActive   ? 'active' : 'offline';

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={S.root}>

      {/* ── Logo ── */}
      <div style={S.logo}>
        <div style={S.logoDot} />
        <span style={S.logoText}>CORTEXA</span>
        <span style={S.logoVersion}>v1.0</span>
      </div>

      <Sep />

      {/* ── Status pills ── */}
      <div style={S.pills}>
        <StatusPill
          label="Vision"
          state={visionState}
          tooltip={
            !camOnline    ? 'No camera detected'
            : isAnalysing ? 'Vision API — analysing frame'
            :               'Camera online — polling active'
          }
          pulse={isAnalysing}
        />
        <StatusPill
          label="Agent"
          state={agentState}
          tooltip="Claude agent connected"
          pulse={false}
        />
        <StatusPill
          label="Automation"
          state={autoState}
          tooltip={
            backendError  ? `Backend error: ${backendError}`
            : backendOnline ? 'FastAPI backend online'
            :                 'Backend starting...'
          }
          pulse={autoState === 'warn'}
        />
        <StatusPill
          label="Voice"
          state={voiceState}
          tooltip={voiceActive ? 'Microphone active — listening' : 'Voice inactive'}
          pulse={voiceActive}
        />
      </div>

      {/* ── Right side — stats + clock ── */}
      <div style={S.right}>

        {/* Object count */}
        <div style={S.stat} title="Objects detected in last vision pass">
          <span style={S.statVal}>{detectedCount}</span>
          <span style={S.statLabel}>obj</span>
        </div>

        <div style={S.miniSep} />

        {/* Memory turns */}
        <div style={S.stat} title="Conversation turns in agent memory">
          <span style={S.statVal}>{memoryTurns}</span>
          <span style={S.statLabel}>turns</span>
        </div>

        <div style={S.miniSep} />

        {/* Uptime */}
        <div style={S.stat} title="Session uptime">
          <span style={S.statVal}>{fmtUptime(uptime)}</span>
          <span style={S.statLabel}>up</span>
        </div>

        <Sep />

        {/* Date + Clock */}
        <div style={S.clock}>
          <span style={S.clockDate}>{date}</span>
          <span style={S.clockTime}>{time}</span>
        </div>

      </div>

      {/* Global keyframe animation */}
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.45; transform: scale(0.75); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  root: {
    height: 42,
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    borderBottom: '1px solid #1e2333',
    background: '#0a0c12',
    flexShrink: 0,
    gap: 0,
    // macOS traffic lights live in top-left — add padding so logo clears them
    paddingLeft: window.cortexa?.env?.platform === 'darwin' ? 76 : 14,
    WebkitAppRegion: 'drag',    // makes the bar draggable as a title bar on macOS
  },
  logo: {
    display: 'flex', alignItems: 'center', gap: 7,
    WebkitAppRegion: 'no-drag', // interactive elements must opt out of drag
  },
  logoDot: {
    width: 6, height: 6, borderRadius: '50%',
    background: '#3ecfb2', boxShadow: '0 0 7px #3ecfb2',
    animation: 'breathe 2.5s ease-in-out infinite',
    flexShrink: 0,
  },
  logoText: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 12, fontWeight: 500,
    color: '#eef0f5', letterSpacing: '0.2em',
  },
  logoVersion: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 8, color: '#3d4259',
    letterSpacing: '0.1em', marginTop: 1,
  },

  sep: {
    width: 1, height: 20,
    background: '#1e2333',
    margin: '0 12px', flexShrink: 0,
  },
  miniSep: {
    width: 1, height: 12,
    background: '#1e2333',
    margin: '0 8px', flexShrink: 0,
  },

  pills: {
    display: 'flex', alignItems: 'center', gap: 2,
    WebkitAppRegion: 'no-drag',
  },
  pill: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '3px 8px', borderRadius: 4,
    border: '1px solid transparent',
    transition: 'all 0.2s',
  },
  pillDot: {
    width: 4, height: 4, borderRadius: '50%', flexShrink: 0,
  },
  pillLabel: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 9.5, letterSpacing: '0.06em',
  },

  right: {
    marginLeft: 'auto',
    display: 'flex', alignItems: 'center',
    WebkitAppRegion: 'no-drag',
  },
  stat: {
    display: 'flex', alignItems: 'baseline', gap: 3,
    cursor: 'default',
  },
  statVal: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 11, color: '#7a8099',
  },
  statLabel: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 7.5, color: '#3d4259',
  },

  clock: {
    display: 'flex', alignItems: 'baseline', gap: 6,
  },
  clockDate: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 9, color: '#3d4259',
    letterSpacing: '0.06em',
  },
  clockTime: {
    fontFamily: "'Syne Mono', monospace",
    fontSize: 11, color: '#7a8099',
    letterSpacing: '0.08em',
  },
};