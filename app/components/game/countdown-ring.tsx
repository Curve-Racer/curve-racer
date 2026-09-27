'use client';

import { cn } from '@/lib/cn';

export interface CountdownRingProps {
  /** Seconds left in the round, or null while loading. */
  secsLeft: number | null;
  /** Round length in seconds, from the contract. */
  roundSeconds: number;
  progress: number;
  className?: string;
}

/**
 * Countdown ring. The number is the point; the ring is supporting information
 * that lets you read the remaining time peripherally while watching the price.
 */
export function CountdownRing({
  secsLeft,
  roundSeconds,
  progress,
  className,
}: CountdownRingProps) {
  const R = 62;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, progress));

  // Urgency thresholds, not decoration: the last third of a 30s round is
  // where a player is deciding whether to enter.
  const urgent = secsLeft !== null && secsLeft <= 5;
  const warning = secsLeft !== null && secsLeft > 5 && secsLeft <= 10;
  const stroke = urgent ? 'hsl(var(--loss))' : warning ? 'hsl(var(--accent))' : 'hsl(var(--live))';

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg viewBox="0 0 150 150" className="h-[150px] w-[150px] -rotate-90">
        <circle
          cx="75" cy="75" r={R}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth="6"
        />
        <circle
          cx="75" cy="75" r={R}
          fill="none"
          stroke={stroke}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          className="transition-[stroke-dashoffset,stroke] duration-700 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          data-testid="countdown-secs"
          className="tnum text-4xl font-bold leading-none"
          style={{ color: stroke }}
        >
          {secsLeft === null ? '—' : secsLeft}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          sec{secsLeft === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}
