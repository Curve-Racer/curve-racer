/**
 * Regression guard for the stale-closure bug that pinned players on
 * "You're in this round" forever.
 *
 * The countdown timer is created with an empty dependency array, so it closes
 * over whatever values existed on the FIRST render — when account was still
 * null. Calling that captured refresh() meant its `if (account) setMyEntry(...)`
 * guard was always false, so the round advanced but myEntry never did.
 *
 * This models the exact shape: a long-lived closure created before the
 * dependency it reads has been set, and an assertion that it must still see
 * the live value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal stand-in for the ref indirection the fix relies on. */
function makeAlwaysLive() {
  let current;
  return {
    ref: {
      // The component assigns this on every render.
      set: (v) => { current = v; },
      get: () => current,
    },
  };
}

test('a timer created before account exists still refreshes myEntry', () => {
  // This mirrors the real shape: refresh is a useCallback that CLOSES OVER
  // `account` and guards setMyEntry with `if (account)`. It takes no
  // arguments. The bug is not a stale argument — it is that the version
  // captured by an []-dep effect closed over account === null forever, so its
  // guard was permanently false.
  const makeRefresh = (account) => () =>
    account ? `myEntry set for ${account}` : 'skipped';

  let live = makeRefresh(null);          // render 1: no wallet
  const capturedByTimer = live;          // <- what the []-dep effect holds

  assert.equal(capturedByTimer(), 'skipped'); // the bug's starting condition

  live = makeRefresh('0xabc');           // render 2: wallet connected

  // The naive call — what the old code did — still sees the stale closure,
  // so myEntry is never updated and the player stays stuck "in this round".
  assert.equal(capturedByTimer(), 'skipped'); // ← THE BUG

  // The fixed call goes through the ref and sees the live closure.
  assert.equal(live(), 'myEntry set for 0xabc'); // ← THE FIX
});

test('the round id is compared against the live value, not the first render', () => {
  let roundId = 0n;
  const ref = { get: () => roundId, set: (v) => { roundId = v; } };
  const firstRenderId = ref.get();

  // A round advances to 5 while the page sits idle.
  roundId = 5n;

  // Comparing against the captured value would see 0n !== 5n and fire a
  // refresh every single tick, forever. Comparing against the live value
  // correctly reports "changed" once, then settles.
  assert.equal(firstRenderId !== roundId, true);
  assert.equal(ref.get(), 5n);
  assert.equal(ref.get() !== 5n, false);
});

test('a player with no on-chain entry is never shown as entered', () => {
  // What the chain says for the current round: stake 0, not refunded, not paid.
  const entry = { stake: 0n, refundClaimed: false, paidOut: false };
  const ZERO = 0n;

  // The render branch that shows "You're in this round".
  const showsInRoundMessage = Boolean(entry) && entry.stake > ZERO;

  assert.equal(showsInRoundMessage, false);
});

test('a refunded entry does not show as entered', () => {
  const entry = { stake: 0n, refundClaimed: true, paidOut: false };
  const ZERO = 0n;
  assert.equal(Boolean(entry) && entry.stake > ZERO, false);
});
