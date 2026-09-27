/**
 * Pure presentation logic for the play panel.
 *
 * Every label the UI shows is derived here, from state, by a function with no
 * React and no side effects. That is the whole point: the three bugs that
 * shipped in this component were all label/state drift — "Waiting for
 * players…" on a clickable button, "You're in this round" on a round that had
 * already paid out, "round 411" from string concatenation. Each was a piece
 * of JSX computing a string inline, untestable and free to contradict the
 * state beside it.
 *
 * Deriving all of it from one tested module means the copy and the state
 * cannot disagree without a test failing.
 */

export const ZERO = 0n;

export type Phase = 0 | 1 | 2; // Idle | Open | Settled

export interface EntryView {
  stake: bigint;
  refundClaimed: boolean;
  paidOut: boolean;
}

export interface PlayState {
  /** Null when no wallet is connected. */
  account: `0x${string}` | null;
  /** True while a transaction is in flight. */
  busy: boolean;
  roundId: bigint;
  phase: Phase | null;
  secsLeft: number | null;
  /** The viewer's entry in the round currently on screen. */
  myEntry: EntryView | null;
  /**
   * Which round myEntry was read from. Null when unknown. Comparing this
   * against roundId is what stops a settled round's entry from pinning the
   * UI — see showsInRound.
   */
  entryRoundId?: bigint | null;
  entrants: number;
  minEntrants: bigint;
}

/** The round is still accepting entries per the contract's own clock. */
export function isRoundOpen(phase: Phase | null, secsLeft: number | null): boolean {
  return phase === 1 && secsLeft !== null && secsLeft > 0;
}

/**
 * True only when the viewer's stake belongs to the round on screen. The round
 * id guard is what stops a stale entry from a settled round pinning the UI
 * on "You're in this round" — the bug that locked a refunded player out.
 */
export function showsInRound(
  roundId: bigint,
  myEntry: EntryView | null,
  entryRoundId: bigint | null
): boolean {
  if (!myEntry) return false;
  if (myEntry.stake <= ZERO) return false;
  // An entry tagged for a different round is not an entry in this one.
  if (entryRoundId !== null && entryRoundId !== roundId) return false;
  return true;
}

/** Whether the stake form and its button render at all. */
export function canEnter(s: PlayState): boolean {
  if (!s.account) return false;
  if (s.busy) return false;
  return !showsInRound(s.roundId, s.myEntry, s.entryRoundId ?? null);
}
export type JoinLabel = {
  text: string;
  /** Rendered under the button; explains the state rather than blocking it. */
  note?: string;
  variant: 'primary' | 'ghost';
  disabled: boolean;
};

export function joinLabel(s: PlayState): JoinLabel {
  if (!s.account) {
    return { text: 'Connect wallet', variant: 'primary', disabled: false };
  }
  if (s.busy) {
    return { text: 'Confirming…', variant: 'primary', disabled: true };
  }

  const open = isRoundOpen(s.phase, s.secsLeft);

  // A closed round is still enterable: enter() settles it and rolls the
  // player into the next one, so nobody is ever locked out.
  const text = open
    ? `Enter round ${s.roundId.toString()}`
    : `Enter & start round ${(s.roundId + 1n).toString()}`;

  // Note the arithmetic: s.roundId + 1n, never s.roundId.toString() + 1n.
  // The latter is string concatenation and rendered round 41 as "411".

  // Order matters. When the round is closed, that is the more important fact
  // — it explains why the button names the NEXT round — so it takes the note
  // slot. Telling a lone player "you'd be the first in" while hiding that the
  // round is closed buries the reason the label changed.
  if (!open) {
    return {
      text,
      note: 'This round has closed — entering settles it and starts the next one.',
      variant: 'primary',
      disabled: !canEnter(s),
    };
  }

  const needsMore = s.entrants < Number(s.minEntrants);
  return {
    text,
    note: needsMore
      ? "You'd be the first in — you can enter now, but if nobody else joins the round is voided and refunded in full."
      : undefined,
    variant: 'primary',
    disabled: !canEnter(s),
  };
}

/** The status pill above the board. */
export function statusPill(
  phase: Phase | null,
  secsLeft: number | null
): { text: string; tone: 'live' | 'armed' | 'idle' | 'settled' } {
  if (phase === null) return { text: 'LOADING', tone: 'idle' };
  if (phase === 2) return { text: 'SETTLED', tone: 'idle' };
  if (secsLeft === 0) return { text: 'CLOSED · SETTLING', tone: 'armed' };
  if (secsLeft !== null && secsLeft <= 5) return { text: 'CLOSING', tone: 'armed' };
  return { text: 'LIVE', tone: 'live' };
}

/** Progress through the round, 0..1, for the bar or ring. */
export function roundProgress(secsLeft: number | null, roundSeconds: number): number {
  if (secsLeft === null || roundSeconds <= 0) return 0;
  const done = roundSeconds - secsLeft;
  const pct = done / roundSeconds;
  if (pct < 0) return 0;
  if (pct > 1) return 1;
  return pct;
}
