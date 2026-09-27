'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/cn';

export interface SparklineProps {
  /** Oldest first. Values are WAD (1e18-scaled) prices. */
  points: bigint[];
  width?: number;
  height?: number;
  className?: string;
  /** The entry price of the viewer, drawn as a reference line. */
  entryPrice?: bigint | null;
  /** Fill under the line, tinted by the overall direction. */
  showArea?: boolean;
}

/**
 * Price sparkline.
 *
 * This is the game: a 30-second round won by whoever's price move beats the
 * field's. A single number cannot express that, so the shape of the move
 * matters more than its current value. Entries are WAD, so all arithmetic
 * stays in bigint until the final scale — never float, which would lose
 * precision on exactly the small deltas that decide a round.
 */
export function Sparkline({
  points,
  width = 320,
  height = 64,
  className,
  entryPrice = null,
  showArea = true,
}: SparklineProps) {
  const geometry = useMemo(() => {
    const pts = points.filter((p) => p > 0n);
    if (pts.length < 2) return null;

    let min = pts[0];
    let max = pts[0];
    for (const p of pts) {
      if (p < min) min = p;
      if (p > max) max = p;
    }
    // A flat series would divide by zero; give it a nominal range.
    if (max === min) { max = min + 1n; }

    // A little headroom so the line never touches the edges.
    const span = max - min;
    const pad = span / 20n;
    const lo = min - pad;
    const hi = max + pad;
    const range = hi - lo;

    const x = (i: number) => (i / (pts.length - 1)) * width;
    const y = (v: bigint) =>
      height - (Number(((v - lo) * 1000n) / range) / 1000) * height;

    const line = pts.map((p, i) => `${x(i).toFixed(2)},${y(p).toFixed(2)}`).join(' ');
    const area = `0,${height} ${line} ${width},${height}`;
    const rising = pts[pts.length - 1] >= pts[0];
    const entryY = entryPrice && entryPrice > 0n && entryPrice >= lo && entryPrice <= hi
      ? y(entryPrice)
      : null;

    return { line, area, rising, entryY, first: pts[0], last: pts[pts.length - 1],
             lastX: x(pts.length - 1), lastY: y(pts[pts.length - 1]) };
  }, [points, width, height, entryPrice]);

  if (!geometry) {
    return (
      <div
        className={cn('flex items-center justify-center text-xs text-muted-foreground', className)}
        style={{ width, height }}
      >
        Collecting price…
      </div>
    );
  }

  const stroke = geometry.rising ? 'hsl(var(--profit))' : 'hsl(var(--loss))';
  const gid = `spark-${geometry.rising ? 'up' : 'down'}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={`Price ${geometry.rising ? 'rising' : 'falling'} over the last samples`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {showArea && <polygon points={geometry.area} fill={`url(#${gid})`} />}

      {/* Baseline: without it a flat series renders as a bare rule floating in
          the card and reads as a divider rather than a chart. */}
      <line
        x1="0" x2={width} y1={height - 1} y2={height - 1}
        stroke="hsl(var(--border))" strokeWidth="1"
      />

      {geometry.entryY !== null && (
        <line
          x1="0" x2={width}
          y1={geometry.entryY} y2={geometry.entryY}
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.6"
        />
      )}

      <polyline
        points={geometry.line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Current-value marker, so the eye can find "now" on the line. */}
      <circle
        cx={geometry.lastX - 2}
        cy={geometry.lastY}
        r="2.75"
        fill={stroke}
      />
    </svg>
  );
}
