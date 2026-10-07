import React, { useState, useId } from "react";

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
 * 2. Mini Payoff Sparklines (compact strategy discovery cards with green/red zero-anchored fills).
 * 3. Multi-series Line & Time-series charts.
 */
export const UniversalChart: React.FC<UniversalChartProps> = ({
  mode = "payoff",
  points,
  secondaryPoints,
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

  const activeHoverX = externalHoverX !== undefined ? externalHoverX : internalHoverX;

  // Set default dimensions based on mode
  const svgW = width ?? (mode === "mini_payoff" ? 300 : 800);
  const svgH = height ?? (mode === "mini_payoff" ? 90 : 340);

  // If no points, render placeholder
  if (!points || points.length < 2) {
    return (
      <div
        className={`universal-chart-empty ${className}`}
        style={{ width: "100%", height: svgH, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}
      >
        <span>No chart data available</span>
      </div>
    );
  }

  // Padding definitions
  const isMini = mode === "mini_payoff";
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
    <div className={`universal-chart-container ${isMini ? "mini-chart" : "full-chart"} ${className}`} style={{ position: "relative", width: "100%" }}>
      <svg
        className="universal-chart-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gainGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity={isMini ? "0.55" : "0.45"} />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={lossGradId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#ef4444" stopOpacity={isMini ? "0.55" : "0.45"} />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
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
              stroke="rgba(255, 255, 255, 0.08)"
              strokeDasharray={Math.abs(val) < 0.01 ? "none" : "3 3"}
              strokeWidth={Math.abs(val) < 0.01 ? "1.2" : "1"}
            />
            <text
              x={padL - 10}
              y={toY(val) + 4}
              fill="#94a3b8"
              fontSize="11"
              fontFamily="monospace"
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
            fill="#94a3b8"
            fontSize="11"
            fontFamily="monospace"
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
          stroke="rgba(255, 255, 255, 0.35)"
          strokeWidth={isMini ? "1" : "1.5"}
          strokeDasharray="none"
        />

        {/* Primary Expiration Curve (Kinked hockey-stick) */}
        <path
          d={primaryLineD}
          fill="none"
          stroke={secondaryLineD ? "rgba(255, 255, 255, 0.45)" : "#22c55e"}
          strokeWidth={secondaryLineD ? "1.5" : isMini ? "2" : "2.5"}
          strokeDasharray={secondaryLineD ? "3 3" : "none"}
        />

        {/* Intermediate Theoretical Curve (Smooth Black-Scholes date curve with time decay) */}
        {secondaryLineD && (
          <path
            d={secondaryLineD}
            fill="none"
            stroke="#38bdf8"
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
                stroke="#cbd5e1"
                strokeWidth="1.2"
                strokeDasharray="3 3"
              />
              <rect
                x={beX - 32}
                y={padT - 18}
                width={64}
                height={16}
                rx={3}
                fill="#1e293b"
                stroke="#64748b"
                strokeWidth="1"
              />
              <text
                x={beX}
                y={padT - 6}
                fill="#f8fafc"
                fontSize="9.5"
                fontFamily="monospace"
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
              stroke="#06b6d4"
              strokeWidth={isMini ? "1" : "1.5"}
              strokeDasharray="4 2"
            />
            {!isMini && (
              <text
                x={toX(spotPrice)}
                y={padT + 12}
                fill="#06b6d4"
                fontSize="11"
                fontWeight="bold"
                fontFamily="monospace"
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
              stroke="#f97316"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
            <text
              x={toX(targetPrice)}
              y={padT + 26}
              fill="#f97316"
              fontSize="11"
              fontWeight="bold"
              fontFamily="monospace"
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
              stroke="rgba(255, 255, 255, 0.7)"
              strokeWidth="1.2"
              strokeDasharray="2 2"
            />
            {/* Dot on active curve */}
            {hoveredSecondaryY !== null ? (
              <circle
                cx={toX(currentHoverX)}
                cy={toY(hoveredSecondaryY)}
                r="4.5"
                fill="#38bdf8"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            ) : hoveredPrimaryY !== null ? (
              <circle
                cx={toX(currentHoverX)}
                cy={toY(hoveredPrimaryY)}
                r="4.5"
                fill={hoveredPrimaryY >= 0 ? "#22c55e" : "#ef4444"}
                stroke="#ffffff"
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
                width="120"
                height="46"
                rx="6"
                fill="#090e1a"
                stroke="rgba(56, 189, 248, 0.5)"
                strokeWidth="1"
              />
              <text x="8" y="16" fill="#94a3b8" fontSize="10" fontFamily="sans-serif">
                Price: <tspan fill="#ffffff" fontWeight="bold">{formatX(currentHoverX)}</tspan>
              </text>
              <text x="8" y="34" fill="#94a3b8" fontSize="10" fontFamily="sans-serif">
                P/L:{" "}
                <tspan
                  fill={(hoveredSecondaryY ?? hoveredPrimaryY ?? 0) >= 0 ? "#22c55e" : "#ef4444"}
                  fontWeight="bold"
                >
                  {formatY(hoveredSecondaryY ?? hoveredPrimaryY ?? 0)}
                </tspan>
              </text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
};
