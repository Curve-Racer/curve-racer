// Deploy CurveRacer to Robinhood Chain Testnet, priced off a real live vibe
// curve.
//
//   node script/deploy-testnet.mjs
//
// This deploys the GAME ONLY. It does not create a token, does not call
// launch.js, and spends no creation fee. The game is wired to an existing
// curve so it can run pre-graduation (ETH wagers, price-based PnL) and will
// arm token custody on CurveCompleted for that same curve.
//
// The token argument is the token that curve controls. Pre-graduation the
// contract never touches it — custodyAvailable() gates on curve.graduated().

import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.TESTNET_RPC || 'https://robinhood-testnet.drpc.org';

const testnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

// Live vibe/vibe curve verified on-chain 2026-09-26: spotPriceWad 1907610516.
const CURVE = '0x7bc42e8a2df6070ae7d1ca720cd5408e8354fc20';
const TOKEN = '0x478c36fd287d2c600f42859ba9561fd46b230e2d';

const artifact = (n) =>
  JSON.parse(readFileSync(new URL(`../out/${n}.json`, import.meta.url), 'utf8'));

const VIBE_CURVE = [
  { type: 'function', inputs: [], name: 'spotPriceWad', outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', inputs: [], name: 'graduated', outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', inputs: [], name: 'token', outputs: [{ type: 'address' }], stateMutability: 'view' },
];

async function main() {
  const wallets = JSON.parse(readFileSync(new URL('file:///home/administrator/.hermes/profiles/hunter/wallets/robinhood-testnet.json'), 'utf8'));
  const pk = wallets.privateKey || wallets.key || wallets.private_key;
  if (!pk) throw new Error('no privateKey in robinhood-testnet.json');
  const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);

  const pub = createPublicClient({ chain: testnet, transport: http(RPC, { timeout: 30_000 }) });
  const wallet = createWalletClient({ chain: testnet, transport: http(RPC), account: acct });

  console.log(`deployer  ${acct.address}`);
  console.log(`balance   ${formatUnits(await pub.getBalance({ address: acct.address }), 18)} ETH`);
  console.log(`nonce     ${await pub.getTransactionCount({ address: acct.address })}`);

  // Confirm the curve is live and is the token we expect.
  const [spot, graduated, curveToken] = await Promise.all([
    pub.readContract({ address: CURVE, abi: VIBE_CURVE, functionName: 'spotPriceWad' }),
    pub.readContract({ address: CURVE, abi: VIBE_CURVE, functionName: 'graduated' }),
    pub.readContract({ address: CURVE, abi: VIBE_CURVE, functionName: 'token' }),
  ]);
  console.log(`\ncurve    ${CURVE}`);
  console.log(`  spot     ${formatUnits(spot, 9)} ETH/token`);
  console.log(`  grad'd   ${graduated}`);
  console.log(`  token    ${curveToken}`);
  if (curveToken.toLowerCase() !== TOKEN.toLowerCase()) {
    console.log(`\nNOTE: curve reports token ${curveToken}, expected ${TOKEN}`);
  }

  const game = artifact('CurveRacer.sol/CurveRacer');
  console.log('\ndeploying game…');
  const hash = await wallet.deployContract({
    abi: game.abi,
    bytecode: game.bytecode.object,
    args: [CURVE, TOKEN, acct.address],
    account: acct,
  });
  console.log(`  tx ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const gameAddr = receipt.contractAddress;
  console.log(`  status ${receipt.status}`);
  console.log(`  gas    ${receipt.gasUsed} @ ${formatUnits(receipt.effectiveGasPrice, 9)} gwei`);
  console.log(`  cost   ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} ETH`);
  console.log(`\nGAME = ${gameAddr}`);

  if (receipt.status !== 'success' || !gameAddr) throw new Error('deploy failed');

  // Wire the frontend at the live testnet deployment.
  const env = [
    `NEXT_PUBLIC_GAME_ADDRESS=${gameAddr}`,
    `NEXT_PUBLIC_CURVE_ADDRESS=${CURVE}`,
    `NEXT_PUBLIC_RPC_URL=${RPC}`,
    `NEXT_PUBLIC_CHAIN_ID=46630`,
    `NEXT_PUBLIC_IS_LOCAL=false`,
    '',
  ].join('\n');
  writeFileSync(new URL('../app/.env.local', import.meta.url), env);
  writeFileSync(new URL('../app/.env.production', import.meta.url), env);
  console.log('wrote app/.env.local and app/.env.production');

  // Verify the deployed instance.
  const abi = game.abi;
  const [roundBlocks, minEntrants, rakeBps, treasury, custody, roundId, state] = await Promise.all([
    pub.readContract({ address: gameAddr, abi, functionName: 'ROUND_BLOCKS' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'MIN_ENTRANTS' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'RAKE_BPS' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'treasury' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'custodyAvailable' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'currentRoundId' }),
    pub.readContract({ address: gameAddr, abi, functionName: 'roundState', args: [1n] }),
  ]);
  console.log('\nverified on-chain:');
  console.log(`  ROUND_BLOCKS     ${roundBlocks}  (~${Number(roundBlocks) / 10}s)`);
  console.log(`  MIN_ENTRANTS     ${minEntrants}`);
  console.log(`  RAKE_BPS         ${rakeBps}`);
  console.log(`  treasury         ${treasury}`);
  console.log(`  custodyAvailable ${custody}  (false pre-graduation, as expected)`);
  console.log(`  currentRoundId   ${roundId}`);
  console.log(`  round 1 entryPx  ${formatUnits(state[7], 9)} ETH/token`);
  console.log(`  explorer         https://explorer.testnet.chain.robinhood.com/address/${gameAddr}`);
}

main().catch((e) => { console.error('\nDEPLOY FAILED:', e.shortMessage || e.message); process.exit(1); });
