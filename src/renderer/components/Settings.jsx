import React, { useState, useEffect } from 'react';
import { PROVIDERS, DEFAULT_MODELS } from '../utils/llmService';

export default function Settings({ onClose }) {
  const [llmProvider, setLlmProvider] = useState(PROVIDERS.CLAUDE);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    window.cortexa.loadKeys().then(({ keys }) => {
      if (keys) {
        if (keys.llmProvider) setLlmProvider(keys.llmProvider);
        if (keys.llmApiKey) setLlmApiKey(keys.llmApiKey);
        // Migrate old anthropicKey
        if (!keys.llmApiKey && keys.anthropicKey) {
          setLlmApiKey(keys.anthropicKey);
          setLlmProvider(PROVIDERS.CLAUDE);
        }
      }
    });
  }, []);

  const handleSave = async () => {
    const keys = { llmProvider, llmApiKey };
    const res = await window.cortexa.saveKeys(keys);
    if (res.ok) {
      setSavedMessage('Settings saved successfully!');
      setTimeout(() => setSavedMessage(''), 3000);
      setTimeout(onClose, 500);
      // Reload window to apply new keys globally across components easily
      // or we can rely on React state, but currently App.jsx and children load on mount.
      // Better to trigger a custom event or let the user restart the app, but reloading is fast in electron.
      window.location.reload(); 
    } else {
      setSavedMessage(`Failed: ${res.error}`);
    }
  };

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={S.header}>
          <span style={S.title}>Settings</span>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={S.body}>
          <label style={S.label}>LLM Provider</label>
          <select 
            style={S.select} 
            value={llmProvider} 
            onChange={(e) => setLlmProvider(e.target.value)}
          >
            <option value={PROVIDERS.CLAUDE}>Anthropic (Claude)</option>
            <option value={PROVIDERS.OPENAI}>OpenAI</option>
            <option value={PROVIDERS.DEEPSEEK}>DeepSeek</option>
            <option value={PROVIDERS.GEMINI}>Google Gemini</option>
            <option value={PROVIDERS.KIMI}>Kimi (NVIDIA)</option>
          </select>

          <label style={S.label}>API Key</label>
          <input 
            type="password" 
            style={S.input} 
            value={llmApiKey} 
            onChange={(e) => setLlmApiKey(e.target.value)} 
            placeholder={`Enter your ${llmProvider} API key...`}
          />
          <div style={S.hint}>
            Default Model: {DEFAULT_MODELS[llmProvider]}
          </div>

          <div style={S.footer}>
            {savedMessage && <span style={S.msg}>{savedMessage}</span>}
            <button style={S.saveBtn} onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  overlay: {
    position: 'absolute', inset: 0,
    background: '#000000aa', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999,
  },
  modal: {
    width: 400, background: '#0e1118',
    borderRadius: 8, border: '1px solid #1e2333',
    boxShadow: '0 8px 32px #000000aa',
    display: 'flex', flexDirection: 'column',
    fontFamily: "'Outfit', sans-serif",
  },
  header: {
    padding: '12px 16px', borderBottom: '1px solid #1e2333',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  title: {
    color: '#eef0f5', fontSize: 14, fontWeight: 500,
  },
  closeBtn: {
    background: 'none', border: 'none', color: '#7a8099',
    cursor: 'pointer', fontSize: 16,
  },
  body: {
    padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
  },
  label: {
    color: '#eef0f5', fontSize: 12, fontWeight: 500,
  },
  select: {
    background: '#080a0f', border: '1px solid #2a2f42', borderRadius: 4,
    padding: '8px 12px', color: '#eef0f5', fontSize: 13, outline: 'none',
  },
  input: {
    background: '#080a0f', border: '1px solid #2a2f42', borderRadius: 4,
    padding: '8px 12px', color: '#eef0f5', fontSize: 13, outline: 'none',
  },
  hint: {
    fontSize: 11, color: '#7a8099', marginTop: -6,
  },
  footer: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 8,
  },
  msg: {
    color: '#3ecfb2', fontSize: 12,
  },
  saveBtn: {
    background: '#3ecfb2', color: '#080a0f', border: 'none',
    padding: '8px 16px', borderRadius: 4, fontSize: 13, fontWeight: 500,
    cursor: 'pointer', marginLeft: 'auto',
  },
};
