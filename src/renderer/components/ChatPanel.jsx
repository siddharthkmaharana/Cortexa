import React, {
    useState, useEffect, useRef, useCallback, useLayoutEffect,
  } from 'react';
  import VoiceButton from './VoiceButton';
  import { CONFIG } from '../config';
  import { fetchAgentResponse } from '../utils/llmService';
import { buildScanPrompt } from '../utils/barcodeScanner';
  
  // ─── Command detection ────────────────────────────────────────────────────────
  
  const COMMAND_PATTERNS = [
    /\b(open|launch|start)\b.+/i,
    /\b(close|quit|kill)\b.+/i,
    /\b(dark|light)\s+mode\b/i,
    /\bvolume\b.*(to|at|up|down|\d+)/i,
    /\b(search|google|find)\b.+/i,
    /\b(create|make|new)\s+(folder|file|directory)\b/i,
    /\b(move|rename|delete)\b.+/i,
    /\b(brightness|wifi|bluetooth|airplane)\b/i,
    /\bswitch\s+(to|between)\b/i,
    /\b(screenshot|screen\s+shot)\b/i,
  ];
  
  function isCommand(text) {
    return COMMAND_PATTERNS.some(rx => rx.test(text));
  }
  
  // ─── System prompt builder ────────────────────────────────────────────────────
  
  function buildSystemPrompt({ sceneDescription, detectedObjects, backendOnline, frozenFrame }) {
    const objList = detectedObjects.map(o => o.label).join(', ') || 'none detected';
    const frameState = frozenFrame ? 'a frozen frame is locked for deep analysis' : 'live camera feed';
  
    return `You are CORTEXA — Cognitive Oriented Real-Time Execution Assistant. You are embedded in a split-panel desktop application. The left panel shows a live camera feed that you have continuous vision access to.
  
  CAMERA CONTEXT (${frameState}):
  Scene: ${sceneDescription || 'Analysing environment...'}
  Detected objects: ${objList}
  
  CAPABILITIES:
  - Vision: you can see and analyse the camera feed in real time
  - Commands: when the user gives a laptop command, acknowledge it and list the exact automation steps you will execute via the local FastAPI backend (app control, system settings, browser automation, file management)
  - Products: when a product is shown, offer to fetch specs, pricing, and reviews
  - Voice: the user may be speaking — respond naturally
  
  RESPONSE RULES:
  - Answer questions directly and concisely (2–4 sentences unless detail is requested)
  - For commands: confirm what you will do in a short, natural sentence (e.g. "I'll create that folder for you."), then append a JSON block inside a \`\`\`command codeblock. Do not mention the backend, FastAPI, APIs, or JSON in your response.
  
  COMMAND FORMATS:
  App:
  \`\`\`command
  { "type": "app", "action": "open|close", "target": "appName" }
  \`\`\`
  System:
  \`\`\`command
  { "type": "system", "setting": "dark_mode|volume|brightness|wifi|bluetooth|lock_screen|sleep_display|notification|info", "value": <value> }
  \`\`\`
  Browser:
  \`\`\`command
  { "type": "browser", "action": "navigate|search|click|fill|get_content|new_tab|close_tab", "url": "https...", "query": "...", "selector": "...", "value": "..." }
  \`\`\`
  Files:
  \`\`\`command
  { "type": "files", "action": "create_folder|rename|move|copy|delete|open|reveal|write|list", "path": "~/Desktop/folderName", "new_name": "...", "destination": "...", "content": "..." }
  \`\`\`

  - Automation backend is ${backendOnline ? 'ONLINE' : 'OFFLINE — warn the user automation is unavailable'}
  - Use a confident, precise, technical tone
  - Never say you cannot see the camera — you always have vision context`;
  }
  
  // ─── Message types ────────────────────────────────────────────────────────────
  
  let msgId = 0;
  function makeMsg(role, text, meta = {}) {
    return { id: ++msgId, role, text, ts: Date.now(), ...meta };
  }
  
  
  // ─── Parse and dispatch embedded command ──────────────────────────────────────
  
  async function dispatchCommand(replyText) {
    const match = replyText.match(/```command\s*([\s\S]+?)\s*```/);
    if (!match) return null;
  
    try {
      const cmd = JSON.parse(match[1]);
      let payload = { ...cmd };

      if (cmd.type === 'app') {
        if (payload.action === 'launch') payload.action = 'open';
      } else if (cmd.type === 'system') {
        if (!payload.setting) payload.setting = cmd.action;
        if (payload.value === undefined || payload.value === "") payload.value = cmd.target;
      } else if (cmd.type === 'files') {
        if (!payload.path && cmd.target) payload.path = cmd.target;
        if (!payload.content && cmd.value) payload.content = cmd.value;
      } else if (cmd.type === 'browser') {
        if (cmd.action === 'navigate' || cmd.action === 'new_tab') {
          if (!payload.url) payload.url = cmd.target || cmd.value;
        } else if (cmd.action === 'search') {
          if (!payload.query) payload.query = cmd.target || cmd.value;
        } else {
          if (!payload.selector) payload.selector = cmd.target;
        }
      }

      const endpoint = `/automate/${cmd.type}`;
      const result = await window.cortexa.automate(endpoint, payload);
      return result.ok ? 'executed' : `failed: ${result.error}`;
    } catch (err) {
      console.warn('[command dispatch]', err.message);
      return null;
    }
  }
  
  // ─── Quick chips ──────────────────────────────────────────────────────────────
  
  const QUICK_CHIPS = [
    { label: 'What do you see?',      text: 'What do you see in the camera right now?' },
    { label: 'Describe scene',        text: 'Describe the scene in full detail.' },
    { label: 'Open VS Code',          text: 'Open VS Code and load my last project.' },
    { label: 'Search product',        text: 'Search Amazon for this product.' },
    { label: 'Dark mode',             text: 'Switch the system to dark mode.' },
    { label: 'Mood check',            text: 'What expression am I showing?' },
    { label: 'Screenshot',            text: 'Take a screenshot of my screen.' },
    { label: 'Summarise camera',      text: 'Give me a bullet-point summary of everything visible.' },
  ];
  
  // ─── Component ────────────────────────────────────────────────────────────────
  
  export default function ChatPanel({
    sceneDescription,
    detectedObjects,
    frozenFrame,
    backendOnline,
    voiceActive,
    onVoiceToggle,
    llmProvider,
    llmApiKey,
    scannedBarcode,
  }) {
    const [messages,  setMessages]  = useState([
      makeMsg('system', '◆ CORTEXA online — vision + agent connected'),
      makeMsg('agent',  'I\'m watching through the camera and ready to help. Ask me anything about what\'s in frame, or give a command — "open VS Code", "search this product", "switch dark mode".'),
    ]);
    const [input,     setInput]     = useState('');
    const [thinking,  setThinking]  = useState(false);
    const [apiError,  setApiError]  = useState(null);
    const [autoLog,   setAutoLog]   = useState([]); // automation dispatch log
  
    const historyRef   = useRef([]);   // rolling Claude conversation history
    const messagesRef  = useRef(null); // scroll container
    const inputRef     = useRef(null);
    const thinkingRef  = useRef(false);
  
    // ─── API key validation status ──────────────────────────────────────────────
  
    useEffect(() => {
      if (llmApiKey) {
        setApiError(null);
      } else {
        setApiError('No API key found — open Settings (⚙) to configure your provider.');
      }
    }, [llmApiKey]);
  
    // ─── Auto-scroll to bottom on new messages ─────────────────────────────────
  
    useLayoutEffect(() => {
      if (messagesRef.current) {
        messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }
    }, [messages, thinking]);
  
    // ─── Trim history to max turns ────────────────────────────────────────────
  
    function trimHistory() {
      const max = CONFIG.agent.maxHistoryTurns * 2; // each turn = user + assistant
      if (historyRef.current.length > max) {
        historyRef.current = historyRef.current.slice(-max);
      }
    }
  
    // ─── Core send ────────────────────────────────────────────────────────────
  
    const sendMessage = useCallback(async (text) => {
      const trimmed = text.trim();
      if (!trimmed || thinkingRef.current) return;
  
      if (!llmApiKey) {
        setApiError('Configure your API key in Settings (⚙) first.');
        return;
      }
  
      setApiError(null);
      thinkingRef.current = true;
      setThinking(true);
  
      // Append user message
      setMessages(prev => {
        const next = [...prev, makeMsg('user', trimmed)];
        return next.slice(-CONFIG.ui.maxRenderedMessages);
      });
  
      // Push into rolling history
      let userContent = trimmed;
      if (frozenFrame) {
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frozenFrame } },
          { type: 'text', text: trimmed }
        ];
      }
      historyRef.current.push({ role: 'user', content: userContent });
      trimHistory();
  
      const systemPrompt = buildSystemPrompt({
        sceneDescription,
        detectedObjects,
        backendOnline,
        frozenFrame,
      });
  
      try {
        const reply = await fetchAgentResponse(llmProvider, llmApiKey, historyRef.current, systemPrompt, null);
  
        // Push assistant turn into history (strip embedded command blocks)
        const cleanReply = reply.replace(/```command[\s\S]*?```/g, '').trim();
        historyRef.current.push({ role: 'assistant', content: cleanReply });
        trimHistory();
  
        setMessages(prev => [
          ...prev,
          makeMsg('agent', reply),
        ].slice(-CONFIG.ui.maxRenderedMessages));
  
        // Dispatch automation command if present
        if (isCommand(trimmed) || /```command/.test(reply)) {
          const status = await dispatchCommand(reply);
          if (status) {
            const logEntry = `${trimmed.slice(0, 40)}… → ${status}`;
            setAutoLog(prev => [logEntry, ...prev].slice(0, 10));
            setMessages(prev => [
              ...prev,
              makeMsg('system', `⚙ Automation ${status === 'executed' ? 'executed' : `failed — ${status}`}`),
            ]);
          }
        }
      } catch (err) {
        console.error('[agent]', err.message);
        setApiError(err.message);
        setMessages(prev => [
          ...prev,
          makeMsg('system', `⚠ ${err.message}`),
        ]);
        // Remove the failed user turn from history
        historyRef.current.pop();
      } finally {
        thinkingRef.current = false;
        setThinking(false);
      }
    }, [llmApiKey, llmProvider, sceneDescription, detectedObjects, backendOnline, frozenFrame]);
  
    // ─── Barcode scan submission ──────────────────────────────────────────────
    const lastBarcodeTs = useRef(0);
    useEffect(() => {
      if (scannedBarcode && scannedBarcode.ts !== lastBarcodeTs.current) {
        lastBarcodeTs.current = scannedBarcode.ts;
        const prompt = buildScanPrompt(scannedBarcode);
        sendMessage(prompt);
      }
    }, [scannedBarcode, sendMessage]);
  
    // ─── Input handlers ───────────────────────────────────────────────────────
  
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input);
        setInput('');
      }
    };
  
    const handleSend = () => {
      sendMessage(input);
      setInput('');
    };
  
    const handleChip = (text) => {
      setInput('');
      sendMessage(text);
      inputRef.current?.focus();
    };
  
    // ─── Voice transcript callback ────────────────────────────────────────────
  
    const handleTranscript = useCallback((transcript, isFinal) => {
      setInput(transcript);
      if (isFinal && transcript.trim()) {
        sendMessage(transcript);
        setInput('');
      }
    }, [sendMessage]);
  
    // ─── Clear ────────────────────────────────────────────────────────────────
  
    const handleClear = () => {
      historyRef.current = [];
      setMessages([makeMsg('system', '◆ Session cleared — new conversation started')]);
      setAutoLog([]);
    };
  
    // ─── Format timestamp ─────────────────────────────────────────────────────
  
    function fmtTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit',
      });
    }
  
    // ─── Render ───────────────────────────────────────────────────────────────
  
    return (
      <div style={S.root}>
  
        {/* ── Header ── */}
        <div style={S.header}>
          <div style={S.agentBadge}>
            <div style={S.agentIcon}>CX</div>
            <div>
              <div style={S.agentName}>CORTEXA</div>
              <div style={S.agentSub}>context-aware agent</div>
            </div>
          </div>
          <div style={S.headerRight}>
            {thinking && <div style={S.thinkingPill}>◌ thinking</div>}
            <button style={S.clearBtn} onClick={handleClear}>CLEAR</button>
          </div>
        </div>
  
        {/* ── API error banner ── */}
        {apiError && (
          <div style={S.apiBanner}>
            <span>⚠ {apiError}</span>
            <button style={S.bannerDismiss} onClick={() => setApiError(null)}>✕</button>
          </div>
        )}
  
        {/* ── Message list ── */}
        <div style={S.messages} ref={messagesRef}>
          {messages.map(msg => (
            <MessageRow key={msg.id} msg={msg} fmtTime={fmtTime} />
          ))}
  
          {/* Typing indicator */}
          {thinking && (
            <div style={{ ...S.msgRow, ...S.msgAgent }}>
              <div style={S.avatar}>CX</div>
              <div style={S.msgInner}>
                <div style={S.msgMeta}>
                  <span style={S.sender}>CORTEXA</span>
                </div>
                <div style={{ ...S.bubble, ...S.bubbleAgent }}>
                  <TypingDots />
                </div>
              </div>
            </div>
          )}
        </div>
  
        {/* ── Input area ── */}
        <div style={S.inputArea}>
  
          {/* Quick chips */}
          <div style={S.chips}>
            {QUICK_CHIPS.map(chip => (
              <button
                key={chip.label}
                style={S.chip}
                onClick={() => handleChip(chip.text)}
                disabled={thinking}
              >
                {chip.label}
              </button>
            ))}
          </div>
  
          {/* Input row */}
          <div style={S.inputRow}>
            <VoiceButton
              active={voiceActive}
              onToggle={onVoiceToggle}
              onTranscript={handleTranscript}
            />
            <textarea
              ref={inputRef}
              style={S.textarea}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message or command..."
              rows={1}
              disabled={thinking}
            />
            <button
              style={{ ...S.sendBtn, opacity: (!input.trim() || thinking) ? 0.35 : 1 }}
              onClick={handleSend}
              disabled={!input.trim() || thinking}
            >
              SEND
            </button>
          </div>
  
          {/* Context strip */}
          <div style={S.contextStrip}>
            <span style={S.ctxItem}>
              <span style={{ ...S.ctxDot, background: backendOnline ? '#3ecfb2' : '#e84040' }} />
              automation {backendOnline ? 'online' : 'offline'}
            </span>
            <span style={S.ctxItem}>
              <span style={{ ...S.ctxDot, background: '#3ecfb2' }} />
              {detectedObjects.length} object{detectedObjects.length !== 1 ? 's' : ''} in frame
            </span>
            {frozenFrame && (
              <span style={{ ...S.ctxItem, color: '#e8a628' }}>
                <span style={{ ...S.ctxDot, background: '#e8a628' }} />
                frozen frame active
              </span>
            )}
            <span style={S.ctxItem}>
              {historyRef.current.length / 2 | 0} turns in memory
            </span>
          </div>
  
        </div>
      </div>
    );
  }
  
  // ─── MessageRow sub-component ─────────────────────────────────────────────────
  
  function MessageRow({ msg, fmtTime }) {
    // Strip embedded command JSON blocks from rendered text
    const displayText = msg.text.replace(/```command[\s\S]*?```/g, '').trim();
  
    if (msg.role === 'system') {
      return (
        <div style={S.sysRow}>
          <div style={S.sysBubble}>{displayText}</div>
        </div>
      );
    }
  
    const isUser = msg.role === 'user';
  
    return (
      <div style={{ ...S.msgRow, ...(isUser ? S.msgUser : S.msgAgent) }}>
        <div style={{ ...S.avatar, ...(isUser ? S.avatarUser : {}) }}>
          {isUser ? 'YOU' : 'CX'}
        </div>
        <div style={{ ...S.msgInner, ...(isUser ? S.msgInnerUser : {}) }}>
          <div style={{ ...S.msgMeta, ...(isUser ? S.msgMetaUser : {}) }}>
            <span style={S.sender}>{isUser ? 'YOU' : 'CORTEXA'}</span>
            <span style={S.ts}>{fmtTime(msg.ts)}</span>
          </div>
          <div style={{ ...S.bubble, ...(isUser ? S.bubbleUser : S.bubbleAgent) }}>
            {formatText(displayText)}
          </div>
        </div>
      </div>
    );
  }
  
  // ─── Minimal markdown-like text formatter ─────────────────────────────────────
  
  function formatText(text) {
    // Split into lines, render bullet points and bold text
    return text.split('\n').map((line, i) => {
      if (!line.trim()) return <br key={i} />;
  
      // Bullet point
      const isBullet = /^[-•*]\s/.test(line);
      const content = line.replace(/^[-•*]\s/, '');
  
      // Bold: **text**
      const parts = content.split(/\*\*(.*?)\*\*/g).map((part, j) =>
        j % 2 === 1 ? <strong key={j}>{part}</strong> : part
      );
  
      return (
        <div key={i} style={isBullet ? { paddingLeft: 12, position: 'relative' } : {}}>
          {isBullet && <span style={{ position: 'absolute', left: 0, color: '#3ecfb2' }}>·</span>}
          {parts}
        </div>
      );
    });
  }
  
  // ─── Typing dots sub-component ────────────────────────────────────────────────
  
  function TypingDots() {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {[0, 1, 2].map(i => (
          <div
            key={i}
            style={{
              width: 5, height: 5, borderRadius: '50%',
              background: '#3d4259',
              animation: `tdot 1.4s ${i * 0.2}s infinite`,
            }}
          />
        ))}
        <span style={{ fontFamily: "'Syne Mono', monospace", fontSize: 9, color: '#3d4259', marginLeft: 4 }}>
          processing
        </span>
        <style>{`
          @keyframes tdot {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.3; }
            30% { transform: translateY(-5px); opacity: 1; }
          }
        `}</style>
      </div>
    );
  }
  
  // ─── Styles ───────────────────────────────────────────────────────────────────
  
  const S = {
    root: {
      display: 'flex', flexDirection: 'column',
      height: '100%', background: '#080a0f', overflow: 'hidden',
    },
  
    // Header
    header: {
      height: 48, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 14px', borderBottom: '1px solid #1e2333', background: '#0e1118',
    },
    agentBadge: { display: 'flex', alignItems: 'center', gap: 8 },
    agentIcon: {
      width: 28, height: 28, borderRadius: 6,
      background: 'linear-gradient(135deg, #3ecfb2, #1a9e85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Syne Mono', monospace", fontSize: 9, fontWeight: 'bold', color: '#fff',
    },
    agentName: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 11, color: '#eef0f5', letterSpacing: '0.12em',
    },
    agentSub: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 8, color: '#3d4259', letterSpacing: '0.08em',
    },
    headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
    thinkingPill: {
      fontFamily: "'Syne Mono', monospace", fontSize: 9,
      color: '#3ecfb2', padding: '3px 8px',
      border: '1px solid #3ecfb233', borderRadius: 4,
      background: '#3ecfb20e', animation: 'pulse 1.5s infinite',
    },
    clearBtn: {
      fontFamily: "'Syne Mono', monospace", fontSize: 9,
      padding: '4px 9px', borderRadius: 4,
      border: '1px solid #2a2f42', background: 'transparent',
      color: '#3d4259', cursor: 'pointer', letterSpacing: '0.08em',
      transition: 'all 0.15s',
    },
  
    // API error banner
    apiBanner: {
      padding: '7px 14px', background: '#1a0e0e',
      borderBottom: '1px solid #e8404033',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontFamily: "'Syne Mono', monospace", fontSize: 10, color: '#e84040',
      flexShrink: 0,
    },
    bannerDismiss: {
      background: 'none', border: 'none', color: '#e8404066',
      cursor: 'pointer', fontSize: 13, padding: '0 2px',
    },
  
    // Message list
    messages: {
      flex: 1, overflowY: 'auto', padding: '14px 12px',
      display: 'flex', flexDirection: 'column', gap: 14,
      scrollBehavior: 'smooth',
    },
  
    // System message
    sysRow: { display: 'flex', justifyContent: 'center' },
    sysBubble: {
      fontFamily: "'Syne Mono', monospace", fontSize: 9.5,
      color: '#3d4259', padding: '4px 10px',
      border: '1px solid #1e2333', borderRadius: 3,
      background: '#0e1118', letterSpacing: '0.04em',
    },
  
    // Regular messages
    msgRow: { display: 'flex', gap: 8 },
    msgAgent: { flexDirection: 'row' },
    msgUser:  { flexDirection: 'row-reverse' },
  
    avatar: {
      width: 26, height: 26, borderRadius: 5, flexShrink: 0,
      background: 'linear-gradient(135deg, #3ecfb2, #1a9e85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Syne Mono', monospace", fontSize: 7, color: '#fff',
      marginTop: 2,
    },
    avatarUser: {
      background: 'linear-gradient(135deg, #e8a628, #b07d18)',
    },
  
    msgInner: {
      display: 'flex', flexDirection: 'column', gap: 3,
      maxWidth: '88%',
    },
    msgInnerUser: { alignItems: 'flex-end' },
  
    msgMeta: { display: 'flex', alignItems: 'center', gap: 6 },
    msgMetaUser: { flexDirection: 'row-reverse' },
  
    sender: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 8.5, color: '#3d4259', letterSpacing: '0.06em',
    },
    ts: {
      fontFamily: "'Syne Mono', monospace",
      fontSize: 7.5, color: '#2a2f42',
    },
  
    bubble: {
      padding: '9px 12px', borderRadius: 7,
      fontSize: 12.5, lineHeight: 1.6,
      border: '1px solid',
    },
    bubbleAgent: {
      background: '#0e1118', borderColor: '#1e2333',
      color: '#c8ccd8',
    },
    bubbleUser: {
      background: '#0d1e30', borderColor: '#1e3550',
      color: '#a8c8f0',
    },
  
    // Input area
    inputArea: {
      flexShrink: 0, padding: '10px 12px',
      borderTop: '1px solid #1e2333', background: '#0e1118',
    },
    chips: {
      display: 'flex', gap: 5, marginBottom: 8,
      overflowX: 'auto', paddingBottom: 2,
      scrollbarWidth: 'none',
    },
    chip: {
      fontFamily: "'Syne Mono', monospace", fontSize: 9.5,
      padding: '4px 9px', borderRadius: 4,
      border: '1px solid #2a2f42', background: 'transparent',
      color: '#7a8099', cursor: 'pointer', whiteSpace: 'nowrap',
      transition: 'all 0.15s',
      flexShrink: 0,
    },
    inputRow: { display: 'flex', gap: 6, alignItems: 'flex-end' },
    textarea: {
      flex: 1, background: '#080a0f',
      border: '1px solid #2a2f42', borderRadius: 7,
      padding: '9px 12px', fontSize: 13,
      fontFamily: "'Outfit', sans-serif",
      color: '#eef0f5', outline: 'none', resize: 'none',
      lineHeight: 1.4, minHeight: 36, maxHeight: 120,
      transition: 'border-color 0.15s',
    },
    sendBtn: {
      height: 36, padding: '0 14px', borderRadius: 7,
      border: '1px solid #3ecfb255',
      background: '#3ecfb218', color: '#3ecfb2',
      cursor: 'pointer', fontFamily: "'Syne Mono', monospace",
      fontSize: 10, letterSpacing: '0.08em',
      transition: 'all 0.15s', flexShrink: 0,
    },
  
    // Context strip
    contextStrip: {
      display: 'flex', gap: 12, marginTop: 6,
      flexWrap: 'wrap',
    },
    ctxItem: {
      fontFamily: "'Syne Mono', monospace", fontSize: 8.5,
      color: '#3d4259', display: 'flex', alignItems: 'center', gap: 4,
    },
    ctxDot: {
      width: 4, height: 4, borderRadius: '50%', display: 'inline-block',
    },
  };