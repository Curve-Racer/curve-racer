'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createWalletClient, custom, http, parseEther, type Address } from 'viem';
import { publicClient, GAME_ADDRESS, CURVE_ADDRESS, activeChain, isGameDeployed, hasExplorer, explorerTx } from '@/lib/chain';
import { CURVE_RACER_ABI, VIBE_CURVE_ABI } from '@/lib/abi';
import {
  Phase, readRoundState, readCurrentRoundId, readEntrants, readEntry, readConfig, readPnl,
  readSecondsRemaining,
  type RoundState, type Entry,
} from '@/lib/game';
import { formatEth, formatSpot, shortAddress } from '@/lib/game';

// Round timing is decided on-chain against wall-clock timestamps, not block
// counts — see ROUND_SECONDS / secondsRemaining() in CurveRacer.sol. The old
// MS_PER_BLOCK constant assumed 100ms blocks; this testnet measures ~180ms, so
// block-derived time ran ~80% slow and the countdown appeared frozen. Nothing
// in the client converts blocks to time any more.
const ZERO = 0n;

interface Player {
  stake: bigint;
  refundClaimed: boolean;
  paidOut: boolean;
}

interface EntrantRow {
  address: Address;
  stake: bigint;
  pnl: bigint | null;
  paidOut: boolean;
}

