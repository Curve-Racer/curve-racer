// End-to-end two-player round against the local anvil chain.
//
// Plays a real game: two players enter the same round, the curve price moves
// mid-round, the round closes, someone settles, and the payout is checked
// against the contract's own arithmetic. This exercises the same functions the
// browser calls, so a pass here means the demo path works.
//
//   node script/play-local.mjs

import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, parseEther, formatEther, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545';
const KEY1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const anvil = defineChain({
  id: 31337, name: 'Anvil (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
});

const env = Object.fromEntries(
  readFileSync(new URL('../app/.env.local', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => l.split('='))
);

const GAME = env.NEXT_PUBLIC_GAME_ADDRESS;
const CURVE = env.NEXT_PUBLIC_CURVE_ADDRESS;

const { abi: GAME_ABI } = JSON.parse(readFileSync(new URL('../out/CurveRacer.sol/CurveRacer.json', import.meta.url), 'utf8'));
const CURVE_CTL = [
  { type: 'function', inputs: [{ name: 'd', type: 'int256' }], name: 'bumpPrice', outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', inputs: [], name: 'spotPriceWad', outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

const pub = createPublicClient({ chain: anvil, transport: http(RPC) });
const mk = (pk) => createWalletClient({ chain: anvil, transport: http(RPC), account: privateKeyToAccount(pk) });

const w1 = mk(KEY1), w2 = mk(KEY2);
const A = w1.account.address, B = w2.account.address;

let pass = 0, fail = 0;
let lastReceipt = null;
const ok = (label, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};

const send = async (w, address, abi, functionName, args, value) => {
  const hash = await w.writeContract({ address, abi, functionName, args, account: w.account, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${r.status}`);
  return r;
};

const read = (fn, args = [], address = GAME, abi = GAME_ABI) =>
  pub.readContract({ address, abi, functionName: fn, args });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`game  ${GAME}\ncurve ${CURVE}\n`);

  const cfg = {
    roundSeconds: await read('ROUND_SECONDS'),
    minEntrants: await read('MIN_ENTRANTS'),
    rakeBps: await read('RAKE_BPS'),
  };
  console.log(`config: ${cfg.roundSeconds}s rounds, min ${cfg.minEntrants}, ` +
              `rake ${cfg.rakeBps}bps\n`);

  const roundId = await read('currentRoundId');
  console.log(`--- round ${roundId} ---`);

  // roundState returns an 11-tuple; viem hands it back as an ARRAY, so fields
  // must be read positionally. Order matches CurveRacer.roundState:
  //   0 id, 1 openBlock, 2 closeBlock, 3 openTimestamp, 4 closeTimestamp,
  //   5 phase, 6 totalStake, 7 pot, 8 rake, 9 entryPriceWad, 10 voided
  // Phase enum is Idle=0, Open=1, Settled=2 — NOT Open=0.
  const PHASE = { IDLE: 0, OPEN: 1, SETTLED: 2 };
  const RS = (st) => ({
    id: st[0], openBlock: st[1], closeBlock: st[2],
    openTimestamp: st[3], closeTimestamp: st[4],
    phase: Number(st[5]),
    totalStake: st[6], pot: st[7], rake: st[8], entryPriceWad: st[9], voided: st[10],
  });

  // A round can expire before this script even gets going. Headroom is measured
  // with the contract's own secondsRemaining(), not by subtracting blocks —
  // the round closes on wall-clock time, so block arithmetic is the wrong
  // measure of how much room is left.
  async function ensureOpenRound(minSeconds = 8n) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const id = await read('currentRoundId');
      const st = RS(await read('roundState', [id]));
      const secsLeft = await read('secondsRemaining');

      if (st.phase === PHASE.SETTLED) {
        console.log(`round ${id} settled — waiting for the next to open`);
        await sleep(1200);
        continue;
      }
      if (st.phase !== PHASE.OPEN || secsLeft === 0n) {
        console.log(`round ${id} not open (phase ${st.phase}, ${secsLeft}s left) — settling to roll forward`);
        await send(w2, GAME, GAME_ABI, 'settle', []);
        continue;
      }
      if (secsLeft < minSeconds) {
        console.log(`round ${id} only ${secsLeft}s left — rolling forward`);
        await send(w2, GAME, GAME_ABI, 'settle', []);
        continue;
      }
      console.log(`round ${id} OPEN, ${secsLeft}s headroom`);
      return id;
    }
    throw new Error('could not get an open round with headroom');
  }

  const openRoundId = await ensureOpenRound();

  // Both players enter the same open round at the same entry price.
  const stake1 = parseEther('0.01');
  const stake2 = parseEther('0.02');

  await send(w1, GAME, GAME_ABI, 'enter', [], stake1);
  console.log(`\nA entered ${formatEther(stake1)} ETH`);
  await send(w2, GAME, GAME_ABI, 'enter', [], stake2);
  console.log(`B entered ${formatEther(stake2)} ETH`);

  const st = RS(await read('roundState', [openRoundId]));
  ok('two entrants recorded', (await read('entrants', [openRoundId])).length === 2);
  ok('total stake is sum of both', st.totalStake === stake1 + stake2,
     `${formatEther(st.totalStake)} ETH`);
  ok('entry price snapshotted once', st.entryPriceWad > 0n,
     formatUnits(st.entryPriceWad, 9) + ' ETH/token');

  // The round's entry price is snapshotted when the round opens, which happens
  // before this script bumps the mock. So a "+3%" bump on the CURRENT spot can
  // still land below the entry price, leaving every entrant on a loss. The
  // winner is then whoever lost least, which is not necessarily the larger
  // stake. Assert on the contract's own winner rather than assuming B, and
  // bump the spot by enough to clear the entry price so the PnL path is the
  // intended "rising curve" one.
  const entryPrice = st.entryPriceWad;
  const priceBefore = await pub.readContract({ address: CURVE, abi: CURVE_CTL, functionName: 'spotPriceWad' });
  // Rise at least 5% above the entry price so the round is unambiguously a win.
  const needBps = BigInt(Math.ceil(((Number(entryPrice) * 1.05) / Number(priceBefore) - 1) * 10_000)) + 50n;
  await send(w1, CURVE, CURVE_CTL, 'bumpPrice', [needBps]);
  const priceAfter = await pub.readContract({ address: CURVE, abi: CURVE_CTL, functionName: 'spotPriceWad' });
  ok('curve price moved up', priceAfter > priceBefore,
     `${formatUnits(priceBefore, 9)} -> ${formatUnits(priceAfter, 9)}`);
  ok('curve rose above the round entry price', priceAfter > entryPrice,
     `entry ${formatUnits(entryPrice, 9)} -> ${formatUnits(priceAfter, 9)}`);

  // B's larger stake should now have the better percentage PnL only if prices
  // differ; with a common entry price both move identically, so compare the
  // contract's own pnlWad() for each stake.
  const pnl1 = await read('pnlWad', [stake1, priceBefore, priceAfter]);
  const pnl2 = await read('pnlWad', [stake2, priceBefore, priceAfter]);
  ok('both players profitable on a rising curve', pnl1 > 0n && pnl2 > 0n,
     `A +${formatEther(pnl1)} | B +${formatEther(pnl2)}`);
  ok('pnl scales with stake', pnl2 > pnl1,
     `B stakes 2x A so B pnl is ${Number(pnl2 / pnl1)}x`);

  // Wait out the round window so settle() will accept the call. Poll the
  // contract's own clock rather than a block target — the deadline is
  // wall-clock, and chasing closeBlock would be both wrong and slower.
  console.log(`\nwaiting for close (${await read('secondsRemaining')}s left)…`);
  let secsLeft = await read('secondsRemaining');
  while (secsLeft > 0n) { await sleep(1000); secsLeft = await read('secondsRemaining'); }
  await sleep(500);
  ok('round window elapsed', (await read('secondsRemaining')) === 0n);
  // Permissionless settle — anyone may call it, so use B as a neutral party.
  // Snapshot both balances first: the payout goes out inside this same call,
  // and the winner is whichever player the contract picked.
  const balBeforeA = await pub.getBalance({ address: A });
  const balBeforeB = await pub.getBalance({ address: B });
  lastReceipt = await send(w2, GAME, GAME_ABI, 'settle', []);
  const after = RS(await read('roundState', [openRoundId]));
  ok('round settled', after.phase === PHASE.SETTLED, `phase ${after.phase}`);

  // pot is the distributable pot AFTER the rake is withheld, so rake is 2.5%
  // of the gross stake and pot == stake - rake.
  const expectedRake = (after.totalStake * cfg.rakeBps) / 10_000n;
  ok('rake is 2.5% of gross stake', after.rake === expectedRake,
     `${formatEther(after.rake)} ETH of ${formatEther(after.totalStake)} gross`);
  ok('pot is stake minus rake', after.pot === after.totalStake - after.rake,
     `${formatEther(after.pot)} = ${formatEther(after.totalStake)} - ${formatEther(after.rake)}`);
  ok('not voided (real winner)', after.voided === false);

  // Read the winner the contract actually chose. With a common entry price,
  // PnL is proportional to stake, so on a rising curve the larger stake (B)
  // wins — but assert against bestPlayer() rather than hardcoding B, so the
  // test reports what happened instead of assuming.
  const [bestPnl, bestPlayer] = await read('leaderboard');
  const e1 = await read('entryOf', [openRoundId, A]);
  const e2 = await read('entryOf', [openRoundId, B]);
  const winnerIsB = String(bestPlayer).toLowerCase() === B.toLowerCase();
  ok('winner is the higher-PnL player', winnerIsB,
     `bestPlayer ${String(bestPlayer).slice(0, 8)}… pnl ${formatEther(bestPnl)}`);
  ok('winner marked paid', winnerIsB ? e2.paidOut === true : e1.paidOut === true);
  ok('loser not marked paid', winnerIsB ? e1.paidOut === false : e2.paidOut === false);

  // payout is sent during settle() to the winner; verify their balance moved.
  const winner = winnerIsB ? B : A;
  const balBefore = winnerIsB ? balBeforeB : balBeforeA;
  const balAfter = await pub.getBalance({ address: winner });
  const r = lastReceipt;
  const gas = r ? r.gasUsed * r.effectiveGasPrice : 0n;
  const gained = balAfter - balBefore;
  ok('winner balance increased net of gas', gained > 0n,
     `+${formatEther(gained)} ETH (paid ${formatEther(gas)} gas)`);
  ok('payout matches pot', gained + gas >= after.pot,
     `pot ${formatEther(after.pot)} vs net+gain ${formatEther(gained + gas)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nERROR:', e.shortMessage || e.message); process.exit(1); });
