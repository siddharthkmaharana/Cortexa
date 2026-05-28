import { useState, useEffect, useRef, useCallback } from 'react';
import { captureFrame } from './useCamera';
import { CONFIG } from '../config';
import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum ms between API calls regardless of config (hard floor) */
const MIN_INTERVAL_MS = 100;

/** Maximum backoff delay after repeated errors (ms) */
const MAX_BACKOFF_MS = 30_000;

/** Number of consecutive errors before backing off */
const BACKOFF_THRESHOLD = 2;

/** How many historical results to keep for trend analysis */
const HISTORY_DEPTH = 10;

// ─── Vision prompt ────────────────────────────────────────────────────────────

const LIVE_PROMPT = `Analyse this camera frame. Return ONLY valid JSON, no markdown fences, no explanation:
{
  "description": "<one concise sentence describing the overall scene>",
  "environment": "<one of: workspace | kitchen | living_room | bedroom | outdoor | retail | office | unknown>",
  "objects": [
    {
      "label":      "<object name, lowercase>",
      "category":   "<one of: person | device | furniture | food | document | vehicle | plant | animal | product | other>",
      "confidence": <number 0.0–1.0>,
      "bbox":       { "x": <0–1>, "y": <0–1>, "w": <0–1>, "h": <0–1> },
      "text":       "<any visible text on/near this object, or null>"
    }
  ],
  "text_in_frame": "<all readable text visible anywhere in the image, or null>",
  "mood":          "<inferred user mood if a face is visible: neutral | happy | focused | stressed | tired | null>"
}
bbox values are normalised (0–1) relative to image width/height. Include every clearly visible object. Omit tiny or uncertain detections below 0.55 confidence.`;

const FROZEN_PROMPT = `Perform a detailed analysis of this frozen frame. Return ONLY valid JSON:
{
  "description":   "<2–3 sentence detailed scene description>",
  "environment":   "<workspace | kitchen | living_room | bedroom | outdoor | retail | office | unknown>",
  "objects": [
    {
      "label":      "<object name, lowercase>",
      "category":   "<person | device | furniture | food | document | vehicle | plant | animal | product | other>",
      "confidence": <0.0–1.0>,
      "bbox":       { "x": <0–1>, "y": <0–1>, "w": <0–1>, "h": <0–1> },
      "text":       "<visible text on/near this object, or null>",
      "notes":      "<any additional detail worth noting, or null>"
    }
  ],
  "text_in_frame":    "<all readable text in the image, or null>",
  "mood":             "<neutral | happy | focused | stressed | tired | null>",
  "product_visible":  <true | false>,
  "suggested_actions": ["<action the agent could take based on this frame>"]
}`;

// ─── API caller ───────────────────────────────────────────────────────────────

/**
 * Sends a base64 JPEG to the Claude vision API and returns the parsed JSON result.
 * Throws on network error or non-200 response.
 *
 * @param {string} base64Jpeg   raw base64 string (no data: prefix)
 * @param {string} apiKey
 * @param {string} prompt       LIVE_PROMPT or FROZEN_PROMPT
 * @returns {Promise<object>}   parsed vision result
 */
