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

/** spotPriceWad is wei-per-token; show it as a readable ETH price per token. */
export function formatSpot(spotPriceWad: bigint, decimals = 18): string {
  if (spotPriceWad === ZERO) return '0';
  return formatUnits(spotPriceWad, decimals);
}

export function formatEth(wei: bigint, dp = 4): string {
  const s = formatEther(wei);
  const [i, f = ''] = s.split('.');
  return `${i}.${f.slice(0, dp)}`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function readRoundState(roundId: bigint): Promise<RoundState> {
  const r = (await publicClient.readContract({
    address: GAME_ADDRESS,
    abi: CURVE_RACER_ABI,
    functionName: 'roundState',
    args: [roundId],
  })) as readonly [bigint, bigint, bigint, number, bigint, bigint, bigint, bigint, boolean];
  return {
    id: r[0], openBlock: r[1], closeBlock: r[2],
    phase: r[3] as Phase,
    totalStake: r[4], pot: r[5], rake: r[6],
    entryPriceWad: r[7], voided: r[8],
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
  const [roundBlocks, minEntrants, rakeBps, assetForWager, custodyAvailable, treasury] =
    await Promise.all([
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'ROUND_BLOCKS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'MIN_ENTRANTS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'RAKE_BPS' }) as Promise<bigint>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'assetForWager' }) as Promise<Address>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'custodyAvailable' }) as Promise<boolean>,
      publicClient.readContract({ address: GAME_ADDRESS, abi: CURVE_RACER_ABI, functionName: 'treasury' }) as Promise<Address>,
    ]);
  return { roundBlocks, minEntrants, rakeBps, assetForWager, custodyAvailable, treasury };
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
