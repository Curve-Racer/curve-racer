#!/usr/bin/env node
/**
 * Curve Racer keeper.
 *
 * The EVM has no scheduler, so an expired round does not settle itself. Without
 * a keeper, a round that closes while nobody is watching sits dead: the board
 * shows a stale round, and the only way forward is for a human to press
 * "settle". The contract also auto-advances on enter(), so a stuck round is
 * never a lockout — but a keeper keeps the board live and honest in between.
 *
 * Layer 2 of 2. The contract's lazy auto-advance is the durability guarantee
 * (progress even if this process dies); this is the liveness guarantee (the
 * board advances on its own). Either alone has a failure mode; together the
 * game never stalls and never wedges.
 *
 * Usage: node script/keeper.mjs [--once]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ONCE = process.argv.includes('--once');

/** Read config: process.env first, then app/.env.local. */
const envPath = new URL('../app/.env.local', import.meta.url);
const env = {};
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no env file — process.env only */ }
// process.env wins, so a key injected by systemd or the shell is never
// shadowed by a stale value baked into .env.local.
const cfg = (k) => process.env[k] || env[k];

const RPC = cfg('NEXT_PUBLIC_RPC_URL') || 'https://robinhood-testnet.drpc.org';
const GAME = cfg('NEXT_PUBLIC_GAME_ADDRESS');

if (!GAME || !/^0x[a-fA-F0-9]{40}$/.test(GAME)) {
  console.error('keeper: NEXT_PUBLIC_GAME_ADDRESS missing or malformed — aborting');
  process.exit(1);
}

const ABI = parseAbi([
  'function secondsRemaining() view returns (uint256)',
  'function currentRoundId() view returns (uint64)',
  'function roundState(uint64) view returns (uint64 id, uint64 openBlock, uint64 closeBlock, uint64 openTimestamp, uint64 closeTimestamp, uint8 phase, uint256 totalStake, uint256 pot, uint256 rake, uint256 entryPriceWad, bool voided)',
  'function settle()',
  'function totalRoundsSettled() view returns (uint256)',
]);

const pub = createPublicClient({ transport: http(RPC, { timeout: 20_000 }) });

/**
 * Load the keeper key. ONLY an explicitly-named keeper key is accepted.
 *
 * Earlier this fell back to curve-racer-wallet.json, which is the DEPLOYER /
 * TREASURY key. A keeper that spends the treasury's gas on every round is a
 * foot-gun, and a silent fallback to it is worse: the process reported itself
 * as settling while actually using an unrelated wallet. Fail loudly instead.
 */
function loadKey() {
  const k = cfg('KEEPER_PRIVATE_KEY');
  if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) return k;
  // A dedicated key file is the normal production setup; the systemd unit
  // points at it via KEEPER_KEY_FILE. Never fall back to the deployer wallet.
  const file = cfg('KEEPER_KEY_FILE') || new URL('../curve-racer-keeper.json', import.meta.url).pathname;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j.privateKey && /^0x[0-9a-fA-F]{64}$/.test(j.privateKey)) return j.privateKey;
  } catch { /* absent or unreadable — handled below */ }
  return null;
}

const KEY = loadKey();
if (!KEY) {
  console.error('keeper: no private key found (set KEEPER_PRIVATE_KEY or provide curve-racer-keeper.json) — running read-only');
}
const wallet = KEY
  ? createWalletClient({ account: privateKeyToAccount(KEY), transport: http(RPC, { timeout: 20_000 }) })
  : null;

/** Settle the current round if it has expired. Returns a short status string. */
async function tick() {
  const [secs, roundId, settled] = await Promise.all([
    pub.readContract({ address: GAME, abi: ABI, functionName: 'secondsRemaining' }),
    pub.readContract({ address: GAME, abi: ABI, functionName: 'currentRoundId' }),
    pub.readContract({ address: GAME, abi: ABI, functionName: 'totalRoundsSettled' }),
  ]);
  if (secs > 0n) return `round ${roundId} live, ${secs}s left`;

  if (!wallet) return `round ${roundId} EXPIRED — no key, cannot settle`;

  const before = settled;
  try {
    const hash = await wallet.writeContract({
      address: GAME, abi: ABI, functionName: 'settle', account: wallet.account, chain: null,
    });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (r.status === 'success') {
      return `round ${roundId} expired -> SETTLED in ${hash.slice(0, 10)} (total ${before} -> ${before + 1n})`;
    }
    return `round ${roundId} settle failed: status ${r.status}`;
  } catch (e) {
    // A lost race is normal and harmless: another tx settled it first.
    const msg = String(e.shortMessage || e.message || e).slice(0, 140);
    return `round ${roundId} settle reverted: ${msg}`;
  }
}

if (ONCE) {
  if (wallet) console.log(`keeper: settling as ${wallet.account.address} (bal ${await pub.getBalance({ address: wallet.account.address })} wei)`);
  console.log(await tick());
  process.exit(0);
}

console.log(`keeper: watching ${GAME} on ${RPC}`);
if (wallet) console.log(`keeper: settling as ${wallet.account.address}`);
let failures = 0;
while (true) {
  try {
    console.log(new Date().toISOString(), await tick());
    failures = 0;
  } catch (e) {
    // Never die on a transient RPC hiccup — a keeper that exits is a keeper
    // that stops keeping. Back off on repeated errors.
    failures++;
    console.error(new Date().toISOString(), 'keeper error:', String(e.shortMessage || e).slice(0, 160));
    if (failures >= 5) {
      const wait = Math.min(60, 5 * failures);
      console.error(`keeper: ${failures} consecutive failures, backing off ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  await new Promise((r) => setTimeout(r, 8000));
}
