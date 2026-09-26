# Running Curve Racer locally (anvil)

A two-player local demo. No real funds, no testnet spend, nothing to clean up
but killing anvil.

## Why anvil needs a flag

`anvil --block-time 0.1`

The game round is 300 blocks and is designed to last ~30 seconds, which assumes
Robinhood Chain Testnet's ~100ms block time. Anvil's default is to mine a block
per transaction, which would make the round window meaningless. The flag
reproduces the real cadence so the countdown and the 30-second promise in the UI
are both truthful locally.

## Steps

```bash
# 1. start the chain (leave this running)
export PATH="$HOME/.foundry/bin:$PATH"
anvil --block-time 0.1 --port 8545 --host 127.0.0.1

# 2. build + deploy the game and the vibe/vibe mocks
cd ~/curve-racer
forge build
node script/deploy-local.mjs

# 3. start the frontend (new shell, it reads app/.env.local)
cd ~/curve-racer/app
npm run dev
```

Open http://localhost:3111.

## Add the network to MetaMask

- Network: **Anvil (local)**
- RPC URL: **http://127.0.0.1:8545**
- Chain ID: **31337**
- Currency symbol: **ETH**

Then import a funded account. `script/deploy-local.mjs` prints them; the first
three are anvil's default test keys:

| Player | Address | Private key |
|---|---|---|
| 1 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| 2 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| 3 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

These are public, well-known anvil test keys. Never send them real funds.

**For a two-player demo you need two browser profiles or two browsers** —
MetaMask holds one account per profile. Use a normal window and a private
window, or Chrome + Firefox.

## Playing a round

1. Both players connect and enter the same round. The UI shows a countdown.
2. Move the price so the leaderboard moves: the mock curve has
   `bumpPrice(int256 basisPoints)`.
   ```bash
   export PATH="$HOME/.foundry/bin:$PATH"
   cast send <CURVE> "bumpPrice(int256)" 500 \
     --rpc-url http://127.0.0.1:8545 --private-key 0xac09...   # +5%
   ```
3. When the window closes, anyone can call **Settle**. Winner takes pot − 2.5%
   rake. Ties split evenly. A round with fewer than two entrants is voided and
   refunded in full.

## Automated play (no browser)

`script/play-local.mjs` plays a complete round between two funded accounts and
asserts the payout arithmetic against the contract:

```bash
node script/play-local.mjs
```

It rolls forward expired rounds first, because anvil mines fast enough that a
round can close before a human finishes reading the page.

## What is real and what is mocked

Real: `CurveRacer.sol` — the entire game. Same bytecode as testnet.

Mocked: the vibe/vibe curve and token (`script/mocks/MockVibe.sol`), because a
real token requires launching one. The mock reproduces the pre-graduation
transfer lock, and its starting `spotPriceWad` is seeded from a real reading off
Robinhood Chain Testnet, so the numbers on screen are plausible.

The mock token still cannot be used as a wager until `unlock()` is called,
mirroring the real transfer lock. That is the honest pre-graduation state.

## Known caveats

- `next dev` was verified; `next build` + `next start` was verified before the
  local wiring was added. Re-run the build if you serve the production bundle.
- A round that expires with **zero** entrants used to brick the contract
  (divide-by-zero in `settle()`). Fixed in `CurveRacer.sol` and covered by
  `test_SettleWithZeroEntrantsDoesNotBrick`. Found by playing on a live node
  rather than in unit tests — the unit tests never covered a truly empty round.
