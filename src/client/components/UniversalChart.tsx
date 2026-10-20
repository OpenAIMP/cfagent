import React, { useEffect, useRef, useState, useId } from "react";

const CHART_FONT = "var(--font-sans)";

export interface ChartPoint {
  x: number;
  y: number;
  label?: string;
}

export interface UniversalChartProps {
  /** Mode of rendering: full interactive payoff, mini card preview, or general line series */
  mode?: "payoff" | "mini_payoff" | "line";
  /** Primary series points (e.g. payoff curve or price series) */
  points: ChartPoint[];
  /** Secondary overlay curve (e.g. intermediate date theoretical PnL curve) */
  secondaryPoints?: ChartPoint[];
  /** Width of SVG canvas (default: 800) */
  width?: number;
  /** Height of SVG canvas (default: 340 for full, 90 for mini) */
  height?: number;
  /** Spot / underlying price marker */
  spotPrice?: number;
  /** Target price marker */
  targetPrice?: number;
  /** Array of breakeven price markers */
  breakevens?: number[];
  /** Current active hover price (if controlled externally) */
  hoverX?: number | null;
  /** Callback when user hovers over a price/x coordinate */
  onHoverXChange?: (x: number | null) => void;
  /** Custom formatter for X axis values (default: $XX.XX) */
  formatX?: (val: number) => string;
  /** Custom formatter for Y axis values (default: $XX) */
  formatY?: (val: number) => string;
  /** Whether to show the crosshair and cursor tooltip (default: true for full payoff) */
  showCrosshair?: boolean;
  /** Previous strategy comparison curve points (dashed gray line) */
  comparisonPoints?: ChartPoint[];
  /** Probability density bell curve points for distribution overlay */
  probabilityOverlayPoints?: Array<{ x: number; density: number; probBelow: number }>;
  /** Hover probability chance below / above spot */
  hoverProbabilities?: { probBelowPct: number; probAbovePct: number } | null;
  /** Additional custom class */
  className?: string;
  /** Accessibility label */
  ariaLabel?: string;
}

/**
 * UniversalChart
 *
 * Single, versatile charting capability for the application.
 * Supports:
 * 1. Options Payoff Graphs (dual-curve: expiration hockey-stick + intermediate Black-Scholes date curve,
 *    split gain/loss gradients above/below zero line, breakeven markers, spot & target lines, crosshair).
 * 2. Probability Distribution Overlay (log-normal bell curve overlay).
 * 3. Strategy Comparison (dashed gray line representing previous trade).
 * 4. Mini Payoff Sparklines (compact strategy discovery cards with green/red zero-anchored fills).
 * 5. Multi-series Line & Time-series charts.
 */
