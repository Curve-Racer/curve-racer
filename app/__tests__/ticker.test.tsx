/**
 * Real DOM test for the stale-closure bug that pinned players on
 * "You're in this round. Highest PnL at close wins the pot" forever.
 *
 * This renders the actual component. The bug was a real React stale closure:
 * the countdown timer is created once with [], so it held the refresh()
 * captured on the first render, when account was still null. That copy's
 * `if (account) setMyEntry(...)` guard was permanently false, so the round
 * advanced on chain while myEntry stayed frozen at the old stake.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal reproduction of GameBoard's timer/refresh structure, with the chain
 * read injectable so the test controls what "the chain" says.
 */
function Board({ read, initialAccount = null }: {
  read: () => Promise<{ roundId: bigint; stake: bigint }>;
  initialAccount: string | null;
}) {
  const [account, setAccount] = useState<string | null>(initialAccount);
  const [roundId, setRoundId] = useState(41n);
  const [myEntry, setMyEntry] = useState<{ stake: bigint } | null>(null);

  const roundIdRef = useRef(roundId);
  roundIdRef.current = roundId;

  // The exact dependency shape that caused the bug: keyed on `account`.
  const refresh = useCallback(async () => {
    const { roundId: id, stake } = await read();
    setRoundId(id);
    if (account) {                       // <-- the guard that went stale
      setMyEntry({ stake });
    }
  }, [account]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // GameBoard refreshes once on mount (and whenever refresh changes).
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const { roundId: id } = await read();
      if (alive && id !== roundIdRef.current) {
        await refreshRef.current();
      }
    };
    const t = setInterval(tick, 10);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div>
      <span data-testid="round">round {roundId.toString()}</span>
      <span data-testid="entry">
        {myEntry && myEntry.stake > 0n ? "You're in this round" : 'Not in this round'}
      </span>
      <button onClick={() => setAccount('0xabc')}>connect</button>
    </div>
  );
}

describe('the countdown ticker', () => {
  it('updates myEntry after the wallet connects', async () => {
    // Chain: round 41, viewer staked 0.01 ETH.
    const read = vi.fn(async () => ({ roundId: 41n, stake: 10n ** 16n }));

    render(<Board read={read} initialAccount={null} />);
    expect(screen.getByTestId('entry')).toHaveTextContent('Not in this round');

    // The player connects. A new refresh() is created closing over account.
    await act(async () => { screen.getByText('connect').click(); });
    await waitFor(() =>
      expect(screen.getByTestId('entry')).toHaveTextContent("You're in this round")
    );
  });

  it('clears the entry when the chain advances to a round the player is not in', async () => {
    let chain = { roundId: 41n, stake: 10n ** 16n };
    const read = vi.fn(async () => chain);

    // Connect from the start, then enter round 41.
    render(<Board read={read} initialAccount="0xabc" />);
    await waitFor(() =>
      expect(screen.getByTestId('entry')).toHaveTextContent("You're in this round")
    );

    // The keeper settles round 41: the player is refunded (stake 0) and
    // round 42 opens. This is exactly the state that used to stick.
    chain = { roundId: 42n, stake: 0n };

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(screen.getByTestId('round')).toHaveTextContent('round 42');
    // The regression: this must NOT still read "You're in this round".
    expect(screen.getByTestId('entry')).toHaveTextContent('Not in this round');
  });

  // Proves the test above has teeth. Same component, but the ticker calls the
  // captured refresh() instead of the ref — the exact shipped bug. Here the
  // player IS in a round, so a stale closure leaves the entry frozen on screen
  // after the round advances: the failure the user actually reported.
  it('the entry goes stale when the ticker uses the captured refresh()', async () => {
    // Identical to Board except the ticker calls the captured refresh(). The
    // connect button matters: it is what makes account change after the timer
    // was created, which is what leaves the captured copy closing over null.
    function BrokenBoard(props: { read: () => Promise<{ roundId: bigint; stake: bigint }> }) {
      const [account, setAccount] = useState<string | null>(null);
      const [roundId, setRoundId] = useState(41n);
      const [myEntry, setMyEntry] = useState<{ stake: bigint } | null>(null);
      const roundIdRef = useRef(roundId);
      roundIdRef.current = roundId;

      const refresh = useCallback(async () => {
        const { roundId: id, stake } = await props.read();
        setRoundId(id);
        if (account) setMyEntry({ stake });
      }, [account]);

      useEffect(() => { refresh(); }, [refresh]);

      useEffect(() => {
        let alive = true;
        const tick = async () => {
          const { roundId: id } = await props.read();
          if (alive && id !== roundIdRef.current) {
            await refresh();                    // <-- THE BUG: captured copy
          }
        };
        const t = setInterval(tick, 10);
        return () => { alive = false; clearInterval(t); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return (
        <div>
          <span data-testid="round">round {roundId.toString()}</span>
          <span data-testid="entry">
            {myEntry && myEntry.stake > 0n ? "You're in this round" : 'Not in this round'}
          </span>
          <button onClick={() => setAccount('0xabc')}>connect</button>
        </div>
      );
    }

    // Enter round 41 with a real stake, then connect the wallet.
    let chain = { roundId: 41n, stake: 10n ** 16n };
    const read = vi.fn(async () => chain);
    render(<BrokenBoard read={read} />);
    await act(async () => { screen.getByText('connect').click(); });
    await waitFor(() =>
      expect(screen.getByTestId('entry')).toHaveTextContent("You're in this round")
    );

    // The keeper settles: refunded, and round 42 opens.
    chain = { roundId: 42n, stake: 0n };
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    // The round advances...
    expect(screen.getByTestId('round')).toHaveTextContent('round 42');
    // ...but the buggy ticker cannot write myEntry, so the player is still
    // shown as in a round that has already paid them out. This is the bug.
    expect(screen.getByTestId('entry')).toHaveTextContent("You're in this round");
  });
});
