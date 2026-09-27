/**
 * formatSpot / formatSpotNano regression guard.
 *
 * Three separate silent-corruption bugs lived in this area, none of which
 * threw — the numbers were just wrong, which is worse:
 *
 *  1. `decimals` was passed straight to formatUnits(), which treats it as a
 *     SCALE, not display precision. formatUnits(x, 4) divides by 1e4.
 *
 *  2. The UI read spotPriceWad() from the GAME contract, which has no such
 *     function. It reverts, the catch swallows it, and the price stayed 0,
 *     rendering as a dash plus a nonsense "-100.00% since round open".
 *
 *  3. A 1e9 scale was then assumed, because a raw value of ~3.5e9 "looked
 *     like" 3.5. That was wrong too: spotPriceWad() is a true 18-decimal
 *     wad, so the price is ~3.56e-9 ETH per token. Settled on-chain by
 *     multiplying the price by virtualTokenReserve and comparing against
 *     virtualEthReserve — exact at 1e18, off by 1e9 at 1e9.
 *
 * The contract only ever uses these values as a RATIO, so PnL on-chain is
 * correct under any scale. Only display was ever wrong.
 */
import { describe, it, expect } from 'vitest';
import { formatSpot, formatSpotNano, formatEth } from '@/lib/game';

// Raw value read live from curve 0x6627e913…6c45 on Robinhood testnet.
const LIVE = 3_562_651_907n;
// Reserves, read raw. Note virtualTokenReserve is 27-decimal scaled, not 18 —
// using an 18e constant here made the reserve invariant look 1e6 off.
const VIRTUAL_ETH = 2_597_221_761_669_000_041n;              // ~2.597222 ETH
const VIRTUAL_TOK = 729_013_619_287_038_710_467_714_114n;    // ~729,013,619 tokens

describe('formatSpot', () => {
  it('reads spotPriceWad as an 18-decimal wad', () => {
    expect(formatSpot(LIVE)).toBe('0.000000003562651907');
    expect(formatSpot(LIVE, 12)).toBe('0.000000003562');
  });

  it('is consistent with the curve reserves (price x tokens = eth)', () => {
    // The invariant that settles the scale question, expressed as a test.
    // eth / (price * tokens) is 1.000000 at 1e18 and 1e9 at 1e9.
    const price = Number(formatSpot(LIVE));
    const eth = Number(VIRTUAL_ETH);
    const tokens = Number(VIRTUAL_TOK);
    const ratio = eth / (price * tokens);
    expect(ratio).toBeGreaterThan(0.999);
    expect(ratio).toBeLessThan(1.001);
  });

  it('treats decimals as precision, not as a scale exponent', () => {
    // If decimals were a scale, formatSpot(LIVE, 4) would read ~3.5e5.
    expect(Number(formatSpot(LIVE, 4))).toBeLessThan(0.0001);
  });

  it('handles zero and larger values', () => {
    expect(formatSpot(0n)).toBe('0');
    expect(formatSpot(10n ** 18n, 2)).toBe('1.00');
  });
});

describe('formatSpotNano', () => {
  it('renders the headline price readably in nano-ETH', () => {
    // 3.562651907e-9 ETH => 3.5626 nano-ETH. Exact, no invented precision:
    // one nano-ETH is exactly one gwei.
    expect(formatSpotNano(LIVE)).toBe('3.5626');
    expect(formatSpotNano(LIVE, 2)).toBe('3.56');
  });

  it('agrees with formatSpot by exactly 1e9', () => {
    const eth = Number(formatSpot(LIVE));
    const nano = Number(formatSpotNano(LIVE, 9));
    expect(nano / eth).toBeCloseTo(1e9, 0);
  });

  it('pads and handles zero', () => {
    expect(formatSpotNano(3_000_000_000n)).toBe('3.0000');
    expect(formatSpotNano(0n)).toBe('0');
  });
});

describe('formatEth', () => {
  it('truncates and pads to the requested places', () => {
    expect(formatEth(10n ** 16n)).toBe('0.0100');
    expect(formatEth(3n * 10n ** 15n)).toBe('0.0030');
    expect(formatEth(10n ** 18n)).toBe('1.0000');
  });
});
