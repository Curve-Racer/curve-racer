// Deploy CurveRacer + vibe/vibe mocks to a local anvil node.
//
//   node script/deploy-local.mjs        # run from curve-racer/
//
// Uses anvil's deterministic first three test keys so the funded demo
// accounts are identical on every run and can be imported into MetaMask once.
//
// Writes app/.env.local with the resulting addresses, so `npm run dev` in
// app/ points at the local game with no manual configuration.

import { writeFileSync, readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, defineChain, formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8545';

const anvil = defineChain({
  id: 31337,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  testnet: true,
});

// Anvil's default test keys, accounts #0-#2.
const KEYS = {
  'Player 1': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  'Player 2': '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  'Player 3': '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};

const TESTNET_CURVE = '0x7bc42e8a2df6070ae7d1ca720cd5408e8354fc20';
const TESTNET_RPC = 'https://robinhood-testnet.drpc.org';
const CACHED_SPOT = 1_907_610_516n;

const artifact = (name) =>
  JSON.parse(readFileSync(new URL(`../out/${name}.json`, import.meta.url), 'utf8'));

const MOCK_CURVE_CTL = [
  { type: 'function', inputs: [{ name: 'p', type: 'uint256' }], name: 'setPrice', outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', inputs: [{ name: 'g', type: 'address' }], name: 'setGame', outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', inputs: [], name: 'spotPriceWad', outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', inputs: [], name: 'graduated', outputs: [{ type: 'bool' }], stateMutability: 'view' },
];

async function main() {
  const deployer = privateKeyToAccount(KEYS['Player 1']);
  const wallet = createWalletClient({ chain: anvil, transport: http(RPC), account: deployer });
  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) });

  const write = async (abi, address, functionName, args) => {
    const hash = await wallet.writeContract({ abi, address, functionName, args, account: deployer });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const deploy = async (name, args = []) => {
    const a = artifact(name);
    const hash = await wallet.deployContract({
      abi: a.abi, bytecode: a.bytecode.object, args, account: deployer,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name}: no address`);
    console.log(`  ${name.padEnd(11)} ${receipt.contractAddress}   gas ${receipt.gasUsed}`);
    return receipt.contractAddress;
  };

  // Seed the mock's spot price from the real testnet curve so the demo shows
  // plausible numbers rather than an arbitrary constant.
  let spot = CACHED_SPOT;
  process.stdout.write('seeding spot price from Robinhood testnet');
  try {
    const tc = defineChain({
      id: 46630, name: 'rh-testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [TESTNET_RPC] } }, testnet: true,
    });
    const tp = createPublicClient({ chain: tc, transport: http(TESTNET_RPC, { timeout: 15000 }) });
    spot = await tp.readContract({
      address: TESTNET_CURVE,
      abi: [{ type: 'function', inputs: [], name: 'spotPriceWad', outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'spotPriceWad',
    });
    console.log(` -> ${spot} (${formatUnits(spot, 9)} ETH/token)`);
  } catch (e) {
    console.log(` -> unreachable, using cached ${spot}`);
  }

  console.log(`\ndeploying to anvil at ${RPC}`);
  const curve = await deploy('MockVibe.sol/MockCurve');
  const token = await deploy('MockVibe.sol/MockToken', [curve]);
  const game = await deploy('CurveRacer.sol/CurveRacer', [curve, token, deployer.address]);

  await write(MOCK_CURVE_CTL, curve, 'setPrice', [spot]);
  await write(MOCK_CURVE_CTL, curve, 'setGame', [game]);

  const env = [
    'NEXT_PUBLIC_GAME_ADDRESS=' + game,
    'NEXT_PUBLIC_CURVE_ADDRESS=' + curve,
    'NEXT_PUBLIC_RPC_URL=' + RPC,
    'NEXT_PUBLIC_CHAIN_ID=31337',
    'NEXT_PUBLIC_IS_LOCAL=true',
    '',
  ].join('\n');
  writeFileSync(new URL('../app/.env.local', import.meta.url), env);

  const [head, onChainPrice, roundBlocks] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: curve, abi: MOCK_CURVE_CTL, functionName: 'spotPriceWad' }),
    publicClient.readContract({
      address: game, abi: artifact('CurveRacer.sol/CurveRacer').abi,
      functionName: 'ROUND_BLOCKS',
    }),
  ]);

  console.log('\nverified on-chain:');
  console.log(`  head            ${head}`);
  console.log(`  spotPriceWad    ${onChainPrice}`);
  console.log(`  ROUND_BLOCKS    ${roundBlocks}`);
  console.log('\nwrote app/.env.local');

  console.log('\ndemo accounts (import into MetaMask):');
  for (const [name, pk] of Object.entries(KEYS)) {
    console.log(`  ${name}  ${privateKeyToAccount(pk).address}`);
  }
  console.log('\nwallet config:');
  console.log(`  network "Anvil (local)"   rpc ${RPC}   chainId 31337   currency ETH`);
}

main().catch((e) => { console.error('\nDEPLOY FAILED:', e.shortMessage || e.message); process.exit(1); });
