/**
 * claude.js — Anthropic API wrapper
 *
 * Single point of contact for every call to the Anthropic API.
 * Handles authentication, content building, streaming SSE parsing,
 * rate-limit detection, request queuing, and token tracking.
 *
 * Nothing in this file holds React state — it is pure JS.
 * Hooks (useAgent, useVision) call into here and own the state themselves.
 */

import { CONFIG } from '../config';

// ─── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MAX_CONCURRENT    = 2;
const MAX_RETRIES       = 2;
const RETRY_BASE_MS     = 1_000;
const RATE_LIMIT_FLOOR  = 5_000;

// ─── Error type ───────────────────────────────────────────────────────────────

export class ClaudeError extends Error {
  constructor(message, { status, code, isRateLimit, isAuth, isOverload } = {}) {
    super(message);
    this.name        = 'ClaudeError';
    this.status      = status      ?? null;
    this.code        = code        ?? 'UNKNOWN';
    this.isRateLimit = isRateLimit ?? false;
    this.isAuth      = isAuth      ?? false;
    this.isOverload  = isOverload  ?? false;
  }
}

function makeApiError(status, body = {}) {
  const msg  = body?.error?.message ?? `Anthropic API error ${status}`;
  const type = body?.error?.type    ?? '';
  return new ClaudeError(msg, {
    status,
    code:        type || String(status),
    isRateLimit: status === 429,
    isAuth:      status === 401,
    isOverload:  status === 529 || type === 'overloaded_error',
  });
}

// ─── Token tracker ────────────────────────────────────────────────────────────

const _tokens = { inputTotal: 0, outputTotal: 0, callCount: 0 };

function recordUsage(input = 0, output = 0) {
  _tokens.inputTotal  += input;
  _tokens.outputTotal += output;
  _tokens.callCount   += 1;
}

export const getTokenUsage  = () => ({ ..._tokens });
export const resetTokenUsage = () => { _tokens.inputTotal = 0; _tokens.outputTotal = 0; _tokens.callCount = 0; };

// ─── Concurrency queue ────────────────────────────────────────────────────────

let _active = 0;
const _queue = [];

function acquireSlot() {
  return new Promise(resolve => {
    if (_active < MAX_CONCURRENT) { _active++; resolve(); }
    else _queue.push(resolve);
  });
}

function releaseSlot() {
  _active = Math.max(0, _active - 1);
  if (_queue.length > 0) { _active++; _queue.shift()(); }
}

// ─── Content builders ─────────────────────────────────────────────────────────

export const textBlock     = (text)                        => ({ type: 'text', text: String(text) });
export const imageBlock    = (base64, mt = 'image/jpeg')   => ({ type: 'image', source: { type: 'base64', media_type: mt, data: base64 } });
export const imageUrlBlock = (url)                         => ({ type: 'image', source: { type: 'url', url } });

export function userMessage(text, base64Jpeg = null) {
  if (!base64Jpeg) return { role: 'user', content: text };
  return { role: 'user', content: [imageBlock(base64Jpeg), textBlock(text)] };
}

export const assistantMessage = (text) => ({ role: 'assistant', content: text });

// ─── Rate limit delay ─────────────────────────────────────────────────────────

function getRateLimitDelay(headers) {
  const ra   = headers?.get?.('retry-after');
  const secs = ra ? parseFloat(ra) : NaN;
  return isNaN(secs) ? RATE_LIMIT_FLOOR : Math.max(secs * 1000, RATE_LIMIT_FLOOR);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Non-streaming request ────────────────────────────────────────────────────

/**
 * Send a non-streaming messages request.
 *
 * @param {object}      params
 * @param {string}      params.apiKey
 * @param {object[]}    params.messages
 * @param {string}      [params.system]
 * @param {string}      [params.model]
 * @param {number}      [params.maxTokens]
 * @param {number}      [params.temperature]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ text, stopReason, inputTokens, outputTokens }>}
 */
export async function ask({
  apiKey, messages, system,
  model       = CONFIG.agent.model,
  maxTokens   = CONFIG.agent.maxTokens,
  temperature = CONFIG.agent.temperature,
  signal,
}) {
  await acquireSlot();
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal,
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature, messages,
          ...(system ? { system } : {}),
        }),
      });

      if (res.status === 429) {
        await sleep(getRateLimitDelay(res.headers));
        continue;
      }
      if (!res.ok) {
        const err = makeApiError(res.status, await res.json().catch(() => ({})));
        if (attempt < MAX_RETRIES && !err.isAuth) { attempt++; await sleep(RETRY_BASE_MS * attempt); continue; }
        throw err;
      }

      const data         = await res.json();
      const text         = data.content?.[0]?.text ?? '';
      const inputTokens  = data.usage?.input_tokens  ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      recordUsage(inputTokens, outputTokens);
      return { text, stopReason: data.stop_reason, inputTokens, outputTokens };

    } catch (err) {
      if (err.name === 'AbortError' || err instanceof ClaudeError) throw err;
      if (attempt < MAX_RETRIES) { attempt++; await sleep(RETRY_BASE_MS * attempt); continue; }
      throw new ClaudeError(err.message, { code: 'NETWORK_ERROR' });
    } finally {
      releaseSlot();
    }
  }
}

// ─── Streaming request ────────────────────────────────────────────────────────

