/**
 * Component tests. These assert the UI cannot show copy that contradicts the
 * state it sits next to — the class of bug that shipped three times.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JoinPanel } from '@/components/game/join-panel';
import { Leaderboard } from '@/components/game/leaderboard';
import { CountdownRing } from '@/components/game/countdown-ring';
import type { PlayState } from '@/lib/play';

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

function renderJoin(overrides: Partial<PlayState> = {}) {
  const props = {
    state: { ...base, ...overrides },
    stakeInput: '0.01',
    onStakeChange: vi.fn(),
    onConnect: vi.fn(),
    onEnter: vi.fn(),
    onSettle: vi.fn(),
    busy: false,
    canSettle: false,
    walletBalanceEth: '0.0962',
  };
  render(<JoinPanel {...props} />);
  return props;
}

describe('JoinPanel', () => {
  it('prompts to connect when there is no wallet', () => {
    renderJoin({ account: null });
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Stake')).not.toBeInTheDocument();
  });

  it('offers entry and never says "Waiting for players"', () => {
    renderJoin({ entrants: 0 });
    const btn = screen.getByRole('button', { name: /enter round 41/i });
    expect(btn).toBeEnabled();
    expect(screen.queryByText(/waiting for players/i)).not.toBeInTheDocument();
    // The tradeoff is explained, not used to block.
    expect(screen.getByText(/first in/i)).toBeInTheDocument();
  });

  // The bug: a stale entry from a settled round locked the player out.
  it('still offers entry when only a PREVIOUS round entry exists', () => {
    renderJoin({
      roundId: 42n,
      myEntry: { stake: 10n ** 16n, refundClaimed: true, paidOut: false },
      entryRoundId: 41n,
    });
    expect(screen.getByRole('button', { name: /enter round 42/i })).toBeEnabled();
    expect(screen.queryByText(/in the round/i)).not.toBeInTheDocument();
  });

  it('shows the in-round state for a real entry in this round', () => {
    renderJoin({
      myEntry: { stake: 10n ** 16n, refundClaimed: false, paidOut: false },
      entryRoundId: 41n,
    });
    expect(screen.getByText(/in the round/i)).toBeInTheDocument();
    expect(screen.getByText('0.0100 ETH')).toBeInTheDocument();
    expect(screen.queryByLabelText('Stake')).not.toBeInTheDocument();
  });

  it('names the NEXT round when the current one is closed', () => {
    renderJoin({ secsLeft: 0 });
    expect(screen.getByRole('button', { name: /enter & start round 42/i })).toBeEnabled();
    expect(screen.getByText(/this round has closed/i)).toBeInTheDocument();
  });

  it('surfaces a win when the entry was paid out', () => {
    renderJoin({
      myEntry: { stake: 10n ** 16n, refundClaimed: false, paidOut: true },
      entryRoundId: 41n,
    });
    expect(screen.getByText(/paid out to your wallet/i)).toBeInTheDocument();
  });

  it('disables entry and shows progress while a tx is in flight', () => {
    renderJoin({ busy: true });
    expect(screen.getByRole('button', { name: /confirming/i })).toBeDisabled();
  });

  it('offers a manual settle when the round is ready to close', () => {
    render(
      <JoinPanel
        state={base}
        stakeInput="0.01"
        onStakeChange={vi.fn()}
        onConnect={vi.fn()}
        onEnter={vi.fn()}
        onSettle={vi.fn()}
        busy={false}
        canSettle
        walletBalanceEth="0.0962"
      />
    );
    expect(screen.getByRole('button', { name: /settle round 41/i })).toBeInTheDocument();
  });

  it('hides the settle button while the round is still running', () => {
    renderJoin({ secsLeft: 20 });
    expect(screen.queryByRole('button', { name: /settle round/i })).not.toBeInTheDocument();
  });
});

describe('Leaderboard', () => {
  // 0.005 ETH = 5e15 wei, 0.003 ETH = 3e15 wei. Small PnL is the whole
  // point of a 30-second round, so the display must not flatten it to 0.00.
  const rows = [
    { address: '0xaaa', stake: 10n ** 16n, pnl: 5n * 10n ** 15n, isMe: false },
    { address: '0xbbb', stake: 10n ** 16n, pnl: -(3n * 10n ** 15n), isMe: true },
  ];

  it('sorts the best PnL to the top', () => {
    render(<Leaderboard rows={rows} minEntrants={2n} roundSeconds={30} />);
    const items = screen.getAllByText(/0x[ab]{3}/);
    expect(items[0]).toHaveTextContent('0xaaa');
  });

  it('signs gains and losses', () => {
    render(<Leaderboard rows={rows} minEntrants={2n} roundSeconds={30} />);
    expect(screen.getByTestId('pnl-0xaaa')).toHaveTextContent('+0.005');
    expect(screen.getByTestId('pnl-0xbbb')).toHaveTextContent('-0.003');
  });

  it('marks the viewer', () => {
    render(<Leaderboard rows={rows} minEntrants={2n} roundSeconds={30} />);
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('invites the first entrant when the round is empty', () => {
    render(<Leaderboard rows={[]} minEntrants={2n} roundSeconds={30} />);
    expect(screen.getByText(/no one has entered yet/i)).toBeInTheDocument();
  });
});

describe('CountdownRing', () => {
  it('shows seconds remaining', () => {
    render(<CountdownRing secsLeft={7} roundSeconds={30} progress={23 / 30} />);
    expect(screen.getByTestId('countdown-secs')).toHaveTextContent('7');
  });

  it('shows a placeholder while loading rather than a wrong number', () => {
    render(<CountdownRing secsLeft={null} roundSeconds={30} progress={0} />);
    expect(screen.getByTestId('countdown-secs')).toHaveTextContent('—');
  });
});
