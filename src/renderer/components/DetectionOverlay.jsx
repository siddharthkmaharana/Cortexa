import React, { useMemo } from 'react';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Length (px) of each corner bracket arm */
const BRACKET_ARM = 14;

/** Thickness of the bracket stroke (px) */
const BRACKET_W = 1.5;

/** Height of the label pill above each box */
const LABEL_H = 18;

/** Width of the mini confidence bar inside the label */
const BAR_W = 28;

/** Minimum box size (px) to bother rendering — avoids cluttered tiny boxes */
const MIN_BOX_PX = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a normalised bbox { x, y, w, h } (values 0–1) to pixel coordinates
 * relative to the rendered canvas dimensions.
 */
function toPixels(bbox, canvasW, canvasH) {
  return {
    x: bbox.x * canvasW,
    y: bbox.y * canvasH,
    w: bbox.w * canvasW,
    h: bbox.h * canvasH,
  };
}

/**
 * Estimate the pixel width needed for a label string.
 * (Avoids a DOM measurement — good enough for monospace at 9px.)
 */
function estimateLabelW(label, confidence) {
  const text = `${label.toUpperCase()} ${Math.round(confidence * 100)}%`;
  return text.length * 5.5 + 16 + BAR_W + 8;
}

// ─── L-Bracket corners ────────────────────────────────────────────────────────

/**
 * Renders four L-shaped corner brackets for a single detection box.
 * Uses SVG <path> elements for crisp sub-pixel rendering.
 *
 * @param {{ x, y, w, h }} box  Pixel coordinates
 * @param {string}          col Hex colour
 */
function Brackets({ box, col }) {
  const { x, y, w, h } = box;
  const a = BRACKET_ARM;

  // [cornerX, cornerY, horizontalDir, verticalDir]
  const corners = [
    [x,     y,     1,  1],   // top-left
    [x + w, y,    -1,  1],   // top-right
    [x,     y + h, 1, -1],   // bottom-left
    [x + w, y + h,-1, -1],   // bottom-right
  ];

  return (
    <>
      {/* Filled inner rect — very faint colour wash */}
      <rect
        x={x} y={y} width={w} height={h}
        fill={col}
        fillOpacity={0.06}
      />

      {/* Corner brackets */}
      {corners.map(([cx, cy, dx, dy], i) => (
        <path
          key={i}
          d={`M ${cx + dx * a} ${cy} L ${cx} ${cy} L ${cx} ${cy + dy * a}`}
          stroke={col}
          strokeWidth={BRACKET_W}
          strokeLinecap="round"
          fill="none"
          opacity={0.9}
        />
      ))}
    </>
  );
}

// ─── Label pill ───────────────────────────────────────────────────────────────

/**
 * Renders the label pill above a detection box.
 * Contains: coloured indicator dot · object name · confidence bar · percentage.
 *
 * Positions itself so it never overflows the left edge of the canvas.
 */
function LabelPill({ box, col, label, confidence, canvasW }) {
  const { x, y } = box;
  const pillW = estimateLabelW(label, confidence);
  const pillX = Math.min(x - 1, canvasW - pillW - 2); // clamp to canvas width
  const pillY = y - LABEL_H;                           // sits directly above box

  const pct  = Math.round(confidence * 100);
  const barFill = Math.round((confidence) * BAR_W);
  const displayText = label.toUpperCase();

  return (
    <g>
      {/* Background rect */}
      <rect
        x={pillX} y={pillY}
        width={pillW} height={LABEL_H}
        fill="#080a0f"
        rx={2}
      />
      {/* Coloured left border accent */}
      <rect
        x={pillX} y={pillY}
        width={2} height={LABEL_H}
        fill={col}
        rx={1}
      />
      {/* Outline */}
      <rect
        x={pillX} y={pillY}
        width={pillW} height={LABEL_H}
        fill="none"
        stroke={col}
        strokeWidth={0.5}
        strokeOpacity={0.5}
        rx={2}
      />

      {/* Label text */}
      <text
        x={pillX + 7}
        y={pillY + 12}
        fontSize={9}
        fontFamily="'Syne Mono', monospace"
        fill={col}
        letterSpacing="0.08em"
      >
        {displayText}
      </text>

      {/* Confidence bar — background track */}
      <rect
        x={pillX + pillW - BAR_W - 28}
        y={pillY + 7}
        width={BAR_W}
        height={4}
        fill={col}
        fillOpacity={0.15}
        rx={2}
      />
      {/* Confidence bar — filled portion */}
      <rect
        x={pillX + pillW - BAR_W - 28}
        y={pillY + 7}
        width={barFill}
        height={4}
        fill={col}
        rx={2}
      />

      {/* Percentage text */}
      <text
        x={pillX + pillW - 24}
        y={pillY + 12}
        fontSize={8}
        fontFamily="'Syne Mono', monospace"
        fill={col}
        fillOpacity={0.8}
      >
        {pct}%
      </text>
    </g>
  );
}

