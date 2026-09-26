# Curve Racer — build log

Required by the Seedify Vibecoins submission guidelines: the AI prompts, tools
and iteration history behind the project.

## Tooling

| Stage | Tool | Model |
|---|---|---|
| Chain reconnaissance, interface recovery, design | Hermes Agent (Hermes profile `hunter`) | `stealth/space-bunny-alpha` |
| Contracts, interfaces, tests | Claude Code via Hermes terminal | same session |
| Frontend | Next.js 14 + viem | same session |

## What the AI was asked to do, in order

1. **"Pull the full token ABI and confirm which view functions are callable
   pre-graduation. That's the contract that determines how much of the game I
   can build today versus what has to wait."**
   → Recovered the on-chain surface by `eth_call` probing rather than assuming
   an ABI. Found `totalSupply`, `balanceOf`, `curve`, `approve` live, and
   `transfer`/`transferFrom` reverting `0xdb89e3f4`.

2. **"Pin it down first."** (graduation signal)
   → Recovered `CurveCompleted(uint256,uint256)` by binary-searching the chain
   for a graduated launch's completion block and decoding real logs.

3. **"Is the trading bot paused?"** — unrelated operational task.

4. **"By game, I actually meant a literal game."** — reframed the brief from
   RWA-finance to an actual game.

5. **"You need to tie it to the game, which gives the token a utility."**
   → The constraint that shaped everything: the launchpad token is
   transfer-locked until graduation, so utility had to be designed around that
   rather than assumed.

6. **"Go ahead."** (build) → 26 tests, 3 real bugs found and fixed.

## Bugs the AI found in its own work

These are the substantive iterations:

- **Late entries were accepted at a stale entry price.** `enter()` checked
  `phase == Open` but not `block.number >= closeBlock`, so a player could join a
  round after its deadline and be settled at the original price. Fixed with a
  `RoundClosed` guard; regression test `test_LateEntryCannotJoinAtStalePrice`.
- **PnL was unsigned, so a losing player could tie with a breakeven one and win
  the pot on a flat curve.** Changed to `int256` throughout, with the
  ordering invariant pinned by `test_LoserRanksBelowBreakeven`.
- **The leaderboard credited `entrants[0]` rather than the actual winner.**
  Fixed to scan for the entrant that achieved the best PnL.
- **`currentRound()` could not exist** — `Round` contains a mapping, so it
  cannot be returned across the ABI. Replaced with a flat `roundState()` tuple.
- **`withdrawRake()` reused `NotCurve` as its auth error.** Split out
  `NotTreasury`.

## Techniques worth noting

- **Bytecode opcode walking** to recover event topics from an unverified
  contract (fixed a parser bug that compared one hex char against `"7f"`).
- **Error-code forensics**: the difference between `0xdb89e3f4` and
  `ERC20: insufficient allowance` revealed that the allowance check runs
  *before* the transfer lock, which is what proved the curve cannot pull tokens
  during the lock.
- **Empirical-first verification.** Where possible the AI read real chain state
  rather than trusting documentation or a prior summary — including correcting
  itself when a claim it had made turned out to be evidentially thin (the
  "graduation releases the lock" claim was initially supported only by a change
  in error code, not by an observed successful transfer).