export default function GameBoard() {
  const [account, setAccount] = useState<Address | null>(null);
  const [roundId, setRoundId] = useState<bigint>(ZERO);
  const [round, setRound] = useState<RoundState | null>(null);
  const [entrants, setEntrants] = useState<EntrantRow[]>([]);
  const [myEntry, setMyEntry] = useState<Player | null>(null);
  const [spot, setSpot] = useState<bigint>(ZERO);
  const [entryPrice, setEntryPrice] = useState<bigint>(ZERO);
  const [cfg, setCfg] = useState<{
    roundBlocks: bigint; roundSeconds: bigint; minEntrants: bigint; rakeBps: bigint;
    assetForWager: Address; custodyAvailable: boolean; treasury: Address;
  } | null>(null);
  const [stakeInput, setStakeInput] = useState('0.01');
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string>('');
  // Seconds left, read from the contract. null means "not read yet" — the
  // old code started at 0, which rendered as "closed" before the first poll.
  const [secsLeft, setSecsLeft] = useState<number | null>(null);

  const curveAddress = useMemo(() => CURVE_ADDRESS, []);

  // --- wallet -------------------------------------------------------------
  const connect = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: { request: (a: object) => Promise<string[]> } }).ethereum;
    if (!eth) { setError('No browser wallet found. Install MetaMask to play.'); return; }
    try {
      const [a] = await eth.request({ method: 'eth_requestAccounts' });
      setAccount(a as Address);
      setError('');
    } catch { setError('Wallet connection rejected.'); }
  }, []);

  // --- reads --------------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!isGameDeployed) return;
    try {
      const id = await readCurrentRoundId();
      setRoundId(id);
      const st = await readRoundState(id);
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
              e.stake > ZERO && st.entryPriceWad > ZERO
                ? (e.stake * (spot - st.entryPriceWad)) / st.entryPriceWad
                : null,
          } satisfies EntrantRow;
        })
      );
      setEntrants(rows);

      if (account) {
        const e: Entry = await readEntry(id, account);
        setMyEntry({ stake: e.stake, refundClaimed: e.refundClaimed, paidOut: e.paidOut });
      }
    } catch (e) { setError(String(e).slice(0, 160)); }
    // spot is intentionally not a dependency: it updates on its own 2s poll and
    // re-reading every entrant on each tick would hammer the RPC.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  useEffect(() => {
    if (!isGameDeployed) return;
    readConfig().then(setCfg).catch(() => {});
    refresh();
  }, [refresh]);

  // Live curve price. The game is priced entirely off the curve, so this is
  // the heartbeat of the whole UI. VIBE_CURVE_ABI, not the game ABI: the curve
  // is a vibe/vibe contract, not ours.
  useEffect(() => {
    if (!isGameDeployed) return;
    let alive = true;
    const tick = async () => {
      try {
        const p = (await publicClient.readContract({
          address: curveAddress, abi: VIBE_CURVE_ABI,
          functionName: 'spotPriceWad',
        })) as bigint;
        if (alive) setSpot(p);
      } catch { /* curve not wired yet */ }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [curveAddress]);

  // Recompute projected PnL for everyone as the price moves, without
  // re-reading the chain — stakes are fixed for the round once entered.
  useEffect(() => {
    if (!round || round.entryPriceWad === ZERO) return;
    setEntrants((rows) =>
      rows.map((r) => ({
        ...r,
        pnl: r.stake > ZERO ? (r.stake * (spot - round.entryPriceWad)) / round.entryPriceWad : null,
      }))
    );
  }, [spot, round]);

  // Countdown ticker. Reads secondsRemaining() from the contract rather than
  // subtracting block numbers locally — the RPC head and the round's stored
  // closeBlock are not on a comparable scale, and the local arithmetic made a
  // live round look closed. 1s cadence matches the ~30s round.
  useEffect(() => {
    if (!isGameDeployed) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await readSecondsRemaining();
        if (alive) setSecsLeft(Number(s));
      } catch { /* keep the last good value */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // --- derived ------------------------------------------------------------
  // Progress is a fraction of the round's wall-clock length, read from the
  // contract. The old version reconstructed time from the block count with a
  // hardcoded 100ms/block, which is wrong on this chain and made the bar crawl.
  const totalSecs = cfg ? Number(cfg.roundSeconds) : 30;
  const secs = secsLeft ?? 0;
  const elapsed = Math.min(totalSecs, Math.max(0, totalSecs - secs));
  const progress = totalSecs ? (elapsed / totalSecs) * 100 : 0;

  const projected = useMemo(() => {
    if (!myEntry || myEntry.stake === ZERO || entryPrice === ZERO) return null;
    return (myEntry.stake * (spot - entryPrice)) / entryPrice;
  }, [myEntry, spot, entryPrice]);

  // Open = the contract says Open AND its own clock has not run out. Both come
  // from chain reads now, so the UI cannot contradict the contract.
  const isOpen = round?.phase === Phase.Open && secsLeft !== null && secsLeft > 0;
  const canEnter = isOpen && account && (!myEntry || myEntry.stake === ZERO);
  const needMore = cfg && entrants.length < Number(cfg.minEntrants);
  // The round is over once the contract's clock hits zero, so anyone can
  // settle it — not just people who staked.
  const canSettle = round?.phase === Phase.Open && secsLeft !== null && secsLeft === 0;

  // --- writes -------------------------------------------------------------
  const sendTx = async (fn: string, args: unknown[], value?: bigint) => {
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
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 60_000 });
    setStatus(`${fn} confirmed`);
    await refresh();
  };

  const enter = async () => {
    setBusy(true); setError('');
    try { await sendTx('enter', [], parseEther(stakeInput || '0')); }
    catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(false); }
  };

  const settle = async () => {
    setBusy(true); setError('');
    try { await sendTx('settle', []); }
    catch (e) { setError(String(e).slice(0, 200)); }
    finally { setBusy(false); }
  };

  // --- render -------------------------------------------------------------
  if (!isGameDeployed) {
    return (
      <div className="banner info">
        Game contract not deployed yet. Set <code>NEXT_PUBLIC_GAME_ADDRESS</code> in{' '}
        <code>app/.env.local</code> and restart the dev server.
      </div>
    );
  }

  const bestPnl = entrants.reduce((m, r) => (r.pnl !== null && r.pnl > m ? r.pnl : m), ZERO);

  return (
    <>
      {error && <div className="banner">⚠ {error}</div>}
      {status && (
        <div className="banner info">
          {status}{' '}
          {lastTx && hasExplorer && <a href={explorerTx(lastTx)} target="_blank" rel="noreferrer">view tx</a>}
        </div>
      )}

      <div className="grid">
        {/* ---------------- left column ---------------- */}
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <h2>Curve price</h2>
            <div className="price-label">spot price (ETH per token)</div>
            <div className="price mono">{formatSpot(spot, 9)}</div>
            {entryPrice !== ZERO && (
              <div className={`delta ${spot >= entryPrice ? 'up' : 'down'}`} style={{ marginTop: 8 }}>
                {spot >= entryPrice ? '▲' : '▼'} {formatSpot(((spot - entryPrice) * 10_000n) / entryPrice, 2)}% since round open
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <span className="k">Entry price</span>
              <span className="v mono">{entryPrice ? formatSpot(entryPrice, 9) : '—'}</span>
            </div>
            <div className="row">
              <span className="k">Your stake</span>
              <span className="v mono">{myEntry?.stake ? formatEth(myEntry.stake) + ' ETH' : '—'}</span>
            </div>
            {projected !== null && (
              <div className="row">
                <span className="k">Unrealised PnL</span>
                <span className={`v mono ${projected >= ZERO ? 'up' : 'down'}`}>
                  {projected >= ZERO ? '+' : ''}{formatEth(projected < ZERO ? -projected : projected)} ETH
                </span>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Round {roundId.toString()}</h2>
            <div className="countdown" style={{ color: secs <= 5 ? 'var(--pink)' : undefined }}>
              {secsLeft === null ? '—' : secs > 0 ? `${secs}s` : (round?.phase === Phase.Open ? '0s' : 'closed')}
            </div>
            <div className="progress"><div style={{ width: `${progress}%` }} /></div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="k">Status</span>
              <span className="v">
                {isOpen
                  ? <span className="pill live">OPEN</span>
                  : canSettle
                    ? <span className="pill live">CLOSED · READY TO SETTLE</span>
                    : <span className="pill">SETTLED</span>}
              </span>
            </div>
            <div className="row"><span className="k">Entrants</span><span className="v">{entrants.length} / {cfg ? cfg.minEntrants.toString() : '—'} min</span></div>
            <div className="row"><span className="k">Total stake</span><span className="v mono">{round ? formatEth(round.totalStake) + ' ETH' : '—'}</span></div>
            <div className="row"><span className="k">Rake</span><span className="v mono">{cfg ? formatEth(round ? round.rake : ZERO) : '—'}</span></div>
            <div className="row">
              <span className="k">Wager asset</span>
              <span className="v">
                {cfg?.custodyAvailable
                  ? <span className="pill armed">CUSTODY ARMED · {shortAddress(cfg.assetForWager)}</span>
                  : <span className="pill">ETH (token locked)</span>}
              </span>
            </div>
          </div>
        </div>

        {/* ---------------- right column ---------------- */}
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <h2>Play</h2>
            {!account ? (
              <>
                <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Connect to stake ETH and enter the round.</p>
                <button onClick={connect}>Connect wallet</button>
              </>
            ) : (
              <>
                <div className="row"><span className="k">Player</span><span className="v mono">{shortAddress(account)}</span></div>
                {myEntry && myEntry.stake > ZERO ? (
                  <>
                    <p className="muted" style={{ fontSize: 13 }}>You&apos;re in this round. Highest PnL at close wins the pot.</p>
                  </>
                ) : (
                  <>
                    <div style={{ marginTop: 10 }}>
                      <div className="price-label" style={{ marginBottom: 6 }}>Stake (ETH)</div>
                      <input type="number" step="0.001" min="0" value={stakeInput}
                             onChange={(e) => setStakeInput(e.target.value)} />
                    </div>
                    <button onClick={enter} disabled={!canEnter || busy}>
                      {!isOpen ? 'Round closed' : needMore ? 'Waiting for players…' : `Enter round ${roundId.toString()}`}
                    </button>
                    <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                      Min {cfg ? cfg.minEntrants.toString() : '2'} players. A solo round is voided and fully refunded.
                    </p>
                  </>
                )}
                {/* Settling is permissionless on-chain. Show it to anyone once
                    the contract's clock hits zero, otherwise a round that
                    nobody staked in can never be closed from the UI. */}
                {canSettle && (
                  <button className="ghost" onClick={settle} disabled={busy}
                          style={{ marginTop: 12, width: '100%' }}>
                    Settle round {roundId.toString()} &amp; open next
                  </button>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h2>Entrants</h2>
            {entrants.length === 0 ? (
              <div className="empty">No one has entered yet. Be first.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Player</th><th className="num">Stake</th><th className="num">PnL</th></tr>
                </thead>
                <tbody>
                  {entrants.map((r) => {
                    const isBest = r.pnl !== null && bestPnl > ZERO && r.pnl === bestPnl;
                    const cls = r.address === account ? 'me' : (isBest && round?.phase !== Phase.Open ? 'win' : '');
                    return (
                      <tr key={r.address} className={cls}>
                        <td className="mono">
                          {shortAddress(r.address)}
                          {r.paidOut && <span className="pill" style={{ marginLeft: 6 }}>PAID</span>}
                        </td>
                        <td className="num mono">{formatEth(r.stake)}</td>
                        <td className={`num mono ${r.pnl === null ? '' : r.pnl >= ZERO ? 'up' : 'down'}`}>
                          {r.pnl === null ? '—' : `${r.pnl >= ZERO ? '+' : '-'}${formatEth(r.pnl < ZERO ? -r.pnl : r.pnl)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              PnL resolves at close from the curve&apos;s spot price. Everyone enters at the same price.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
