/**
 * These tests are regression guards for bugs that actually shipped.
 * Each names the bug it prevents.
 */
import { describe, it, expect } from 'vitest';
import {
  joinLabel,
  showsInRound,
  canEnter,
  isRoundOpen,
  statusPill,
  roundProgress,
  type PlayState,
} from '@/lib/play';

const base: PlayState = {
  account: '0xabc',
  busy: false,
  roundId: 41n,
  phase: 1,
  secsLeft: 20,
  myEntry: null,
  entryRoundId: null,
  entrants: 0,
  minEntrants: 2n,
};

describe('isRoundOpen', () => {
  it('is open only when the contract clock has not run out', () => {
    expect(isRoundOpen(1, 20)).toBe(true);
    expect(isRoundOpen(1, 0)).toBe(false);
    expect(isRoundOpen(2, 20)).toBe(false);
    expect(isRoundOpen(1, null)).toBe(false);
  });
});

describe('showsInRound', () => {
  it('shows the in-round message for a live entry in the current round', () => {
    expect(showsInRound(41n, { stake: 10n, refundClaimed: false, paidOut: false }, 41n)).toBe(true);
  });

  // BUG 1: "You're in this round. Highest PnL at close wins the pot" stayed
  // stuck forever after the keeper settled and refunded the player.
  it('does NOT show for a refunded entry (stake zeroed)', () => {
    expect(showsInRound(42n, { stake: 0n, refundClaimed: true, paidOut: false }, 42n)).toBe(false);
  });

  it('does NOT show when the entry belongs to a previous round', () => {
    // The entry is 0.01 ETH but it was read for round 41, and we are on 42.
    expect(showsInRound(42n, { stake: 10n, refundClaimed: false, paidOut: false }, 41n)).toBe(false);
  });

  it('does NOT show when there is no entry at all', () => {
    expect(showsInRound(41n, null, 41n)).toBe(false);
  });
});

describe('canEnter', () => {
  it('is false with no wallet', () => {
    expect(canEnter({ ...base, account: null })).toBe(false);
  });
  it('is false while a transaction is in flight', () => {
    expect(canEnter({ ...base, busy: true })).toBe(false);
  });
  it('is true for a solo player in a live round', () => {
    expect(canEnter(base)).toBe(true);
  });
  // The bug that locked the user out: a stale entry must not block entry.
  it('is true when only a PREVIOUS round entry exists', () => {
    expect(
      canEnter({
        ...base,
        roundId: 42n,
        myEntry: { stake: 10n, refundClaimed: false, paidOut: false },
        entryRoundId: 41n,
      })
    ).toBe(true);
  });
});

describe('joinLabel', () => {
  // BUG 2: the button read "Waiting for players…" whenever the round had fewer
  // than MIN_ENTRANTS entrants, while remaining fully clickable. The label
  // described a state the player could not act on.
  it('never says "Waiting for players"', () => {
    for (const entrants of [0, 1, 2, 5]) {
      const l = joinLabel({ ...base, entrants });
      expect(l.text).not.toContain('Waiting');
    }
  });

  it('offers entry as the first player, and says so in a note', () => {
    const l = joinLabel({ ...base, entrants: 0 });
    expect(l.text).toBe('Enter round 41');
    expect(l.disabled).toBe(false);
    expect(l.note).toMatch(/first in/i);
    expect(l.note).toMatch(/refund/i);
  });

  it('drops the note once the round has enough players', () => {
    expect(joinLabel({ ...base, entrants: 2 }).note).toBeUndefined();
  });

  // BUG 3: roundId.toString() + 1n is string concatenation and rendered
  // round 41 as "411".
  it('increments the round arithmetically, not by concatenation', () => {
    const l = joinLabel({ ...base, phase: 1, secsLeft: 0 });
    expect(l.text).toBe('Enter & start round 42');
    expect(l.text).not.toContain('411');
  });

  it('handles multi-digit rounds without corrupting them', () => {
    const l = joinLabel({ ...base, roundId: 999n, phase: 1, secsLeft: 0 });
    expect(l.text).toBe('Enter & start round 1000');
  });

  it('is never disabled when the round is closed, because enter() auto-advances', () => {
    const l = joinLabel({ ...base, phase: 1, secsLeft: 0 });
    expect(l.disabled).toBe(false);
    expect(l.note).toMatch(/closed/i);
  });

  it('prompts to connect when no wallet', () => {
    expect(joinLabel({ ...base, account: null }).text).toBe('Connect wallet');
  });

  it('disables and reports progress while busy', () => {
    const l = joinLabel({ ...base, busy: true });
    expect(l.disabled).toBe(true);
    expect(l.text).toBe('Confirming…');
  });
});

describe('statusPill', () => {
  it('reads LIVE while the clock runs', () => {
    expect(statusPill(1, 20).tone).toBe('live');
  });
  it('warns in the closing seconds', () => {
    expect(statusPill(1, 3).text).toBe('CLOSING');
  });
  it('flags a closed round awaiting settlement', () => {
    expect(statusPill(1, 0).tone).toBe('armed');
  });
  it('reads SETTLED once settled', () => {
    expect(statusPill(2, 0).text).toBe('SETTLED');
  });
  it('handles not-yet-loaded', () => {
    expect(statusPill(null, null).text).toBe('LOADING');
  });
});

describe('roundProgress', () => {
  it('is 0 at the start and 1 at the end', () => {
    expect(roundProgress(30, 30)).toBe(0);
    expect(roundProgress(0, 30)).toBe(1);
  });
  it('is halfway through the middle', () => {
    expect(roundProgress(15, 30)).toBe(0.5);
  });
  it('clamps rather than overflowing', () => {
    expect(roundProgress(45, 30)).toBe(0);
    expect(roundProgress(-5, 30)).toBe(1);
  });
  it('is safe when the clock is unknown or the round is zero', () => {
    expect(roundProgress(null, 30)).toBe(0);
    expect(roundProgress(10, 0)).toBe(0);
  });
});