export const UniversalChart: React.FC<UniversalChartProps> = ({
  mode = "payoff",
  points,
  secondaryPoints,
  comparisonPoints,
  probabilityOverlayPoints,
  hoverProbabilities,
  width,
  height,
  spotPrice,
  targetPrice,
  breakevens = [],
  hoverX: externalHoverX,
  onHoverXChange,
  formatX = (val) => `$${val.toFixed(2)}`,
  formatY = (val) => (val >= 0 ? `$${Math.round(val)}` : `-$${Math.abs(Math.round(val))}`),
  showCrosshair = true,
  className = "",
  ariaLabel = "Financial chart",
}) => {
  const uniqueId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [internalHoverX, setInternalHoverX] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.floor(entry.contentRect.width);
      if (nextWidth > 0) setAvailableWidth((current) => current === nextWidth ? current : nextWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const activeHoverX = externalHoverX !== undefined ? externalHoverX : internalHoverX;

  // Recompute the SVG coordinate space from its container. This keeps axis
  // labels readable at narrow widths while keeping full charts inside the
  // available viewport.
  const isMini = mode === "mini_payoff";
  const defaultWidth = width ?? (isMini ? 300 : 800);
  const defaultHeight = height ?? (isMini ? 90 : 340);
  const svgW = isMini ? defaultWidth : availableWidth ?? defaultWidth;
  const svgH = isMini
    ? defaultHeight
    : availableWidth
      ? Math.max(220, Math.min(defaultHeight, (svgW * defaultHeight) / defaultWidth))
      : defaultHeight;

  // If no points, render placeholder
  if (!points || points.length < 2) {
    return (
      <div
        className={`universal-chart-empty ${className}`}
        style={{ width: "100%", height: svgH, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-dim)" }}
      >
        <span>No chart data available</span>
      </div>
    );
  }

  // Padding definitions
  const padL = isMini ? 8 : 62;
  const padR = isMini ? 8 : 28;
  const padT = isMini ? 8 : 22;
  const padB = isMini ? 8 : 34;

  const chartAreaW = Math.max(10, svgW - padL - padR);
  const chartAreaH = Math.max(10, svgH - padT - padB);

  // X Bounds
  const xValues = points.map((p) => p.x);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const xSpan = Math.max(0.001, xMax - xMin);

  // Y Bounds across primary and secondary curves
  const yValuesPrimary = points.map((p) => p.y);
  const yValuesSecondary = secondaryPoints?.map((p) => p.y) || [];
  const allY = [...yValuesPrimary, ...yValuesSecondary, 0];

  const rawYMin = Math.min(...allY);
  const rawYMax = Math.max(...allY);
  const yPad = isMini ? 0 : Math.max(10, (rawYMax - rawYMin) * 0.12);
  const yMin = rawYMin - yPad;
  const yMax = rawYMax + yPad;
  const ySpan = Math.max(0.001, yMax - yMin);

  // Coordinate projections
  const toX = (val: number) => padL + ((val - xMin) / xSpan) * chartAreaW;
  const toY = (val: number) => padT + ((yMax - val) / ySpan) * chartAreaH;

  const zeroY = toY(0);

  // Build SVG path strings
  const primaryLineD = points
    .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.x).toFixed(1)},${toY(pt.y).toFixed(1)}`)
    .join(" ");

  const secondaryLineD = secondaryPoints && secondaryPoints.length > 1
    ? secondaryPoints
        .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.x).toFixed(1)},${toY(pt.y).toFixed(1)}`)
        .join(" ")
    : null;

  // Closed area polygon anchored at zeroY
  const primaryAreaD = `${primaryLineD} L${toX(xMax).toFixed(1)},${zeroY.toFixed(1)} L${toX(xMin).toFixed(1)},${zeroY.toFixed(1)} Z`;

  // Secondary closed area (if intermediate curve is dominant)
  const secondaryAreaD = secondaryLineD
    ? `${secondaryLineD} L${toX(xMax).toFixed(1)},${zeroY.toFixed(1)} L${toX(xMin).toFixed(1)},${zeroY.toFixed(1)} Z`
    : null;

  // Comparison curve (Previous strategy before edits)
  const comparisonLineD = comparisonPoints && comparisonPoints.length > 1
    ? comparisonPoints
        .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.x).toFixed(1)},${toY(pt.y).toFixed(1)}`)
        .join(" ")
    : null;

  // Probability Density Bell Curve Overlay
  const maxDensity = probabilityOverlayPoints && probabilityOverlayPoints.length > 0
    ? Math.max(...probabilityOverlayPoints.map((p) => p.density))
    : 1;

  const probPathD = probabilityOverlayPoints && probabilityOverlayPoints.length > 1
    ? probabilityOverlayPoints
        .map((pt, i) => {
          const x = toX(pt.x);
          const normalizedHeight = (pt.density / Math.max(0.00001, maxDensity)) * (chartAreaH * 0.42);
          const y = (svgH - padB) - normalizedHeight;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : null;

  const probAreaD = probPathD
    ? `${probPathD} L${toX(xMax).toFixed(1)},${(svgH - padB).toFixed(1)} L${toX(xMin).toFixed(1)},${(svgH - padB).toFixed(1)} Z`
    : null;

  // Compute interpolated PnL at hover position
  const getInterpolatedY = (curve: ChartPoint[], x: number) => {
    if (!curve.length) return 0;
    if (x <= curve[0].x) return curve[0].y;
    for (let i = 1; i < curve.length; i++) {
      const p1 = curve[i - 1];
      const p2 = curve[i];
      if (x <= p2.x) {
        const span = p2.x - p1.x || 1;
        return p1.y + ((x - p1.x) / span) * (p2.y - p1.y);
      }
    }
    return curve[curve.length - 1].y;
  };

  const currentHoverX = activeHoverX !== null ? Math.max(xMin, Math.min(xMax, activeHoverX)) : null;
  const hoveredPrimaryY = currentHoverX !== null ? getInterpolatedY(points, currentHoverX) : null;
  const hoveredSecondaryY = currentHoverX !== null && secondaryPoints && secondaryPoints.length > 0
    ? getInterpolatedY(secondaryPoints, currentHoverX)
    : null;

  // Mouse handlers for crosshair tracking
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isMini || !showCrosshair) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (clientX - (padL / svgW) * rect.width) / ((chartAreaW / svgW) * rect.width)));
    const calculatedX = xMin + ratio * xSpan;
    if (onHoverXChange) {
      onHoverXChange(calculatedX);
    } else {
      setInternalHoverX(calculatedX);
    }
  };

  const handleMouseLeave = () => {
    if (isMini) return;
    if (onHoverXChange) {
      onHoverXChange(null);
    } else {
      setInternalHoverX(null);
    }
  };

  // Nice ticks calculation for full payoff mode
  const yTicks = isMini
    ? []
    : [
        yMax,
        yMax * 0.5,
        0,
        yMin * 0.5,
        yMin,
      ].filter((v, i, arr) => arr.indexOf(v) === i);

  const xTicks = isMini
    ? []
    : [
        xMin,
        xMin + xSpan * 0.25,
        spotPrice ?? xMin + xSpan * 0.5,
        xMin + xSpan * 0.75,
        xMax,
      ];

  // Gradients IDs
  const gainGradId = `chart_gain_${uniqueId}`;
  const lossGradId = `chart_loss_${uniqueId}`;
  const clipAboveId = `chart_above_zero_${uniqueId}`;
  const clipBelowId = `chart_below_zero_${uniqueId}`;

  return (
    <div ref={containerRef} className={`universal-chart-container ${isMini ? "mini-chart" : "full-chart"} ${className}`} style={{ position: "relative", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
      <svg
        className="universal-chart-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        // Cap full-size charts to the viewport; the responsive viewBox keeps
        // labels and plot geometry proportional inside that box.
        style={{ width: "100%", height: isMini ? `${svgH}px` : `min(${svgH}px, var(--chart-max-height, 52vh))`, display: "block", overflow: "hidden" }}
      >
        <defs>
          <linearGradient id={gainGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-success)" stopOpacity={isMini ? "0.55" : "0.45"} />
            <stop offset="100%" stopColor="var(--color-success)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={lossGradId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--color-danger)" stopOpacity={isMini ? "0.55" : "0.45"} />
            <stop offset="100%" stopColor="var(--color-danger)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={clipAboveId}>
            <rect x={padL} y={padT} width={chartAreaW} height={Math.max(0, zeroY - padT)} />
          </clipPath>
          <clipPath id={clipBelowId}>
            <rect x={padL} y={zeroY} width={chartAreaW} height={Math.max(0, svgH - padB - zeroY)} />
          </clipPath>
        </defs>

        {/* Grid lines and Y axis ticks (full mode) */}
        {!isMini && yTicks.map((val, idx) => (
          <g key={`y-${idx}`}>
            <line
              x1={padL}
              x2={svgW - padR}
              y1={toY(val)}
              y2={toY(val)}
              stroke="var(--color-border-subtle)"
              strokeDasharray={Math.abs(val) < 0.01 ? "none" : "3 3"}
              strokeWidth={Math.abs(val) < 0.01 ? "1.2" : "1"}
            />
            <text
              x={padL - 10}
              y={toY(val) + 4}
              fill="var(--color-text-muted)"
              fontSize="var(--font-size-caption, 12px)"
              fontFamily={CHART_FONT}
              textAnchor="end"
            >
              {formatY(val)}
            </text>
          </g>
        ))}

        {/* X axis ticks (full mode) */}
        {!isMini && xTicks.map((val, idx) => (
          <text
            key={`x-${idx}`}
            x={toX(val)}
            y={svgH - 12}
            fill="var(--color-text-muted)"
            fontSize="var(--font-size-caption, 12px)"
            fontFamily={CHART_FONT}
            textAnchor="middle"
          >
            {formatX(val)}
          </text>
        ))}

        {/* Shaded Gain Area (Green) */}
        <path d={secondaryAreaD || primaryAreaD} fill={`url(#${gainGradId})`} clipPath={`url(#${clipAboveId})`} />

        {/* Shaded Loss Area (Red) */}
        <path d={secondaryAreaD || primaryAreaD} fill={`url(#${lossGradId})`} clipPath={`url(#${clipBelowId})`} />

        {/* Zero baseline */}
        <line
          x1={padL}
          x2={svgW - padR}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--color-text-muted)"
          strokeWidth={isMini ? "1" : "1.5"}
          strokeDasharray="none"
        />

        {/* Probability Density Bell Curve Overlay (Translucent blue) */}
        {!isMini && probAreaD && (
          <path
            d={probAreaD}
            fill="var(--color-accent-subtle)"
            stroke="var(--color-border-focus)"
            strokeWidth="1.2"
            strokeDasharray="2 2"
          />
        )}

        {/* Previous Strategy Comparison Curve (Dashed gray line) */}
        {!isMini && comparisonLineD && (
          <path
            d={comparisonLineD}
            fill="none"
            stroke="var(--color-text-muted)"
            strokeWidth="2"
            strokeDasharray="5 4"
            opacity="0.85"
          />
        )}

        {/* Primary Expiration Curve (Kinked hockey-stick) */}
        <path
          d={primaryLineD}
          fill="none"
          stroke={secondaryLineD ? "var(--color-text-secondary)" : "var(--color-success)"}
          strokeWidth={secondaryLineD ? "1.5" : isMini ? "2" : "2.5"}
          strokeDasharray={secondaryLineD ? "3 3" : "none"}
        />

        {/* Intermediate Theoretical Curve (Smooth Black-Scholes date curve with time decay) */}
        {secondaryLineD && (
          <path
            d={secondaryLineD}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={isMini ? "2" : "2.5"}
          />
        )}

        {/* Breakeven Reference Lines & Labels */}
        {!isMini && breakevens.map((be, idx) => {
          if (be < xMin || be > xMax) return null;
          const beX = toX(be);
          return (
            <g key={`be-${idx}`}>
              <line
                x1={beX}
                x2={beX}
                y1={padT}
                y2={svgH - padB}
                stroke="var(--color-text-secondary)"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <rect
                x={beX - 32}
                y={padT - 18}
                width={64}
                height={16}
                rx={3}
                fill="var(--color-surface-sunken)"
                stroke="var(--color-border-subtle)"
                strokeWidth="1"
              />
              <text
                x={beX}
                y={padT - 6}
                fill="var(--color-text-primary)"
                fontSize="var(--font-size-micro, 10px)"
                fontFamily={CHART_FONT}
                fontWeight="bold"
                textAnchor="middle"
              >
                BE: {formatX(be)}
              </text>
            </g>
          );
        })}

        {/* Spot Price Reference Marker */}
        {spotPrice !== undefined && spotPrice >= xMin && spotPrice <= xMax && (
          <g>
            <line
              x1={toX(spotPrice)}
              x2={toX(spotPrice)}
              y1={padT}
              y2={svgH - padB}
              stroke="var(--color-accent)"
              strokeWidth={isMini ? "1" : "1.5"}
              strokeDasharray="4 2"
            />
            {!isMini && (
              <text
                x={toX(spotPrice)}
                y={padT + 12}
                fill="var(--color-accent)"
                fontSize="var(--font-size-caption, 12px)"
                fontWeight="bold"
                fontFamily={CHART_FONT}
                textAnchor="middle"
              >
                ${spotPrice.toFixed(2)}
              </text>
            )}
          </g>
        )}

        {/* Target Price Marker */}
        {!isMini && targetPrice !== undefined && targetPrice >= xMin && targetPrice <= xMax && (
          <g>
            <line
              x1={toX(targetPrice)}
              x2={toX(targetPrice)}
              y1={padT}
              y2={svgH - padB}
              stroke="var(--color-warning)"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
            <text
              x={toX(targetPrice)}
              y={padT + 26}
              fill="var(--color-warning)"
              fontSize="var(--font-size-caption, 12px)"
              fontWeight="bold"
              fontFamily={CHART_FONT}
              textAnchor="middle"
            >
              Target: ${targetPrice.toFixed(2)}
            </text>
          </g>
        )}

        {/* Interactive Crosshair & Cursor Point (full mode) */}
        {!isMini && showCrosshair && currentHoverX !== null && (
          <g>
            <line
              x1={toX(currentHoverX)}
              x2={toX(currentHoverX)}
              y1={padT}
              y2={svgH - padB}
              stroke="var(--color-text-secondary)"
              strokeWidth="1.2"
              strokeDasharray="2 2"
            />
            {/* Dot on active curve */}
            {hoveredSecondaryY !== null ? (
              <circle
                cx={toX(currentHoverX)}
                cy={toY(hoveredSecondaryY)}
                r="4.5"
                fill="var(--color-accent)"
                stroke="var(--color-text-inverse)"
                strokeWidth="1.5"
              />
            ) : hoveredPrimaryY !== null ? (
              <circle
                cx={toX(currentHoverX)}
                cy={toY(hoveredPrimaryY)}
                r="4.5"
                fill={hoveredPrimaryY >= 0 ? "var(--color-success)" : "var(--color-danger)"}
                stroke="var(--color-text-inverse)"
                strokeWidth="1.5"
              />
            ) : null}

            {/* Hover Tooltip Badge on Cursor */}
            <g
              transform={`translate(${Math.min(
                svgW - padR - 100,
                Math.max(padL + 10, toX(currentHoverX) + 12)
              )}, ${Math.min(
                svgH - padB - 50,
                Math.max(padT + 10, toY(hoveredSecondaryY ?? hoveredPrimaryY ?? 0) - 30)
              )})`}
            >
              <rect
                x="0"
                y="0"
                width={hoverProbabilities ? "134" : "120"}
                height={hoverProbabilities ? "62" : "46"}
                rx="6"
                fill="var(--color-surface-sunken)"
                stroke="var(--color-border-focus)"
                strokeWidth="1"
              />
              <text x="8" y="16" fill="var(--color-text-muted)" fontSize="var(--font-size-caption, 12px)" fontFamily={CHART_FONT}>
                Price: <tspan fill="var(--color-text-primary)" fontWeight="bold">{formatX(currentHoverX)}</tspan>
              </text>
              <text x="8" y="34" fill="var(--color-text-muted)" fontSize="var(--font-size-caption, 12px)" fontFamily={CHART_FONT}>
                P/L:{" "}
                <tspan
                  fill={(hoveredSecondaryY ?? hoveredPrimaryY ?? 0) >= 0 ? "var(--color-success)" : "var(--color-danger)"}
                  fontWeight="bold"
                >
                  {formatY(hoveredSecondaryY ?? hoveredPrimaryY ?? 0)}
                </tspan>
              </text>
              {hoverProbabilities && (
                <text x="8" y="50" fill="var(--color-accent)" fontSize="var(--font-size-micro, 10px)" fontFamily={CHART_FONT} fontWeight="var(--font-weight-bold, 700)">
                  {`← ${hoverProbabilities.probBelowPct}% | ${hoverProbabilities.probAbovePct}% →`}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
};
