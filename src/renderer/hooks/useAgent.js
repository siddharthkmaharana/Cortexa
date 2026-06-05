import { useState, useRef, useCallback, useEffect } from 'react';
import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Unique incrementing ID for each message */
let _msgId = 0;
const nextId = () => ++_msgId;

/** Roles */
const ROLE = { USER: 'user', AGENT: 'agent', SYSTEM: 'system' };

/** Max chars of text-in-frame to inject into system prompt (keeps tokens down) */
const MAX_TEXT_INJECT = 300;

/** Retry limits */
const MAX_RETRIES    = 2;
const RETRY_DELAY_MS = 1_500;

// ─── Command routing patterns ─────────────────────────────────────────────────

const COMMAND_PATTERNS = [
  { rx: /\b(open|launch|start)\s+(.+)/i,              type: 'app',    action: 'open'           },
  { rx: /\b(close|quit|kill|exit)\s+(.+)/i,           type: 'app',    action: 'close'          },
  { rx: /\bswitch\s+to\s+(.+)/i,                      type: 'app',    action: 'switch'         },
  { rx: /\bdark\s+mode\b/i,                            type: 'system', action: 'dark_mode',     value: true  },
  { rx: /\blight\s+mode\b/i,                           type: 'system', action: 'dark_mode',     value: false },
  { rx: /\bvolume\s+(?:to\s+)?(\d+)/i,                type: 'system', action: 'volume'         },
  { rx: /\bbrightness\s+(?:to\s+)?(\d+)/i,            type: 'system', action: 'brightness'     },
  { rx: /\bwifi\s+(on|off)\b/i,                        type: 'system', action: 'wifi'           },
  { rx: /\bbluetooth\s+(on|off)\b/i,                   type: 'system', action: 'bluetooth'      },
  { rx: /\b(search|google)\s+(?:for\s+)?(.+)/i,       type: 'browser', action: 'search'        },
  { rx: /\b(?:go to|navigate to|open)\s+(https?:\/\/.+)/i, type: 'browser', action: 'navigate' },
  { rx: /\bcreate\s+(?:a\s+)?folder\s+(.+)/i,         type: 'files',  action: 'create_folder'  },
  { rx: /\brename\s+(.+)\s+to\s+(.+)/i,               type: 'files',  action: 'rename'         },
  { rx: /\b(?:take a?\s*)?screenshot\b/i,              type: 'system', action: 'screenshot'     },
  { rx: /\bmute\b/i,                                   type: 'system', action: 'volume',        value: 0     },
];

/**
 * Tests a message against command patterns.
 * Returns { isCommand: true, type, action, value? } or { isCommand: false }.
 */
function classifyMessage(text) {
  for (const { rx, type, action, value } of COMMAND_PATTERNS) {
    const m = text.match(rx);
    if (m) return { isCommand: true, type, action, rawMatch: m, value };
  }
  return { isCommand: false };
}

// ─── System prompt builder ────────────────────────────────────────────────────

/**
 * Constructs the per-request system prompt by injecting the latest
 * vision context. Called fresh on every send so context is always current.
 */
