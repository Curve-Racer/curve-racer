import { createPublicClient, http, defineChain, type PublicClient } from 'viem';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://robinhood-testnet.drpc.org';
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630);
const IS_LOCAL = process.env.NEXT_PUBLIC_IS_LOCAL === 'true';

const EXPLORER = IS_LOCAL
  ? 'http://127.0.0.1:8545'
  : 'https://explorer.testnet.chain.robinhood.com';

/**
 * Chain config is env-driven so the same build runs against local anvil
 * (31337) and Robinhood Chain Testnet (46630) without code changes. The
 * local branch exists for the two-player demo and needs no block explorer,
 * so tx links are only emitted when one is configured.
 */
export const activeChain = defineChain({
  id: CHAIN_ID,
  name: IS_LOCAL ? 'Anvil (local)' : 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Block Explorer', url: EXPLORER },
  },
  testnet: true,
});

export const hasExplorer = !IS_LOCAL;

export const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(RPC_URL, { timeout: 20_000 }),
});

/** Deployed game address. Set NEXT_PUBLIC_GAME_ADDRESS once deployed. */
export const GAME_ADDRESS = (process.env.NEXT_PUBLIC_GAME_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const isGameDeployed = GAME_ADDRESS !== '0x0000000000000000000000000000000000000000';

/**
 * The Pons bonding curve the game prices off — the curve for $RACER.
 *
 * Defaults to the game address, which is only correct when CurveRacer is
 * deployed with a curve that happens to sit at the same address. Set
 * NEXT_PUBLIC_CURVE_ADDRESS to the real curve — the live testnet curve is
 * 0x6627e9133a81f01c95c461bf71402a9000d06c45, whose token() is
 * 0xc9A12f02A2aeB173154552179b6ec70A16533678.
 */
export const CURVE_ADDRESS = (process.env.NEXT_PUBLIC_CURVE_ADDRESS || GAME_ADDRESS) as `0x${string}`;

export const explorerTx = (hash: `0x${string}`) =>
  `${activeChain.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: `0x${string}`) =>
  `${activeChain.blockExplorers.default.url}/address/${a}`;
