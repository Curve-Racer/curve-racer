'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWalletClient, custom, parseEther, type Address } from 'viem';
import { publicClient, GAME_ADDRESS, CURVE_ADDRESS, activeChain, isGameDeployed, hasExplorer, explorerTx } from '@/lib/chain';
import { CURVE_RACER_ABI, VIBE_CURVE_ABI } from '@/lib/abi';
import {
  Phase, readRoundState, readCurrentRoundId, readEntrants, readEntry, readConfig,
  readSecondsRemaining, formatSpotNano, type RoundState, type Entry,
} from '@/lib/game';
import { roundProgress, statusPill, isRoundOpen, type PlayState } from '@/lib/play';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, LiveDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountdownRing } from '@/components/game/countdown-ring';
import { Sparkline } from '@/components/game/sparkline';
import { JoinPanel } from '@/components/game/join-panel';
import { Leaderboard, type LeaderRow } from '@/components/game/leaderboard';
import { cn } from '@/lib/cn';

const ZERO = 0n;

/** How many price samples the sparkline keeps. At 1s that is a full round. */
const HISTORY = 60;

interface Player {
  stake: bigint;
  refundClaimed: boolean;
  paidOut: boolean;
}

interface EntrantRow {
  address: Address;
  stake: bigint;
  paidOut: boolean;
  pnl: bigint | null;
}

/**
 * The game board.
 *
 * Every string and every "can the player act" decision comes from lib/play.ts,
 * which is unit tested. This component owns data fetching and layout, nothing
 * more. That split is the point: all three UI bugs that shipped here were copy
 * or conditions computed inline in JSX, free to contradict the state rendered
 * beside them.
 */
