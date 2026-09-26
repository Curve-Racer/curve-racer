import { createPublicClient, http, defineChain, type PublicClient } from 'viem';

// Robinhood Chain Testnet, verified on-chain 2026-09-26.
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL || 'https://robinhood-testnet.drpc.org'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

export const publicClient: PublicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(robinhoodTestnet.rpcUrls.default.http[0], { timeout: 20_000 }),
});

/** Deployed game address. Set NEXT_PUBLIC_GAME_ADDRESS once deployed. */
export const GAME_ADDRESS = (process.env.NEXT_PUBLIC_GAME_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const isGameDeployed = GAME_ADDRESS !== '0x0000000000000000000000000000000000000000';

/**
 * The vibe/vibe bonding curve the game prices off.
 *
 * Defaults to the game address, which is only correct when CurveRacer is
 * deployed with a curve that happens to sit at the same address. Set
 * NEXT_PUBLIC_CURVE_ADDRESS to the real curve — the live testnet curve used
 * during development was 0x7bc42e8a2df6070ae7d1ca720cd5408e8354fc20.
 */
export const CURVE_ADDRESS = (process.env.NEXT_PUBLIC_CURVE_ADDRESS || GAME_ADDRESS) as `0x${string}`;

export const explorerTx = (hash: `0x${string}`) =>
  `${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: `0x${string}`) =>
  `${robinhoodTestnet.blockExplorers.default.url}/address/${a}`;