function buildSystemPrompt({
  description, environment, objects, textInFrame,
  mood, productVisible, backendOnline, platform,
}) {
  const objList = objects.length
    ? objects.map(o => `${o.label} (${Math.round(o.confidence * 100)}%)`).join(', ')
    : 'none detected';

  const textSnippet = textInFrame
    ? `\nVisible text in frame: "${textInFrame.slice(0, MAX_TEXT_INJECT)}${textInFrame.length > MAX_TEXT_INJECT ? '…' : ''}"`
    : '';

  const moodLine = mood && mood !== 'null'
    ? `\nUser appears: ${mood} — adjust tone accordingly.`
    : '';

  const productLine = productVisible
    ? '\nA product is visible — offer to search for specs, pricing, or reviews.'
    : '';

  const automationNote = backendOnline
    ? `Automation backend is ONLINE. For commands, output a JSON block after your reply:
\`\`\`command
// App: { "type": "app", "action": "open|close", "target": "appName" }
// System: { "type": "system", "setting": "dark_mode|volume|brightness|wifi|bluetooth|lock_screen|sleep_display|notification|info", "value": <value> }
// Browser: { "type": "browser", "action": "navigate|search|click|fill|get_content|new_tab|close_tab", "url": "https...", "query": "...", "selector": "...", "value": "..." }
// Files: { "type": "files", "action": "create_folder|rename|move|copy|delete|open|reveal|write|list", "path": "~/Desktop/folderName", "new_name": "...", "destination": "...", "content": "..." }
\`\`\``
    : 'Automation backend is OFFLINE — inform the user if they ask for a command.';

  return `You are CORTEXA — Cognitive Oriented Real-Time Execution Assistant.
You are embedded in a split-panel desktop app on ${platform}. The left panel shows a live camera feed you have continuous vision access to.

━━ CURRENT CAMERA CONTEXT ━━
Scene: ${description || 'Analysing...'}
Environment: ${environment}
Detected objects: ${objList}${textSnippet}${moodLine}${productLine}

━━ CAPABILITIES ━━
• Vision: real-time camera analysis every few seconds
• Commands: app control, system settings, browser automation, file management
• Products: identify items, fetch specs and pricing
• Voice: user may be speaking — respond naturally and concisely

━━ RESPONSE FORMAT ━━
• Questions → answer directly in 2–4 sentences
• Explanations → use bullet points for steps, keep it tight
• Commands → confirm the action in a short, natural sentence (e.g. "I'll create that folder for you."), then append the command block. Do not mention the backend, FastAPI, APIs, or JSON in your response.
• Never describe what you cannot do — always offer an alternative
• Never repeat "I am an AI" or disclaim your limitations unprompted

━━ AUTOMATION ━━
${automationNote}`;
}

import { fetchAgentResponse, streamAgentResponse } from '../utils/llmService';

// ─── Command dispatcher ───────────────────────────────────────────────────────

/**
 * Parses the embedded ```command``` block from an agent reply and
 * dispatches it to the FastAPI backend via window.cortexa.automate().
 *
 * @returns {{ dispatched: boolean, status: 'executed'|'failed'|'skipped', error?: string }}
 */