export default function GameBoard() {
  const [account, setAccount] = useState<Address | null>(null);
  const [roundId, setRoundId] = useState<bigint>(ZERO);
  // Long-lived ticker needs the live round id without being rebuilt each tick.
  const roundIdRef = useRef(roundId);
  roundIdRef.current = roundId;

  const [round, setRound] = useState<RoundState | null>(null);
  const [entrants, setEntrants] = useState<EntrantRow[]>([]);
  const [myEntry, setMyEntry] = useState<Player | null>(null);
  const [spot, setSpot] = useState<bigint>(ZERO);
  // Rolling price history. A 30-second round is decided by the shape of the
  // move, which a single headline number cannot express.
  const [history, setHistory] = useState<bigint[]>([]);
  const [entryPrice, setEntryPrice] = useState<bigint>(ZERO);
  const [cfg, setCfg] = useState<{
    roundBlocks: bigint; roundSeconds: bigint; minEntrants: bigint; rakeBps: bigint;
    assetForWager: Address; custodyAvailable: boolean; treasury: Address;
  } | null>(null);
  const [stakeInput, setStakeInput] = useState('0.01');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState('');
  // null means "not read yet" — the old code started at 0, which rendered as
  // "closed" before the first poll landed.
  const [secsLeft, setSecsLeft] = useState<number | null>(null);
  const [balanceEth, setBalanceEth] = useState<string | null>(null);

  const connect = useCallback(async () => {
    const eth = (window as unknown as {
      ethereum?: { request: (a: object) => Promise<string[]> };
    }).ethereum;
    if (!eth) { setError('No browser wallet found. Install MetaMask to play.'); return; }
    try {
      const [a] = await eth.request({ method: 'eth_requestAccounts' });
      setAccount(a as Address);
      setError('');
    } catch { setError('Wallet connection rejected.'); }
  }, []);

  const refresh = useCallback(async () => {
    if (!isGameDeployed) return;
    try {
      const id = await readCurrentRoundId();
      setRoundId(id);
      const st: RoundState = await readRoundState(id);
      setRound(st);
      setEntryPrice(st.entryPriceWad);

      // Read every entrant's stake so the table shows real numbers, and
      // compute each PnL the same way the contract will at settlement.
      const list = await readEntrants(id);
      const rows = await Promise.all(
        list.map(async (address) => {
          const e: Entry = await readEntry(id, address);
          return {
            address,
            stake: e.stake,
            paidOut: e.paidOut,
            pnl:
              e.stake > ZERO && st.entryPriceWad > ZERO && spot > ZERO
                ? (e.stake * (spot - st.entryPriceWad)) / st.entryPriceWad
                : null,
          } satisfies EntrantRow;
        })
      );
      setEntrants(rows);

      if (account) {
        const e: Entry = await readEntry(id, account);
        setMyEntry({ stake: e.stake, refundClaimed: e.refundClaimed, paidOut: e.paidOut });
        const b = await publicClient.getBalance({ address: account });
        setBalanceEth((Number(b) / 1e18).toFixed(4));
      } else {
        setMyEntry(null);
        setBalanceEth(null);
      }
    } catch (e) { setError(String(e).slice(0, 160)); }
    // spot is deliberately not a dependency: it polls on its own and re-reading
    // every entrant on each tick would hammer the RPC. The effect below
    // recomputes PnL as the price moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Ref indirection so the 1s ticker always calls the CURRENT refresh. Without
  // it the timer holds the copy captured on first render, closing over a null
  // account, and myEntry can never update — the bug that locked a refunded
  // player on "You're in this round" forever. See __tests__/ticker.test.tsx.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!isGameDeployed) return;
    readConfig().then(setCfg).catch(() => {});
    refresh();
  }, [refresh]);

  // Live curve price, sampled for the headline and the sparkline.
  // CURVE_ADDRESS, not GAME_ADDRESS: the game contract has no spotPriceWad,
  // so reading it from the game silently yielded 0 and rendered as a dash with
  // a nonsense "▼ 100% since round open". The curve is a vibe/vibe contract.
  useEffect(() => {
    if (!isGameDeployed) return;
    let alive = true;
    const tick = async () => {
      try {
        const p = (await publicClient.readContract({
          address: CURVE_ADDRESS, abi: VIBE_CURVE_ABI, functionName: 'spotPriceWad',
        })) as bigint;
        if (!alive || p === ZERO) return;
        setSpot(p);
        setHistory((h) => {
          const next = [...h, p];
          return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
        });
      } catch { /* curve not wired yet */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Recompute projected PnL for everyone as the price moves, without re-reading
  // the chain — stakes are fixed for the round once entered.
  useEffect(() => {
    if (!round || round.entryPriceWad === ZERO || spot === ZERO) return;
    setEntrants((rows) =>
      rows.map((r) => ({
        ...r,
        pnl: r.stake > ZERO
          ? (r.stake * (spot - round.entryPriceWad)) / round.entryPriceWad
          : null,
      }))
    );
  }, [spot, round]);

  // Countdown plus the round-change watcher. Rounds advance on their own via
  // the keeper now, so watching only secondsRemaining() would leave this
  // component holding a round that no longer exists.
  useEffect(() => {
    if (!isGameDeployed) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await readSecondsRemaining();
        if (!alive) return;
        setSecsLeft(Number(s));
        const id = await readCurrentRoundId();
        if (alive && id !== roundIdRef.current) {
          // Clear the chart at the boundary so the sparkline shows the round in
          // progress rather than a smear across several.
          setHistory([]);
          await refreshRef.current();
        }
      } catch { /* keep the last good value */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const sendTx = useCallback(
    async (fn: 'enter' | 'settle', args: unknown[], value?: bigint) => {
      if (!account) throw new Error('Connect a wallet first.');
      const eth = (window as unknown as { ethereum?: unknown }).ethereum;
      if (!eth) throw new Error('No browser wallet found.');
      // @ts-expect-error injected provider shape
      const wallet = createWalletClient({ chain: activeChain, transport: custom(eth) });
      const hash = await wallet.writeContract({
        address: GAME_ADDRESS, abi: CURVE_RACER_ABI,
        functionName: fn as never, args: args as never, value, account,
      } as never);
      setStatus(`${fn} submitted…`);
      setLastTx(hash as `0x${string}`);
      await publicClient.waitForTransactionReceipt({
        hash: hash as `0x${string}`, timeout: 60_000,
      });
      setStatus(`${fn} confirmed`);
      await refreshRef.current();
    },
    [account]
  );

  const enter = useCallback(async () => {
    setBusy(true); setError('');
    try { await sendTx('enter', [], parseEther(stakeInput || '0')); }
    catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(false); }
  }, [sendTx, stakeInput]);

  const settle = useCallback(async () => {
    setBusy(true); setError('');
    try { await sendTx('settle', []); }
    catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(false); }
  }, [sendTx]);

  const projected = useMemo(() => {
    if (!myEntry || myEntry.stake === ZERO || entryPrice === ZERO || spot === ZERO) return null;
    return (myEntry.stake * (spot - entryPrice)) / entryPrice;
  }, [myEntry, spot, entryPrice]);

  if (!isGameDeployed) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm">
        Game contract not deployed. Set <code>NEXT_PUBLIC_GAME_ADDRESS</code> and restart.
      </div>
    );
  }

  const roundSeconds = cfg ? Number(cfg.roundSeconds) : 30;
  const pill = statusPill(round?.phase ?? null, secsLeft);
  const open = isRoundOpen(round?.phase ?? null, secsLeft);
  const canSettle = round?.phase === Phase.Open && secsLeft === 0;

  const delta = entryPrice > ZERO ? spot - entryPrice : ZERO;
  const deltaPct = entryPrice > ZERO ? Number((delta * 10_000n) / entryPrice) / 100 : 0;

  const playState: PlayState = {
    account, busy, roundId,
    phase: round?.phase ?? null,
    secsLeft, myEntry,
    // The entry was read for the round currently on screen, so it always
    // matches. Stating it explicitly keeps the tested guard meaningful.
    entryRoundId: roundId,
    entrants: entrants.length,
    minEntrants: cfg?.minEntrants ?? 2n,
  };

  const leaderRows: LeaderRow[] = entrants.map((e) => ({
    address: `${e.address.slice(0, 6)}…${e.address.slice(-4)}`,
    stake: e.stake,
    pnl: e.pnl,
    isMe: account ? e.address.toLowerCase() === account.toLowerCase() : false,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/racer.png"
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 rounded-lg"
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Curve Racer</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {roundSeconds}-second rounds. Stake ETH, ride the price, highest PnL takes the pot.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={pill.tone} className="gap-2">
            {pill.tone === 'live' && <LiveDot />}
            {pill.text}
          </Badge>
          <Badge>Round {roundId.toString()}</Badge>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* ---------------- market ---------------- */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Curve price</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="tnum text-4xl font-bold leading-none">
                    {spot > ZERO ? formatSpotNano(spot) : '—'}
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    nano-ETH per token
                  </div>
                  {entryPrice > ZERO && spot > ZERO && (
                    <div
                      className={cn(
                        'tnum mt-3 flex items-center gap-1.5 text-sm font-semibold',
                        // Flat is a real state. Showing a green up-arrow for an
                        // unchanged price claims a gain that did not happen.
                        delta > ZERO && 'text-profit',
                        delta < ZERO && 'text-loss',
                        delta === ZERO && 'text-muted-foreground'
                      )}
                    >
                      {delta > ZERO ? '▲' : delta < ZERO ? '▼' : '—'}{' '}
                      {delta === ZERO ? 'unchanged' : `${Math.abs(deltaPct).toFixed(2)}%`}
                      <span className="text-xs font-normal text-muted-foreground">
                        since round open
                      </span>
                    </div>
                  )}
                </div>
                <CountdownRing
                  secsLeft={secsLeft}
                  roundSeconds={roundSeconds}
                  progress={roundProgress(secsLeft, roundSeconds)}
                />
              </div>

              <div className="mt-5">
                <Sparkline
                  points={history}
                  width={560}
                  height={72}
                  entryPrice={entryPrice > ZERO ? entryPrice : null}
                  className="h-[72px] w-full"
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-xs sm:grid-cols-4">
                <Stat label="Entry price" value={entryPrice > ZERO ? formatSpotNano(entryPrice) : '—'} />
                <Stat label="Your stake" value={myEntry?.stake ? `${fmt(myEntry.stake)} ETH` : '—'} />
                <Stat
                  label="Unrealised PnL"
                  value={
                    projected === null
                      ? '—'
                      : `${projected >= ZERO ? '+' : '-'}${fmt(projected < ZERO ? -projected : projected)} ETH`
                  }
                  tone={projected === null ? 'default' : projected >= ZERO ? 'profit' : 'loss'}
                />
                <Stat label="Rake" value={cfg ? `${Number(cfg.rakeBps) / 100}%` : '—'} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Standings</CardTitle>
            </CardHeader>
            <CardContent>
              <Leaderboard
                rows={leaderRows}
                minEntrants={cfg?.minEntrants ?? 2n}
                roundSeconds={roundSeconds}
              />
            </CardContent>
          </Card>
        </div>

        {/* ---------------- play ---------------- */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Play</CardTitle>
            </CardHeader>
            <CardContent>
              <JoinPanel
                state={playState}
                stakeInput={stakeInput}
                onStakeChange={setStakeInput}
                onConnect={connect}
                onEnter={enter}
                onSettle={settle}
                busy={busy}
                canSettle={canSettle}
                walletBalanceEth={balanceEth}
              />
              {status && (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  {status}
                  {lastTx && hasExplorer && (
                    <a
                      href={explorerTx(lastTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-primary hover:underline"
                    >
                      view tx
                    </a>
                  )}
                </p>
              )}
            </CardContent>
          </Card>

          {!open && canSettle && (
            <Button variant="outline" onClick={settle} disabled={busy} fullWidth>
              Settle round {roundId.toString()} &amp; open next
            </Button>
          )}

          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs leading-relaxed text-muted-foreground">
              <p>
                Each round runs {roundSeconds} seconds. Your stake is priced at the
                curve&apos;s spot price when the round opens, and PnL is measured
                against that same price for everyone.
              </p>
              <p>
                At close the contract pays the pot to the highest PnL. Ties split
                evenly.
              </p>
              <p>
                Under {cfg ? cfg.minEntrants.toString() : '2'} entrants the round is
                voided and refunded in full — you cannot lose to an empty room.
              </p>
              <p>
                Rounds close themselves: a keeper settles each expired round, and
                you can settle manually at any time.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label, value, tone = 'default',
}: { label: string; value: string; tone?: 'default' | 'profit' | 'loss' }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'tnum mt-0.5 text-sm font-semibold',
          tone === 'profit' && 'text-profit',
          tone === 'loss' && 'text-loss'
        )}
      >
        {value}
      </div>
    </div>
  );
}

function fmt(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}
