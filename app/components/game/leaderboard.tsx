'use client';

import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';

export interface LeaderRow {
  address: string;
  stake: bigint;
  pnl: bigint | null;
  isMe: boolean;
}

export interface LeaderboardProps {
  rows: LeaderRow[];
  minEntrants: bigint;
  roundSeconds: number;
  className?: string;
}

/**
 * Standings for the round in progress. PnL is computed the same way the
 * contract computes it at settlement, so the number here is the number that
 * decides the pot — not an estimate that disagrees at close.
 */
export function Leaderboard({ rows, minEntrants, roundSeconds, className }: LeaderboardProps) {
  if (rows.length === 0) {
    return (
      <div className={cn('flex flex-col items-center gap-1 py-6 text-center', className)}>
        <p className="text-sm text-muted-foreground">No one has entered yet</p>
        <p className="text-xs text-muted-foreground/70">
          First in gets the round — be the one to move the price.
        </p>
      </div>
    );
  }

  // Best PnL first; entrants who have not entered the round sit at the bottom.
  const sorted = [...rows].sort((a, b) => {
    if (a.pnl === null && b.pnl === null) return 0;
    if (a.pnl === null) return 1;
    if (b.pnl === null) return -1;
    return a.pnl === b.pnl ? 0 : a.pnl > b.pnl ? -1 : 1;
  });

  const short = minEntrants <= BigInt(rows.length);

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Player</span>
        <span className="text-right">Stake</span>
        <span className="w-20 text-right">PnL</span>
      </div>

      {sorted.map((r, i) => (
        <div
          key={r.address}
          className={cn(
            'grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border/50 py-2.5 text-sm last:border-0',
            r.isMe && 'text-primary'
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="tnum w-4 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
            <span className="truncate font-mono text-xs">
              {r.address}
            </span>
            {r.isMe && <Badge className="shrink-0">You</Badge>}
          </span>
          <span className="tnum text-right text-xs text-muted-foreground">
            {formatEth(r.stake)}
          </span>
          <span
            data-testid={`pnl-${r.address}`}
            className={cn(
              'tnum w-20 text-right text-xs font-semibold',
              r.pnl === null
                ? 'text-muted-foreground'
                : r.pnl >= 0n
                  ? 'text-profit'
                  : 'text-loss'
            )}
          >
            {r.pnl === null ? '—' : `${r.pnl >= 0n ? '+' : ''}${formatEth(r.pnl)}`}
          </span>
        </div>
      ))}

      <p className="mt-3 text-xs text-muted-foreground">
        {short
          ? `${rows.length} of ${minEntrants} needed — the round runs ${roundSeconds}s and pays the top PnL.`
          : `Round runs ${roundSeconds}s. Highest PnL takes the pot.`}
      </p>
    </div>
  );
}

/**
 * Format wei as ETH with enough precision to be useful.
 *
 * Small PnL values are the whole point of this game — a 30-second round is
 * decided by fractions of a cent. Truncating to 2dp renders a real gain as
 * "0.00", so keep 4dp and drop trailing zeros only when nothing is lost.
 */
function formatEth(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = ((abs % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