async function dispatchEmbeddedCommand(replyText) {
  const match = replyText.match(/```command\s*([\s\S]+?)\s*```/);
  if (!match) return { dispatched: false, status: 'skipped' };

  let cmd;
  try {
    cmd = JSON.parse(match[1]);
  } catch (_) {
    return { dispatched: true, status: 'failed', error: 'Malformed command JSON' };
  }

  let payload = { ...cmd };
  // Fallback mapping in case the LLM still uses the old generic target/value format
  if (cmd.type === 'system') {
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
  try {
    const result = await window.cortexa.automate(endpoint, payload);
    return result.ok
      ? { dispatched: true, status: 'executed', cmd }
      : { dispatched: true, status: 'failed', error: result.error };
  } catch (err) {
    return { dispatched: true, status: 'failed', error: err.message };
  }
}

// ─── Message factory ──────────────────────────────────────────────────────────

function makeMsg(role, text, meta = {}) {
  return { id: nextId(), role, text, ts: Date.now(), ...meta };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useAgent
 *
 * The central brain of CORTEXA. Manages:
 *   - Conversation message list (displayed in ChatPanel)
 *   - Rolling Claude API history (sent with each request)
 *   - System prompt injection with live vision context
 *   - Streaming response rendering
 *   - Command classification and backend dispatch
 *   - Retry with exponential backoff
 *   - Request cancellation
 *   - Token usage tracking
 *
 * @param {string}    params.llmProvider
 * @param {string}    params.llmApiKey
 * @param {string}    params.description       from useVision
 * @param {string}    params.environment       from useVision
 * @param {object[]}  params.objects           from useVision
 * @param {string}    params.textInFrame       from useVision
 * @param {string}    params.mood              from useVision
 * @param {boolean}   params.productVisible    from useVision
 * @param {string}    params.frozenFrame       base64 JPEG | null
 * @param {boolean}   params.backendOnline
 * @param {Function}  [params.onAgentReply]    (text: string) => void — for TTS hook-in
 *
 * @returns {{
 *   messages:       object[],
 *   isThinking:     boolean,
 *   isStreaming:     boolean,
 *   error:          string | null,
 *   tokenUsage:     { input: number, output: number },
 *   historyLength:  number,
 *   send:           (text: string) => Promise<void>,
 *   sendWithImage:  (text: string, base64Jpeg: string) => Promise<void>,
 *   cancel:         () => void,
 *   clearSession:   () => void,
 *   injectSystem:   (text: string) => void,
 * }}
 */
export function useAgent({
  llmProvider,
  llmApiKey,
  description    = '',
  environment    = 'unknown',
  objects        = [],
  textInFrame    = null,
  mood           = null,
  productVisible = false,
  frozenFrame    = null,
  backendOnline  = false,
  onAgentReply,
}) {
  const [messages,      setMessages]      = useState(() => [
    makeMsg(ROLE.SYSTEM, '◆ CORTEXA online — vision + agent connected'),
    makeMsg(ROLE.AGENT,  'I\'m watching through the camera and ready to help. Ask me anything about what\'s in frame, or give me a command — "open VS Code", "search this product", "switch dark mode".'),
  ]);
  const [isThinking,    setIsThinking]    = useState(false);
  const [isStreaming,   setIsStreaming]   = useState(false);
  const [error,         setError]         = useState(null);
  const [tokenUsage,    setTokenUsage]    = useState({ input: 0, output: 0 });

  // Internal refs — don't trigger re-renders
  const historyRef    = useRef([]);   // [{role:'user'|'assistant', content:string}]
  const abortCtrlRef  = useRef(null);
  const mountedRef    = useRef(true);
  const streamBufRef  = useRef('');   // accumulates streamed chars for the live bubble

  const platform = window.cortexa?.env?.platform ?? 'unknown';

  // ─── Cleanup ───────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortCtrlRef.current?.abort();
    };
  }, []);

  // ─── Trim rolling history ──────────────────────────────────────────────

  function trimHistory() {
    const max = CONFIG.agent.maxHistoryTurns * 2;
    if (historyRef.current.length > max) {
      // Always keep the first message (establishes context) + most recent turns
      historyRef.current = historyRef.current.slice(-max);
    }
    
    // Strip base64 images from older turns to prevent token explosion
    for (let i = 0; i < historyRef.current.length - 1; i++) {
      const msg = historyRef.current[i];
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map(block => 
          block.type === 'image' 
            ? { type: 'text', text: '[Previous image removed to save context]' } 
            : block
        );
      }
    }
  }

  // ─── Append a message to the visible list ─────────────────────────────

  const addMsg = useCallback((role, text, meta = {}) => {
    const msg = makeMsg(role, text, meta);
    setMessages(prev =>
      [...prev, msg].slice(-CONFIG.ui.maxRenderedMessages)
    );
    return msg.id;
  }, []);

  // ─── Update the last agent bubble in-place (for streaming) ────────────

  const updateLastAgentMsg = useCallback((text) => {
    setMessages(prev => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === ROLE.AGENT && copy[i].streaming) {
          copy[i] = { ...copy[i], text };
          return copy;
        }
      }
      return copy;
    });
  }, []);

  // ─── Finalise the streaming bubble (mark it done) ─────────────────────

  const finaliseStreamingMsg = useCallback((text) => {
    setMessages(prev => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === ROLE.AGENT && copy[i].streaming) {
          copy[i] = { ...copy[i], text, streaming: false };
          return copy;
        }
      }
      return copy;
    });
  }, []);

  // ─── Core send logic ──────────────────────────────────────────────────

  /**
   * Internal send — handles both text-only and image+text messages.
   * `extraContent` is an optional additional content block array
   * (used by sendWithImage to attach a base64 image).
   */
  const _send = useCallback(async (userText, extraContent = null) => {
    const trimmed = userText.trim();
    if (!trimmed || isThinking) return;
    if (!llmApiKey) {
      setError('No API key — open Settings to configure your LLM provider.');
      return;
    }

    setError(null);
    setIsThinking(true);

    // ── 1. Add user message to visible list ──
    addMsg(ROLE.USER, trimmed);

    // ── 2. Build history entry ──
    const userContent = extraContent
      ? [...extraContent, { type: 'text', text: trimmed }]
      : trimmed;

    historyRef.current.push({ role: 'user', content: userContent });
    trimHistory();

    // ── 3. Build system prompt with current vision context ──
    const systemPrompt = buildSystemPrompt({
      description, environment, objects, textInFrame,
      mood, productVisible, backendOnline, platform,
    });

    // ── 4. Create a streaming placeholder bubble ──
    streamBufRef.current = '';
    addMsg(ROLE.AGENT, '', { streaming: true });
    setIsStreaming(true);

    // ── 5. Call API with retry ──
    abortCtrlRef.current = new AbortController();
    let fullReply = '';
    let attempt   = 0;

    while (attempt <= MAX_RETRIES) {
      try {
        fullReply = await streamAgentResponse(
          llmProvider,
          llmApiKey,
          historyRef.current,
          systemPrompt,
          (delta) => {
            if (!mountedRef.current) return;
            streamBufRef.current += delta;
            updateLastAgentMsg(streamBufRef.current);
          },
          abortCtrlRef.current.signal
        );
        break; // success
      } catch (err) {
        if (err.name === 'AbortError') {
          // User cancelled — exit silently
          fullReply = streamBufRef.current || '[cancelled]';
          break;
        }

        attempt++;
        console.warn(`[useAgent] Attempt ${attempt} failed:`, err.message);

        if (attempt > MAX_RETRIES || err.isRateLimit) {
          // Fall back to non-streaming on final attempt
          try {
            fullReply = await fetchAgentResponse(
              llmProvider,
              llmApiKey,
              historyRef.current,
              systemPrompt,
              abortCtrlRef.current.signal
            );
          } catch (fallbackErr) {
            if (mountedRef.current) {
              finaliseStreamingMsg('');
              setError(fallbackErr.message);
              setIsThinking(false);
              setIsStreaming(false);
              historyRef.current.pop(); // remove failed user turn
            }
            return;
          }
          break;
        }

        // Wait before retry
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }

    if (!mountedRef.current) return;

    // ── 6. Finalise the streaming bubble ──
    const displayReply = fullReply.replace(/```command[\s\S]*?```/g, '').trim();
    finaliseStreamingMsg(displayReply);
    setIsStreaming(false);

    // ── 7. Push assistant turn into history (clean version) ──
    historyRef.current.push({ role: 'assistant', content: displayReply });
    trimHistory();

    // ── 8. Dispatch embedded command if present ──
    const classification = classifyMessage(trimmed);
    if (classification.isCommand || /```command/.test(fullReply)) {
      const result = await dispatchEmbeddedCommand(fullReply);
      if (result.dispatched && mountedRef.current) {
        const statusText = result.status === 'executed'
          ? `⚙ Executed: ${result.cmd?.action ?? 'command'} ${result.cmd?.target ?? ''}`
          : `⚠ Automation failed — ${result.error}`;
        addMsg(ROLE.SYSTEM, statusText);
      }
    }

    // ── 9. Track token usage (rough estimate) ──
    setTokenUsage(prev => ({
      input:  prev.input  + Math.round(systemPrompt.length / 4) + Math.round(trimmed.length / 4),
      output: prev.output + Math.round(fullReply.length / 4),
    }));

    // ── 10. Fire TTS callback if registered ──
    if (displayReply && onAgentReply) {
      onAgentReply(displayReply);
    }

    setIsThinking(false);
  }, [
    isThinking, llmProvider, llmApiKey, description, environment, objects, textInFrame,
    mood, productVisible, backendOnline, platform,
    addMsg, updateLastAgentMsg, finaliseStreamingMsg, onAgentReply,
  ]);

  // ─── Public: send text message ─────────────────────────────────────────

  const send = useCallback((text) => _send(text), [_send]);

  // ─── Public: send text + image (for frozen frame share) ───────────────

  const sendWithImage = useCallback((text, base64Jpeg) => {
    if (!base64Jpeg) return send(text);
    const imageContent = [{
      type:   'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg },
    }];
    return _send(text, imageContent);
  }, [_send, send]);

  // ─── Public: cancel in-flight request ─────────────────────────────────

  const cancel = useCallback(() => {
    abortCtrlRef.current?.abort();
    if (mountedRef.current) {
      setIsThinking(false);
      setIsStreaming(false);
      finaliseStreamingMsg(streamBufRef.current || '[cancelled]');
    }
  }, [finaliseStreamingMsg]);

  // ─── Public: clear session ─────────────────────────────────────────────

  const clearSession = useCallback(() => {
    historyRef.current = [];
    setMessages([
      makeMsg(ROLE.SYSTEM, '◆ Session cleared — new conversation started'),
    ]);
    setError(null);
    setTokenUsage({ input: 0, output: 0 });
  }, []);

  // ─── Public: inject a system notice into the chat ─────────────────────

  const injectSystem = useCallback((text) => {
    addMsg(ROLE.SYSTEM, text);
  }, [addMsg]);

  // ─── Return ────────────────────────────────────────────────────────────

  return {
    messages,
    isThinking,
    isStreaming,
    error,
    tokenUsage,
    historyLength: Math.floor(historyRef.current.length / 2),
    send,
    sendWithImage,
    cancel,
    clearSession,
    injectSystem,
  };
}