/**
 * Send a streaming messages request.
 * Calls onDelta(deltaText) for every token, onComplete({ text, inputTokens, outputTokens }) when done.
 *
 * @param {object}      params            same as ask(), plus:
 * @param {Function}    params.onDelta    (delta: string) => void
 * @param {Function}    [params.onComplete]
 * @returns {Promise<{ text, inputTokens, outputTokens }>}
 */
export async function stream({
  apiKey, messages, system,
  model       = CONFIG.agent.model,
  maxTokens   = CONFIG.agent.maxTokens,
  temperature = CONFIG.agent.temperature,
  signal, onDelta, onComplete,
}) {
  await acquireSlot();
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal,
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature, stream: true, messages,
          ...(system ? { system } : {}),
        }),
      });

      if (res.status === 429) {
        await sleep(getRateLimitDelay(res.headers));
        continue;
      }
      if (!res.ok) {
        const err = makeApiError(res.status, await res.json().catch(() => ({})));
        if (attempt < MAX_RETRIES && !err.isAuth) { attempt++; await sleep(RETRY_BASE_MS * attempt); continue; }
        throw err;
      }

      const result = await parseSSEStream(res.body, onDelta, signal);
      recordUsage(result.inputTokens, result.outputTokens);
      onComplete?.(result);
      return result;

    } catch (err) {
      if (err.name === 'AbortError' || err instanceof ClaudeError) throw err;
      if (attempt < MAX_RETRIES) { attempt++; await sleep(RETRY_BASE_MS * attempt); continue; }
      throw new ClaudeError(err.message, { code: 'NETWORK_ERROR' });
    } finally {
      releaseSlot();
    }
  }
}

// ─── SSE parser ───────────────────────────────────────────────────────────────

async function parseSSEStream(readableStream, onDelta, signal) {
  const reader  = readableStream.getReader();
  const decoder = new TextDecoder();
  let fullText = '', inputTokens = 0, outputTokens = 0, buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const raw of events) {
        const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const json = dataLine.slice(6).trim();
        if (!json || json === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(json); } catch (_) { continue; }

        if (evt.type === 'message_start') {
          inputTokens = evt.message?.usage?.input_tokens ?? 0;
        } else if (evt.type === 'content_block_delta') {
          const delta = evt.delta?.text ?? '';
          if (delta) { fullText += delta; onDelta?.(delta); }
        } else if (evt.type === 'message_delta') {
          outputTokens = evt.usage?.output_tokens ?? 0;
        } else if (evt.type === 'error') {
          throw new ClaudeError(evt.error?.message ?? 'Stream error', { code: evt.error?.type });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: fullText, inputTokens, outputTokens };
}

// ─── Specialised helpers ──────────────────────────────────────────────────────

/**
 * Send a frame to Claude for vision analysis. Returns parsed JSON.
 *
 * @param {object}      params
 * @param {string}      params.apiKey
 * @param {string}      params.base64Jpeg
 * @param {string}      params.prompt
 * @param {number}      [params.maxTokens]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object>}
 */
export async function analyseImage({ apiKey, base64Jpeg, prompt, maxTokens = 1_024, signal }) {
  const { text } = await ask({
    apiKey, maxTokens, temperature: 0, signal,
    messages: [userMessage(prompt, base64Jpeg)],
  });
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); }
  catch (_) { throw new ClaudeError(`Vision returned non-JSON: ${clean.slice(0, 120)}`, { code: 'PARSE_ERROR' }); }
}

/**
 * Ask a single question with no history.
 *
 * @param {object}      params
 * @param {string}      params.apiKey
 * @param {string}      params.question
 * @param {string}      [params.systemHint]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>}
 */
export async function quickAsk({ apiKey, question, systemHint, signal }) {
  const { text } = await ask({
    apiKey, maxTokens: 512, temperature: 0.5, signal,
    system:   systemHint,
    messages: [{ role: 'user', content: question }],
  });
  return text;
}

/**
 * Look up a product name/barcode and return structured JSON details.
 *
 * @param {object}      params
 * @param {string}      params.apiKey
 * @param {string}      params.product
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ name, brand, description, category, searchUrl, priceRange, notes }>}
 */
export async function lookupProduct({ apiKey, product, signal }) {
  const prompt = `You are a product identification assistant.
Given: "${product}"
Return ONLY valid JSON (no fences):
{"name":"<full name>","brand":"<brand>","description":"<one sentence>","category":"<category>","searchUrl":"https://www.amazon.com/s?k=<url-encoded name>","priceRange":"<e.g. $20-$40>","notes":"<any notes>"}
If unknown: {"name":"${product}","brand":"","description":"Could not identify.","category":"unknown","searchUrl":"","priceRange":"","notes":""}`;

  const { text } = await ask({ apiKey, maxTokens: 512, temperature: 0, signal, messages: [{ role: 'user', content: prompt }] });
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); }
  catch (_) { return { name: product, brand: '', description: 'Could not parse.', category: 'unknown', searchUrl: '', priceRange: '', notes: '' }; }
}

// ─── API key helpers ──────────────────────────────────────────────────────────

/**
 * Validate API key format without making a network call.
 * @param {string} key
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateApiKey(key) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'API key is empty.' };
  if (!key.startsWith('sk-ant-'))        return { valid: false, reason: 'Key must start with "sk-ant-".' };
  if (key.length < 40)                   return { valid: false, reason: 'Key appears too short.' };
  return { valid: true };
}

/**
 * Test a key by making a minimal real API call.
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function testApiKey(apiKey) {
  await ask({ apiKey, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 5, temperature: 0 });
  return true;
}