// ─── Single detection ─────────────────────────────────────────────────────────

function Detection({ detection, canvasW, canvasH }) {
  const { label, confidence, bbox, color: col } = detection;

  const box = toPixels(bbox, canvasW, canvasH);

  // Skip boxes that are too small to be useful
  if (box.w < MIN_BOX_PX || box.h < MIN_BOX_PX) return null;

  // Label sits above the box — if there's no room, draw it inside
  const labelAbove = box.y >= LABEL_H + 2;

  return (
    <g>
      <Brackets box={box} col={col} />
      {labelAbove
        ? <LabelPill box={box} col={col} label={label} confidence={confidence} canvasW={canvasW} />
        : (
          // Fallback: label inside the top of the box
          <text
            x={box.x + 6}
            y={box.y + 14}
            fontSize={9}
            fontFamily="'Syne Mono', monospace"
            fill={col}
          >
            {label.toUpperCase()} {Math.round(confidence * 100)}%
          </text>
        )
      }
    </g>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * DetectionOverlay
 *
 * Renders an absolutely-positioned SVG over the camera viewport.
 * The SVG fills the full viewport so bbox normalised coordinates
 * map directly to pixel positions without additional transforms.
 *
 * Props:
 *   detections  — array of { label, confidence, bbox, color }
 *   canvasW     — rendered width of the camera viewport (px)
 *   canvasH     — rendered height of the camera viewport (px)
 */
export default function DetectionOverlay({ detections = [], canvasW, canvasH }) {
  // Stable sorted list: highest confidence first so labels stack cleanly
  const sorted = useMemo(
    () => [...detections].sort((a, b) => b.confidence - a.confidence),
    [detections],
  );

  if (!canvasW || !canvasH) return null;

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',   // never intercepts camera mouse events
        zIndex: 10,
        overflow: 'visible',
      }}
      viewBox={`0 0 ${canvasW} ${canvasH}`}
      preserveAspectRatio="none"
    >
      {/* Radar / crosshair — always present, very subtle */}
      <CrossHair cx={canvasW * 0.5} cy={canvasH * 0.45} r={Math.min(canvasW, canvasH) * 0.08} />

      {/* Detection boxes */}
      {sorted.map((d, i) => (
        <Detection
          key={`${d.label}-${i}`}
          detection={d}
          canvasW={canvasW}
          canvasH={canvasH}
        />
      ))}

      {/* Object count badge — bottom-right corner */}
      {sorted.length > 0 && (
        <CountBadge count={sorted.length} canvasW={canvasW} canvasH={canvasH} />
      )}
    </svg>
  );
}

// ─── CrossHair sub-component ──────────────────────────────────────────────────

/**
 * A subtle animated radar ring + crosshair centred on the frame.
 * Acts as a visual anchor showing the "attention centre" of the vision model.
 */
function CrossHair({ cx, cy, r }) {
  return (
    <g opacity={0.18}>
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={r * 1.8} stroke="#3ecfb2" strokeWidth={0.5} fill="none" />
      {/* Inner ring */}
      <circle cx={cx} cy={cy} r={r} stroke="#3ecfb2" strokeWidth={0.5} fill="none" />
      {/* Cross lines */}
      <line x1={cx - r * 0.4} y1={cy} x2={cx + r * 0.4} y2={cy} stroke="#3ecfb2" strokeWidth={0.5} />
      <line x1={cx} y1={cy - r * 0.4} x2={cx} y2={cy + r * 0.4} stroke="#3ecfb2" strokeWidth={0.5} />
    </g>
  );
}

// ─── Count badge sub-component ────────────────────────────────────────────────

function CountBadge({ count, canvasW, canvasH }) {
  const label = `${count} OBJECT${count !== 1 ? 'S' : ''}`;
  const pillW = label.length * 5.5 + 16;
  const pillH = 16;
  const px = canvasW - pillW - 8;
  const py = canvasH - pillH - 8;

  return (
    <g>
      <rect x={px} y={py} width={pillW} height={pillH} fill="#080a0fcc" rx={3} />
      <rect x={px} y={py} width={pillW} height={pillH} fill="none"
        stroke="#3ecfb244" strokeWidth={0.5} rx={3} />
      <text
        x={px + 8} y={py + 11}
        fontSize={8} fontFamily="'Syne Mono', monospace"
        fill="#3ecfb2" letterSpacing="0.08em"
      >
        {label}
      </text>
    </g>
  );
}