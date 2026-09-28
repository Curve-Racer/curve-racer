# Curve Racer — session handoff

Written at the end of the UI-rebuild session. Start here in a new session.

**The one thing that needs a decision:** what the game does when the token
graduates. It is currently undefined, and the current design breaks at exactly
that moment. See "Open decision" below — everything else is finished and verified.

## Live state

| | |
|---|---|
| Game (prod) | `0xb40b976d6e386a0a3180d9907442c1c4301ba555` |
| Curve | `0x6627E9133A81F01c95C461bf71402a9000d06C45` |
| Token | `0xc9A12f02A2aeB173154552179b6ec70A16533678` |
| Treasury | `0xd940387Ce50dB0e21579352cE28e0a610D3799E` |
| Chain | Robinhood Testnet, `46630` (`0xB626`) |
| Frontend | `https://curve-racer.vercel.app` |
| Last commit | `2fa2d5c` (deployed, READY) |
| Keeper | `curve-racer-keeper.service`, user service, **active** |
| Round at handoff | 682 |

Protocol constants: `ROUND_SECONDS=30`, `ROUND_BLOCKS=300` (backstop),
`MIN_ENTRANTS=2`, `RAKE_BPS=250`.

## Open decision — graduation

**This is the blocking product question. Do not "fix" it without asking.**

The game is a 30-second price race where the bonding curve's own `spotPriceWad()`
is the price source — no oracle, no keeper, independently verifiable. That premise
is the product.

On graduation, two things happen:

1. **Built and working:** `assetForWager()` reads `custodyAvailable()` →
   `curve.graduated()`. On completion, wagers flip from ETH to the game token
   automatically. No state migration; all entry/exit paths route through it.

2. **Missing and breaking:** `_spotPrice()` (CurveRacer.sol:222) is
   `return curve.spotPriceWad();` — **no graduation branch**. The curve exposes
   no post-migration price source (probed: `uniswapV4Pool`, `pool`, `v4Pool`,
   `getReserves`, `finalPriceWad` all revert). So post-graduation rounds settle
   against a frozen value → ~0% PnL every round → ties split evenly forever.
   `enterWithToken()` would trade a real token for a meaningless outcome.

Options, roughly in order of honesty:

- **Graduate = game over.** Settle the final round, refuse new entries. The live
  curve phase *is* the product. Simplest, and no new trust assumptions.
- **Switch to Uniswap V4 pricing** post-graduation. Preserves the premise, needs a
  real V4 integration, reintroduces "trust the source."
- **Grace period.** Freeze entries before expected completion, drain outstanding
  rounds, close cleanly at graduation.

The design gap is intentional-to-surface, not an oversight to quietly patch.

## Two dead contracts

- `0xa2d189884c34c6c94c2f88d6ee6f42ed8ce1f870` — round 2
- `0xfd6c37b68a3d9b2aacf4f34af122936bca75accb` — round 3

Both share identical wiring, nothing points at them, and neither is in the
production bundle. Any winning entry from their still-open rounds is currently
unsettleable. Decide whether to abandon them explicitly.

## Bugs found and fixed this session

All display-only — the contract was never wrong, because `_pnlWad` uses prices
strictly as a ratio. Each produced a *plausible* wrong number, which is why
none were caught by a passing build and test suite.

1. **Price read from the wrong contract.** `spotPriceWad()` was called on
   `GAME_ADDRESS`, which has no such function. It reverts, the `catch` swallows
   it, price silently stays 0 → "▼ 100.00% since round open." Now `CURVE_ADDRESS`.
2. **`decimals` passed to `formatUnits()` as a scale, not precision.**
   `formatUnits(x, 4)` divides by 1e4 → 3.79 rendered as **379078.83**.
3. **Wrong 1e9 scale assumption** (my own regression, in `cb6e90e`). I claimed
   the curve returns 1e9 "despite the name." It is a true **18-decimal wad**.
   Settled empirically: `spot × virtualTokenReserve ÷ virtualEthReserve` = 1.000000
   at 1e18, off by 1e6 at 1e9. Sanity check that should have caught it first: a
   2.6 ETH curve with 729M tokens is worth ~3.6 **nano**-ETH per token.
4. **Flat price showed a green up-arrow** claiming an unrealised gain.
5. **Duplicate "Curve Racer" heading** — `page.tsx` still rendered the old header.

## Verification approach (learned the hard way)

- A screenshot is the only real UI check. Twice now the UI looked "done" and
  wasn't. **Always screenshot a production build**, never a dev server.
- First screenshot came back unstyled and I nearly shipped it. Cause: a stale dev
  server held the port, so `next start` never started and I screenshotted an
  unstyled dev bundle. Check `buildId` is not `development` and the CSS href is
  hashed.
- Bundle verification must intercept **runtime** network responses. Grepping the
  served HTML for addresses finds nothing — the page chunk loads via JS.
- Invariant tests beat arguments about scales. The reserve-ratio test now pins the
  spot-price scale so it cannot be re-derived wrong a third time.
- `virtualTokenReserve` is **27-decimal** scaled, not 18. Easy to get wrong.

## Test state

- Vitest **52/52** (4 files) — `play`, `ticker`, `components`, `format`
- Forge **33/33**, Anvil E2E **17/17**
- Price displays in **nano-ETH** (1 nano-ETH = 1 gwei, so nothing is invented);
  plain ETH is `0.0000000034` and unusable at sane precision.

## Not done / next

1. **Decide the graduation question** (above). Everything else is polish.
2. **End-to-end wallet flow never exercised** — no wallet connected, no stake
   entered. All four entry bugs were post-connection. This is the biggest gap.
3. Real trade flow on the curve: spot moved 3.77 → 3.38 nano-ETH during the
   session (-10%). Earlier claim that the price was "completely static" was
   based on 6 samples over 12s and was **too narrow a window** — the curve does
   move, slowly.
4. `IVibeCurve.sol:35` says "18-decimal wad" — now correct, but read the whole
   interface against deployed bytecode; one comment was confidently wrong in both
   directions this session.
5. Playwright browser download is blocked; cached `chromium-1228` works via
   `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome` + `--no-sandbox`.
6. Screenshot helper is at `/tmp/verify-wiring.mjs` style scripts — recreate
   rather than look for it in the repo (correctly not committed).

## Files that matter

- `contracts/CurveRacer.sol` — the entire game. `_spotPrice()` at line 222 is the
  graduation gap. `assetForWager()` at 190 is the working half.
- `contracts/interfaces/IVibeCurve.sol`
- `app/lib/game.ts` — chain reads, `formatSpot` (true ETH), `formatSpotNano`
- `app/lib/play.ts` — pure label/state logic, all copy comes from here
- `app/components/GameBoard.tsx` — the rebuilt board
- `app/components/game/` — countdown ring, sparkline, join panel, leaderboard
- `app/__tests__/format.test.ts` — pins the price scale via the reserve invariant
- `script/keeper.mjs` — permissionless keeper

## Secrets

`curve-racer-keeper.json`, `curve-racer-wallet.json`, `app/.env.local` are
git-ignored and untracked (verified). Keeper wallet is gas-only:
`0xfE0131e65d60DD41B7c4F800055379F890EE6fbc`. **Never** let the keeper fall back
to the treasury key — that failure mode was removed deliberately.
