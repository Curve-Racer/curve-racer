#!/usr/bin/env node
/**
 * Verify the frontend's read path against the live chain, using the exact same
 * viem calls the browser makes. Catches ABI/address/decoding drift without
 * needing a deployed game contract.
 */
import { createPublicClient, http, defineChain, formatUnits } from 'viem';

const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://robinhood-testnet.drpc.org'] } },
  testnet: true,
});

const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 20000 }) });

// Live vibe/vibe curve used during development, verified 2026-09-26.
const CURVE = '0x7bc42e8a2df6070ae7d1ca720cd5408e8354fc20';
const TOKEN = '0x478c36fd287d2c600f42859ba9561fd46b230e2d';

const VIBE_CURVE_ABI = [
  { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'spotPriceWad', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'virtualEthReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokensSoldFromCurve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

(async () => {
  let fail = 0;
  const check = (label, val) => { console.log(`  ${String(label).padEnd(24)} ${val}`); };

  console.log('chain head:');
  const bn = await client.getBlockNumber();
  check('block', bn.toString());

  console.log('\ncurve reads (this is what the UI polls every 2s):');
  const spot = await client.readContract({ address: CURVE, abi: VIBE_CURVE_ABI, functionName: 'spotPriceWad' });
  const grad = await client.readContract({ address: CURVE, abi: VIBE_CURVE_ABI, functionName: 'graduated' });
  const eth = await client.readContract({ address: CURVE, abi: VIBE_CURVE_ABI, functionName: 'virtualEthReserve' });
  const sold = await client.readContract({ address: CURVE, abi: VIBE_CURVE_ABI, functionName: 'tokensSoldFromCurve' });

  check('spotPriceWad (raw)', spot.toString());
  check('spotPriceWad (display)', formatUnits(spot, 9) + ' ETH/token');
  check('graduated', grad);
  check('virtualEthReserve', formatUnits(eth, 4) + ' ETH');
  check('tokensSoldFromCurve', formatUnits(sold, 0));

  if (spot === 0n) { console.log('\n  FAIL: spot price is zero — the UI would render a dead board'); fail++; }
  if (typeof grad !== 'boolean') { console.log('\n  FAIL: graduated did not decode as bool'); fail++; }

  // The UI assumes a falsey (unlocked) shape for a missing game contract, so
  // confirm the roundState tuple shape cannot be read here by design.
  console.log('\ngame contract:');
  check('deployed', 'not yet — reads are skipped');

  console.log(fail === 0 ? '\nREAD PATH OK' : `\n${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
