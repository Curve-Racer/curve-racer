'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { joinLabel, canEnter, showsInRound, type PlayState } from '@/lib/play';
import { cn } from '@/lib/cn';

export interface JoinPanelProps {
  state: PlayState;
  stakeInput: string;
  onStakeChange: (v: string) => void;
  onConnect: () => void;
  onEnter: () => void;
  onSettle: () => void;
  busy: boolean;
  /** True when the contract clock has hit zero on an open round. */
  canSettle: boolean;
  walletBalanceEth: string | null;
}

/**
 * The play surface. Every string here comes from lib/play.ts, which is unit
 * tested — the component decides layout, not meaning. That split is the whole
 * point: the three bugs that shipped were all copy computed inline in JSX,
 * able to contradict the state rendered beside it.
 */
export function JoinPanel({
  state,
  stakeInput,
  onStakeChange,
  onConnect,
  onEnter,
  onSettle,
  busy,
  canSettle,
  walletBalanceEth,
}: JoinPanelProps) {
  const label = joinLabel(state);
  const inRound = showsInRound(state.roundId, state.myEntry, state.entryRoundId ?? null);
  const stake = state.myEntry?.stake ?? 0n;

  return (
    <div className="flex flex-col gap-3">
      {!state.account ? (
        <>
          <p className="text-sm text-muted-foreground">
            Connect a wallet to stake ETH and enter the round.
          </p>
          <Button onClick={onConnect} fullWidth>
            Connect wallet
          </Button>
        </>
      ) : (
        <>
          {inRound ? (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center justify-between">
                <Badge tone="live">In the round</Badge>
                <span className="tnum text-sm font-semibold">
                  {formatEth(stake)} ETH
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Highest PnL at close wins the pot.
                {state.myEntry?.paidOut && ' Paid out to your wallet.'}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <label htmlFor="stake" className="text-sm font-medium">
                  Stake
                </label>
                {walletBalanceEth && (
                  <span className="tnum text-xs text-muted-foreground">
                    Balance {walletBalanceEth} ETH
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="stake"
                  type="number"
                  step="0.001"
                  min="0"
                  value={stakeInput}
                  onChange={(e) => onStakeChange(e.target.value)}
                  className="tnum h-11 w-full rounded-md border border-input bg-background px-3 pr-12 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                  ETH
                </span>
              </div>

              <Button
                onClick={onEnter}
                disabled={label.disabled}
                loading={state.busy}
                fullWidth
                size="lg"
              >
                {label.text}
              </Button>

              {label.note && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {label.note}
                </p>
              )}
            </>
          )}

          {canSettle && (
            <Button onClick={onSettle} variant="outline" size="sm" disabled={busy} fullWidth>
              Settle round {state.roundId.toString()}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}