async function callVisionAPI(base64Jpeg, apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CONFIG.agent.model,
      max_tokens: 1024,
      messages: [{
        role:    'user',
        content: [
          {
            type:   'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg  = body?.error?.message ?? `HTTP ${res.status}`;
    const err  = new Error(msg);
    err.status = res.status;
    err.isRateLimit = res.status === 429;
    throw err;
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '{}';

  // Strip any accidental markdown fences before parsing
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (_) {
    throw new Error('Vision API returned non-JSON response');
  }
}

// ─── Result normaliser ────────────────────────────────────────────────────────

/**
 * Ensures a raw API result has all expected fields, filters low-confidence
 * detections, and attaches a colour hint to each object for the overlay.
 */
const CATEGORY_COLORS = {
  person:    '#e84040',
  device:    '#3ecfb2',
  furniture: '#a78bfa',
  food:      '#f59e0b',
  document:  '#e8a628',
  vehicle:   '#60a5fa',
  plant:     '#34d399',
  animal:    '#f97316',
  product:   '#e879f9',
  other:     '#94a3b8',
};

function normaliseResult(raw = {}) {
  const objects = (raw.objects ?? [])
    .filter(o =>
      typeof o.confidence === 'number' &&
      o.confidence >= CONFIG.vision.minConfidence &&
      o.bbox &&
      typeof o.bbox.x === 'number'
    )
    .map(o => ({
      label:      String(o.label      ?? 'object'),
      category:   String(o.category   ?? 'other'),
      confidence: Number(o.confidence ?? 0),
      bbox:       {
        x: clamp(o.bbox.x, 0, 1),
        y: clamp(o.bbox.y, 0, 1),
        w: clamp(o.bbox.w, 0, 1),
        h: clamp(o.bbox.h, 0, 1),
      },
      text:  o.text  ?? null,
      notes: o.notes ?? null,
      color: CATEGORY_COLORS[o.category] ?? CATEGORY_COLORS.other,
    }));

  return {
    description:      String(raw.description      ?? ''),
    environment:      String(raw.environment       ?? 'unknown'),
    objects,
    textInFrame:      raw.text_in_frame            ?? null,
    mood:             raw.mood                     ?? null,
    productVisible:   Boolean(raw.product_visible),
    suggestedActions: Array.isArray(raw.suggested_actions) ? raw.suggested_actions : [],
    rawResponse:      raw,
  };
}

function clamp(v, min, max) {
  return Math.min(Math.max(Number(v) || 0, min), max);
}

// ─── Backoff calculator ───────────────────────────────────────────────────────

function calcBackoff(errorCount) {
  if (errorCount < BACKOFF_THRESHOLD) return 0;
  // Exponential: 2s, 4s, 8s… capped at MAX_BACKOFF_MS
  return Math.min(1000 * Math.pow(2, errorCount - BACKOFF_THRESHOLD + 1), MAX_BACKOFF_MS);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useVision
 *
 * Drives the vision polling loop: every CONFIG.vision.intervalMs it captures
 * a frame from the video element, sends it to Claude's vision API, parses the
 * result, and exposes structured state to the rest of the app.
 *
 * When a frozen frame is active, polling pauses and the frozen JPEG is analysed
 * once with the more-detailed FROZEN_PROMPT.
 *
 * @param {object} params
 * @param {React.RefObject<HTMLVideoElement>} params.videoRef     live video element
 * @param {string}                            params.apiKey       Anthropic key
 * @param {boolean}                           params.paused       pause polling (e.g. app in bg)
 * @param {string|null}                       params.frozenFrame  base64 JPEG of frozen frame
 *
 * @returns {{
 *   detections:       object[],   normalised object list with bbox + color
 *   description:      string,     scene summary sentence
 *   environment:      string,     room/context type
 *   textInFrame:      string|null all text visible in frame
 *   mood:             string|null inferred user mood
 *   productVisible:   boolean,
 *   suggestedActions: string[],   only populated on frozen-frame deep-dive
 *   isAnalysing:      boolean,    API call in-flight
 *   error:            string|null last error message
 *   errorCount:       number,     consecutive error count
 *   lastUpdated:      number|null Date.now() of last successful result
 *   analysisHistory:  object[],   last N successful results
 *   tokenUsage:       { input, output } cumulative tokens this session
 *   analyseNow:       () => void  trigger an immediate manual analysis
 *   resetErrors:      () => void  clear error state and backoff
 * }}
 */
export function useVision({ videoRef, apiKey, paused = false, frozenFrame = null }) {
  // ── Vision state ──────────────────────────────────────────────────────────
  const [detections,       setDetections]       = useState([]);
  const [description,      setDescription]      = useState('');
  const [environment,      setEnvironment]      = useState('unknown');
  const [textInFrame,      setTextInFrame]      = useState(null);
  const [mood,             setMood]             = useState(null);
  const [productVisible,   setProductVisible]   = useState(false);
  const [suggestedActions, setSuggestedActions] = useState([]);
  const [isAnalysing,      setIsAnalysing]      = useState(false);
  const [error,            setError]            = useState(null);
  const [errorCount,       setErrorCount]       = useState(0);
  const [lastUpdated,      setLastUpdated]      = useState(null);
  const [analysisHistory,  setAnalysisHistory]  = useState([]);
  const [tokenUsage,       setTokenUsage]       = useState({ input: 0, output: 0 });

  // ── Internal refs ─────────────────────────────────────────────────────────
  const cocoModelRef     = useRef(null);
  const isAnalysingRef   = useRef(false);    // sync mirror of isAnalysing state
  const mountedRef       = useRef(true);
  const timerRef         = useRef(null);
  const frozenDoneRef    = useRef(false);    // true once frozen frame has been analysed
  const errorCountRef    = useRef(0);        // sync mirror for backoff calc
  const localTimerRef    = useRef(null);

  // Load local model
  useEffect(() => {
    let mounted = true;
    cocoSsd.load().then(loaded => {
      if (mounted) cocoModelRef.current = loaded;
    }).catch(err => console.warn('[useVision] Failed to load coco-ssd model:', err));
    return () => { mounted = false; };
  }, []);

  // ─── Core analysis function ────────────────────────────────────────────────

  const analyse = useCallback(async (frameBase64, isFrozen = false) => {
    if (!frameBase64 || !apiKey)       return;
    if (isAnalysingRef.current)        return;  // already in-flight

    isAnalysingRef.current = true;
    if (mountedRef.current) setIsAnalysing(true);

    const prompt = isFrozen ? FROZEN_PROMPT : LIVE_PROMPT;

    try {
      const raw    = await callVisionAPI(frameBase64, apiKey, prompt);
      const result = normaliseResult(raw);

      if (!mountedRef.current) return;

      // Update all state atomically-ish (React batches these in the same event)
      setDetections(result.objects);
      setDescription(result.description);
      setEnvironment(result.environment);
      setTextInFrame(result.textInFrame);
      setMood(result.mood);
      setProductVisible(result.productVisible);
      setSuggestedActions(result.suggestedActions);
      setLastUpdated(Date.now());
      setError(null);
      setErrorCount(0);
      errorCountRef.current = 0;

      // Append to rolling history
      setAnalysisHistory(prev => {
        const next = [
          { ...result, timestamp: Date.now(), isFrozen },
          ...prev,
        ];
        return next.slice(0, HISTORY_DEPTH);
      });

      // Accumulate token usage (API returns usage in response)
      // Note: usage isn't in the parsed result — we'd need to read it from the
      // raw fetch response. For now we estimate: ~1 token per 4 chars of prompt.
      setTokenUsage(prev => ({
        input:  prev.input  + Math.round(prompt.length / 4),
        output: prev.output + Math.round(JSON.stringify(raw).length / 4),
      }));

    } catch (err) {
      if (!mountedRef.current) return;

      const newCount = errorCountRef.current + 1;
      errorCountRef.current = newCount;
      setErrorCount(newCount);
      setError(err.message);

      // Rate limit — log clearly but don't nuke the last good state
      if (err.isRateLimit) {
        console.warn('[useVision] Rate limited — backing off', calcBackoff(newCount), 'ms');
      } else {
        console.warn('[useVision] Analysis error:', err.message);
      }
    } finally {
      isAnalysingRef.current = false;
      if (mountedRef.current) setIsAnalysing(false);
    }
  }, [apiKey]);

  // ─── Frozen frame deep-dive ────────────────────────────────────────────────

  useEffect(() => {
    if (!frozenFrame) {
      // Frame unfrozen — reset so next freeze triggers a fresh analysis
      frozenDoneRef.current = false;
      return;
    }
    if (frozenDoneRef.current) return;  // already analysed this freeze

    frozenDoneRef.current = true;
    analyse(frozenFrame, true);
  }, [frozenFrame, analyse]);

  // ─── Local detection polling loop (100ms) ─────────────────────────────────
  
  useEffect(() => {
    if (paused || frozenFrame) {
      clearTimeout(localTimerRef.current);
      return;
    }

    function scheduleNextLocal() {
      clearTimeout(localTimerRef.current);
      localTimerRef.current = setTimeout(async () => {
        if (!mountedRef.current) return;
        
        const video = videoRef.current;
        const model = cocoModelRef.current;
        if (video && video.readyState >= 2 && !paused && !frozenFrame && model) {
          try {
            const preds = await model.detect(video);
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            
            const localDetections = preds.map(p => {
              // Map some coco-ssd classes to our category colors
              let category = 'other';
              if (p.class === 'person') category = 'person';
              else if (['tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone'].includes(p.class)) category = 'device';
              else if (['chair', 'couch', 'potted plant', 'bed', 'dining table'].includes(p.class)) category = 'furniture';
              else if (['apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake'].includes(p.class)) category = 'food';
              else if (['car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'bicycle'].includes(p.class)) category = 'vehicle';
              else if (['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'].includes(p.class)) category = 'animal';

              return {
                label: p.class,
                category,
                confidence: p.score,
                bbox: {
                  x: clamp(p.bbox[0] / vw, 0, 1),
                  y: clamp(p.bbox[1] / vh, 0, 1),
                  w: clamp(p.bbox[2] / vw, 0, 1),
                  h: clamp(p.bbox[3] / vh, 0, 1),
                },
                text: null,
                notes: null,
                color: CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other,
              };
            }).filter(d => d.confidence >= CONFIG.vision.minConfidence);
            
            if (mountedRef.current) setDetections(localDetections);
          } catch (err) {
            // ignore
          }
        }
        scheduleNextLocal();
      }, CONFIG.vision.intervalMs || 100);
    }
    
    scheduleNextLocal();
    return () => clearTimeout(localTimerRef.current);
  }, [paused, frozenFrame, videoRef]);

  // ─── API polling loop (15s) ───────────────────────────────────────────────

  useEffect(() => {
    // Do not poll if: paused, frozen, no API key, or no video element
    if (paused || frozenFrame || !apiKey) {
      clearTimeout(timerRef.current);
      return;
    }

    function scheduleNextAPI() {
      clearTimeout(timerRef.current);

      // Apply backoff delay on top of the base interval
      const backoff   = calcBackoff(errorCountRef.current);
      const interval  = Math.max(
        MIN_INTERVAL_MS,
        (CONFIG.vision.apiIntervalMs || 15000) + backoff,
      );

      timerRef.current = setTimeout(async () => {
        if (!mountedRef.current) return;

        const video = videoRef.current;
        if (video && video.readyState >= 2 && !paused && !frozenFrame) {
          const frame = captureFrame(video);
          if (frame) await analyse(frame, false);
        }

        scheduleNextAPI();   // re-schedule regardless of success/failure
      }, interval);
    }

    scheduleNextAPI();

    return () => clearTimeout(timerRef.current);
  }, [apiKey, paused, frozenFrame, videoRef, analyse]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      clearTimeout(localTimerRef.current);
    };
  }, []);

  // ─── Manual trigger ───────────────────────────────────────────────────────

  const analyseNow = useCallback(() => {
    const video = videoRef.current;
    if (!video || !apiKey) return;
    const frame = frozenFrame ?? captureFrame(video);
    if (frame) analyse(frame, Boolean(frozenFrame));
  }, [videoRef, apiKey, frozenFrame, analyse]);

  // ─── Reset error state ────────────────────────────────────────────────────

  const resetErrors = useCallback(() => {
    errorCountRef.current = 0;
    setErrorCount(0);
    setError(null);
  }, []);

  // ─── Return ───────────────────────────────────────────────────────────────

  return {
    detections,
    description,
    environment,
    textInFrame,
    mood,
    productVisible,
    suggestedActions,
    isAnalysing,
    error,
    errorCount,
    lastUpdated,
    analysisHistory,
    tokenUsage,
    analyseNow,
    resetErrors,
  };
}