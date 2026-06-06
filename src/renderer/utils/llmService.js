import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROVIDERS = {
  CLAUDE: 'claude',
  OPENAI: 'openai',
  DEEPSEEK: 'deepseek',
  GEMINI: 'gemini',
  KIMI: 'kimi',
};

export const DEFAULT_MODELS = {
  [PROVIDERS.CLAUDE]: 'claude-3-5-sonnet-20241022',
  [PROVIDERS.OPENAI]: 'gpt-4o',
  [PROVIDERS.DEEPSEEK]: 'deepseek-chat',
  [PROVIDERS.GEMINI]: 'gemini-2.5-flash',
  [PROVIDERS.KIMI]: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
};

const BASE_URLS = {
  [PROVIDERS.CLAUDE]: 'https://api.anthropic.com/v1/messages',
  [PROVIDERS.OPENAI]: 'https://api.openai.com/v1/chat/completions',
  [PROVIDERS.DEEPSEEK]: 'https://api.deepseek.com/chat/completions',
  [PROVIDERS.GEMINI]: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  [PROVIDERS.KIMI]: 'https://integrate.api.nvidia.com/v1/chat/completions',
};

// ─── Format Converters ────────────────────────────────────────────────────────

/**
 * Converts internal Anthropic-style message history into OpenAI format.
 * Internal format: [ { role: 'user', content: 'string' | [ { type: 'image', source: { data: 'base64...' } }, { type: 'text', text: '...' } ] } ]
 */
function convertToOpenAIFormat(messages, systemPrompt) {
  const openAIMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      openAIMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const convertedContent = msg.content.map(block => {
        if (block.type === 'image') {
          return {
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`
            }
          };
        } else if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        return block;
      });
      openAIMessages.push({ role: msg.role, content: convertedContent });
    }
  }

  return openAIMessages;
}

// ─── Request Builders ─────────────────────────────────────────────────────────

function buildRequestOptions(provider, apiKey, messages, systemPrompt, isStreaming, modelOverride) {
  const model = modelOverride || DEFAULT_MODELS[provider] || CONFIG.agent.model;
  let url = BASE_URLS[provider];
  let headers = {
    'Content-Type': 'application/json',
  };
  let body = {};

  if (provider === PROVIDERS.CLAUDE) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // For browser execution (CORS might be an issue, assuming proxy or CORS allowed via backend/electron setup)
    // Actually, Anthropic needs anthropic-dangerous-direct-browser if called from browser, but Electron avoids CORS via fetch?
    // We keep existing headers.
    
    body = {
      model: model,
      max_tokens: CONFIG.agent.maxTokens || 1024,
      temperature: CONFIG.agent.temperature || 0,
      system: systemPrompt,
      messages: messages,
    };
    if (isStreaming) body.stream = true;
  } else {
    // OpenAI Compatible (OpenAI, DeepSeek, Gemini)
    headers['Authorization'] = `Bearer ${apiKey}`;
    
    body = {
      model: model,
      temperature: provider === PROVIDERS.KIMI ? 0.6 : (CONFIG.agent.temperature || 0),
      max_tokens: provider === PROVIDERS.KIMI ? 65536 : (CONFIG.agent.maxTokens || 1024),
      messages: convertToOpenAIFormat(messages, systemPrompt),
    };
    if (provider === PROVIDERS.KIMI) {
      body.extra_body = {
        chat_template_kwargs: { enable_thinking: true },
        reasoning_budget: 16384,
      };
    }
    if (isStreaming) body.stream = true;
  }

  return { url, headers, body };
}

// ─── API Functions ────────────────────────────────────────────────────────────

export async function fetchAgentResponse(provider, apiKey, history, systemPrompt, signal, modelOverride) {
  const { url, headers, body } = buildRequestOptions(provider, apiKey, history, systemPrompt, false, modelOverride);

  const res = await window.cortexa.llmFetch({ url, headers, body });

  if (!res.ok) {
    if (res.error) throw new Error(res.error);
    let msg = `API error ${res.status}`;
    if (Array.isArray(res.errorBody) && res.errorBody.length > 0) {
      msg = res.errorBody[0]?.error?.message || msg;
    } else if (res.errorBody?.error?.message) {
      msg = res.errorBody.error.message;
    } else if (res.errorBody?.message) {
      msg = res.errorBody.message;
    } else if (typeof res.errorBody === 'string') {
      msg = res.errorBody;
    } else {
      msg = `${msg}: ${JSON.stringify(res.errorBody)}`;
    }
    throw new Error(msg);
  }

  const data = res.data;
  
  if (provider === PROVIDERS.CLAUDE) {
    return data.content?.[0]?.text ?? '';
  } else {
    return data.choices?.[0]?.message?.content ?? '';
  }
}

export async function streamAgentResponse(provider, apiKey, history, systemPrompt, onChunk, signal, modelOverride) {
  const { url, headers, body } = buildRequestOptions(provider, apiKey, history, systemPrompt, true, modelOverride);

  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const msg = errorBody?.error?.message ?? `API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.isRateLimit = res.status === 429;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const dataLine = event.split('\n').find(l => l.startsWith('data: '));
      if (!dataLine) continue;

      const json = dataLine.slice(6).trim();
      if (json === '[DONE]') break;

      try {
        const parsed = JSON.parse(json);
        let delta = '';
        
        if (provider === PROVIDERS.CLAUDE) {
          if (parsed.type === 'content_block_delta') {
            delta = parsed.delta?.text ?? '';
          }
        } else {
          // OpenAI Compatible format
          delta = parsed.choices?.[0]?.delta?.content ?? '';
        }

        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch (_) {
        // Malformed SSE chunk
      }
    }
  }

  return full;
}

export async function analyseImage(provider, apiKey, base64Jpeg, prompt, signal) {
  const messages = [{
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg }
      },
      { type: 'text', text: prompt }
    ]
  }];
  
  // Reuse fetchAgentResponse logic
  return fetchAgentResponse(provider, apiKey, messages, null, signal);
}
