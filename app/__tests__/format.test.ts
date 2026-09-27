/**
 * formatSpot regression guard.
 *
 * Two separate silent-corruption bugs lived here:
 *
 *  1. The `decimals` argument was passed straight to formatUnits(), which
 *     treats it as a SCALE, not display precision. formatUnits(x, 4) divided
 *     by 1e4 and inflated 3.79 to 37907.83 — a plausible-looking wrong number.
 *
 *  2. The Pons curve's spotPriceWad() is 1e9-scaled despite the name
 *     (live testnet: 3766303257 => 3.766), not 1e18. Formatting at 18dp
 *     rendered it as 0.000000004.
 *
 * The contract only ever uses these values as a RATIO, so PnL on-chain is
 * correct either way. Only the display was ever wrong — which is exactly the
 * kind of bug that survives a passing test suite.
 */
import { describe, it, expect } from 'vitest';
import { formatSpot, formatEth } from '@/lib/game';

// Real value read from the live curve on Robinhood testnet.
const LIVE = 3_766_303_257n;

describe('formatSpot', () => {
  it('renders the live curve price at a sane magnitude', () => {
    expect(formatSpot(LIVE, 4)).toBe('3.7663');
    expect(formatSpot(LIVE, 2)).toBe('3.76');
  });

  it('never inflates the value — the original formatUnits(x, n) bug', () => {
    for (const d of [2, 4, 6, 9]) {
      const n = Number(formatSpot(LIVE, d));
      expect(n).toBeGreaterThan(3);
      expect(n).toBeLessThan(4);
    }
  });

  it('treats decimals as precision, not as a scale exponent', () => {
    // If decimals were a scale, this would read 376.63.
    expect(formatSpot(LIVE, 3)).toBe('3.766');
  });

  it('pads to the requested precision', () => {
    expect(formatSpot(3_000_000_000n, 4)).toBe('3.0000');
  });

  it('handles zero and larger values', () => {
    expect(formatSpot(0n, 4)).toBe('0');
    expect(formatSpot(1_000_000_000_000n, 2)).toBe('1000.00');
  });
});

describe('formatEth', () => {
  it('truncates and pads to the requested places', () => {
    expect(formatEth(10n ** 16n)).toBe('0.0100');
    expect(formatEth(3n * 10n ** 15n)).toBe('0.0030');
    expect(formatEth(10n ** 18n)).toBe('1.0000');
  });
});
