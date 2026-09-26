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
    roundBlocks: await read('ROUND_BLOCKS'),
    minEntrants: await read('MIN_ENTRANTS'),
    rakeBps: await read('RAKE_BPS'),
  };
  console.log(`config: ${cfg.roundBlocks} blocks (~${Number(cfg.roundBlocks) / 10}s), ` +
              `min ${cfg.minEntrants}, rake ${cfg.rakeBps}bps\n`);

  const roundId = await read('currentRoundId');
  console.log(`--- round ${roundId} ---`);

  // roundState returns a 9-tuple; viem hands it back as an ARRAY, so fields
  // must be read positionally. Order matches CurveRacer.roundState:
  //   0 id, 1 openBlock, 2 closeBlock, 3 phase, 4 totalStake,
  //   5 pot, 6 rake, 7 entryPriceWad, 8 voided
  // Phase enum is Idle=0, Open=1, Settled=2 — NOT Open=0.
  const PHASE = { IDLE: 0, OPEN: 1, SETTLED: 2 };
  const RS = (st) => ({
    id: st[0], openBlock: st[1], closeBlock: st[2], phase: Number(st[3]),
    totalStake: st[4], pot: st[5], rake: st[6], entryPriceWad: st[7], voided: st[8],
  });

  // Anvil mines ~10 blocks/sec, so a 30s round can expire before this script
  // even starts. Settle any closed-but-unsettled round to force a fresh one
  // open, and require enough headroom to enter twice plus settle.
  async function ensureOpenRound(minHeadroom = 40n) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const id = await read('currentRoundId');
      const st = RS(await read('roundState', [id]));
      const head = await pub.getBlockNumber();
      const headroom = st.closeBlock - head;

      if (st.phase === PHASE.SETTLED) {
        console.log(`round ${id} settled — waiting for the next to open`);
        await sleep(1200);
        continue;
      }
      if (st.phase !== PHASE.OPEN || headroom <= 0n) {
        console.log(`round ${id} not open (phase ${st.phase}, headroom ${headroom}) — settling to roll forward`);
        await send(w2, GAME, GAME_ABI, 'settle', []);
        continue;
      }
      if (headroom < minHeadroom) {
        console.log(`round ${id} only ${headroom} blocks left — rolling forward`);
        await send(w2, GAME, GAME_ABI, 'settle', []);
        continue;
      }
      console.log(`round ${id} OPEN, ${headroom} blocks (~${(Number(headroom) / 10).toFixed(1)}s) headroom`);
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

  // Move the curve up mid-round so PnL diverges between the two players.
  const priceBefore = st.entryPriceWad;
  await send(w1, CURVE, CURVE_CTL, 'bumpPrice', [300n]); // +3%
  const priceAfter = await pub.readContract({ address: CURVE, abi: CURVE_CTL, functionName: 'spotPriceWad' });
  ok('curve price moved up', priceAfter > priceBefore,
     `${formatUnits(priceBefore, 9)} -> ${formatUnits(priceAfter, 9)}`);

  // B's larger stake should now have the better percentage PnL only if prices
  // differ; with a common entry price both move identically, so compare the
  // contract's own pnlWad() for each stake.
  const pnl1 = await read('pnlWad', [stake1, priceBefore, priceAfter]);
  const pnl2 = await read('pnlWad', [stake2, priceBefore, priceAfter]);
  ok('both players profitable on a rising curve', pnl1 > 0n && pnl2 > 0n,
     `A +${formatEther(pnl1)} | B +${formatEther(pnl2)}`);
  ok('pnl scales with stake', pnl2 > pnl1,
     `B stakes 2x A so B pnl is ${Number(pnl2 / pnl1)}x`);

  // Wait out the round window so settle() will accept the call.
  const target = st.closeBlock;
  let head = await pub.getBlockNumber();
  console.log(`\nwaiting for close (block ${target}, at ${head})…`);
  while (head < target) { await sleep(1000); head = await pub.getBlockNumber(); }
  await sleep(500);
  ok('round window elapsed', (await pub.getBlockNumber()) >= target);
  // Permissionless settle — anyone may call it, so use B as a neutral party.
  // Snapshot B's balance first: the payout goes out inside this same call.
  const balBefore = await pub.getBalance({ address: B });
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

  const e1 = await read('entryOf', [openRoundId, A]);
  const e2 = await read('entryOf', [openRoundId, B]);
  ok('winner B marked paid', e2.paidOut === true);
  ok('loser A not marked paid', e1.paidOut === false);

  // payout is sent during settle() to the winner; verify B's balance moved.
  const balAfter = await pub.getBalance({ address: B });
  const r = lastReceipt;
  const gas = r ? r.gasUsed * r.effectiveGasPrice : 0n;
  const gained = balAfter - balBefore;
  ok('winner B balance increased net of gas', gained > 0n,
     `+${formatEther(gained)} ETH (paid ${formatEther(gas)} gas)`);
  ok('payout matches pot', gained + gas >= after.pot,
     `pot ${formatEther(after.pot)} vs net+gain ${formatEther(gained + gas)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nERROR:', e.shortMessage || e.message); process.exit(1); });
