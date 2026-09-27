import { formatEther, formatUnits, type Address } from 'viem';
import { publicClient, GAME_ADDRESS } from './chain';
import { CURVE_RACER_ABI, VIBE_CURVE_ABI } from './abi';

/**
 * Must match CurveRacer.Phase in the contract:
 *   Idle = 0, Open = 1, Settled = 2
 * This was previously (Open=0, Settled=1, Closed=2), which decoded a live
 * Open round (on-chain value 1) as "Settled" — the UI showed a closed round
 * while the contract was still accepting entries.
 */
export enum Phase {
  Idle = 0,
  Open = 1,
  Settled = 2,
}

export interface RoundState {
  id: bigint;
  openBlock: bigint;
  closeBlock: bigint;
  openTimestamp: bigint;
  closeTimestamp: bigint;
  phase: Phase;
  totalStake: bigint;
  pot: bigint;
  rake: bigint;
  entryPriceWad: bigint;
  voided: boolean;
}

export interface CurveInfo {
  address: Address;
  spotPriceWad: bigint;
  graduated: boolean;
  virtualEthReserve: bigint;
  tokensSoldFromCurve: bigint;
}

export const ZERO = 0n;

/**
 * Format a bonding-curve spot price for display.
 *
 * IMPORTANT: the value is NOT necessarily 1e18-scaled. The Pons curve's
 * spotPriceWad() returns a 1e9-scaled number (live testnet:
 * 3766303257 => 3.766…), even though the name says "Wad". The contract only
 * ever uses these as a RATIO, so its PnL is correct either way — but any
 * display that assumes 18 decimals is off by 1e9. The old code got this
 * accidentally right only because the UI was reading the wrong contract and
 * falling back to the game's own entry price.
 *
 * So: pick the scale from the magnitude rather than assuming one. Anything
 * below 1e6 is not a price we can render meaningfully, and the curve is
 * 1e9-scaled, so divide by 1e9.
 */
export function formatSpot(spotPriceWad: bigint, decimals = 4): string {
  if (spotPriceWad === ZERO) return '0';
  // The curve reports in 1e9 units. Normalise to a plain decimal string.
  const s = formatUnits(spotPriceWad * 10n ** 9n, 18);
  const [whole = '0', frac = ''] = s.split('.');
  return `${whole}.${frac.slice(0, decimals).padEnd(decimals, '0')}`;
}

export function formatEth(wei: bigint, dp = 4): string {
  const s = formatEther(wei);
  const [i, f = ''] = s.split('.');
  return `${i}.${f.slice(0, dp).padEnd(dp, '0')}`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function readRoundState(roundId: bigint): Promise<RoundState> {
  // Field order mirrors CurveRacer.roundState():
  //   id, openBlock, closeBlock, openTimestamp, closeTimestamp, phase,
  //   totalStake, pot, rake, entryPriceWad, voided
  const r = (await publicClient.readContract({
    address: GAME_ADDRESS,
    abi: CURVE_RACER_ABI,
    functionName: 'roundState',
    args: [roundId],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, number, bigint, bigint, bigint, bigint, boolean];
  return {
    id: r[0], openBlock: r[1], closeBlock: r[2],
    openTimestamp: r[3], closeTimestamp: r[4],
    phase: r[5] as Phase,
    totalStake: r[6], pot: r[7], rake: r[8],
    entryPriceWad: r[9], voided: r[10],
  };
}

export async function readCurrentRoundId(): Promise<bigint> {
  return (await publicClient.readContract({
    address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'currentRoundId',
  })) as bigint;
}

export async function readEntrants(roundId: bigint): Promise<Address[]> {
  return (await publicClient.readContract({
    address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'entrants', args: [roundId],
  })) as Address[];
}

export interface Entry {
  stake: bigint;
  refundClaimed: boolean;
  paidOut: boolean;
}

export async function readEntry(roundId: bigint, player: Address): Promise<Entry> {
  // entryOf returns ONE tuple output (stake, refundClaimed, paidOut), so viem
  // hands back a single struct result rather than positional elements.
  const e = (await publicClient.readContract({
    address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'entryOf', args: [roundId, player],
  })) as unknown as Entry;
  return { stake: BigInt(e.stake), refundClaimed: Boolean(e.refundClaimed), paidOut: Boolean(e.paidOut) };
}

export async function readConfig() {
  const [roundBlocks, roundSeconds, minEntrants, rakeBps, assetForWager, custodyAvailable, treasury] =
    await Promise.all([
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'ROUND_BLOCKS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'ROUND_SECONDS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'MIN_ENTRANTS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'RAKE_BPS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'assetForWager' }) as Promise<Address>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'custodyAvailable' }) as Promise<boolean>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'treasury' }) as Promise<Address>,
    ]);
  return { roundBlocks, roundSeconds, minEntrants, rakeBps, assetForWager, custodyAvailable, treasury };
}

export async function readCurveInfo(curveAddress: Address): Promise<CurveInfo> {
  const [spotPriceWad, graduated, virtualEthReserve, tokensSoldFromCurve] = await Promise.all([
    publicClient.readContract({ address: curveAddress, abi: VIBE_CURVE_ABI, functionName: 'spotPriceWad' }) as Promise<bigint>,
    publicClient.readContract({ address: curveAddress, abi: VIBE_CURVE_ABI, functionName: 'graduated' }) as Promise<boolean>,
    publicClient.readContract({ address: curveAddress, abi: VIBE_CURVE_ABI, functionName: 'virtualEthReserve' }) as Promise<bigint>,
    publicClient.readContract({ address: curveAddress, abi: VIBE_CURVE_ABI, functionName: 'tokensSoldFromCurve' }) as Promise<bigint>,
  ]);
  return { address: curveAddress, spotPriceWad, graduated, virtualEthReserve, tokensSoldFromCurve };
}

/** PnL for a stake between two curve prices. Mirrors CurveRacer.pnlWad(). */
export async function readPnl(stake: bigint, entry: bigint, exit: bigint): Promise<bigint> {
  return (await publicClient.readContract({
    address: GAME_ADDRESS, abi: CURVE_RACER_ABI,
    functionName: 'pnlWad', args: [stake, entry, exit],
  })) as bigint;
}

export async function readBlockNumber(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

/**
 * Seconds left in the current round, straight from the contract.
 *
 * This is the authority on whether a round is open. The UI must NOT derive
 * this from `closeBlock - clientBlockNumber`: the RPC's head and the round's
 * stored block numbers are not on a scale you can safely subtract, and doing
 * so reported a live round as closed. The contract already computes the
 * comparison itself, so read it and trust it.
 */
export async function readSecondsRemaining(): Promise<bigint> {
  return (await publicClient.readContract({
    address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'secondsRemaining',
  })) as bigint;
}
