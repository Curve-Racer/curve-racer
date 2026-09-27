#!/usr/bin/env node
// Call settle() on the deployed game: closes round 1, opens round 2.
// settle() is permissionless. With 0 entrants the round is voided and there is
// nothing to refund, so this carries no fund risk. The key is read from the
// wallet file, never passed on the command line (this box redacts inline
// secrets before the shell sees them, which would break the signature).
import { readFileSync } from 'fs';
import { createPublicClient, createWalletClient, http, custom, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const GAME = '0xa2d189884c34c6c94c2f88d6ee6f42ed8ce1f870';
const RPC = 'https://robinhood-testnet.drpc.org';

const chain = defineChain({
  id: 46630, name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const w = JSON.parse(readFileSync('/home/administrator/curve-racer/curve-racer-wallet.json', 'utf8'));
const pk = w.privateKey || w.key || w.private_key;
const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);
console.log('deployer:', acct.address);

const abi = parseAbi([
  'function settle()',
  'function currentRoundId() view returns (uint64)',
  'function rounds(uint64) view returns (uint64 id, uint64 openBlock, uint64 closeBlock, uint8 phase, uint256 totalStake, uint256 pot, uint256 rake, uint256 entryPriceWad, bool voided)',
  'function totalRoundsSettled() view returns (uint256)',
  'function secondsRemaining() view returns (uint256)',
]);

const pub = createPublicClient({ chain, transport: http(RPC) });
// local signing: viem's walletClient with a local account, no window wallet
import { createWalletClient as mkWalletClient } from 'viem';
const wal = createWalletClient({ account: acct, chain, transport: http(RPC) });

const before = await pub.readContract({ address: GAME, abi, functionName: 'currentRoundId' });
const r1 = await pub.readContract({ address: GAME, abi, functionName: 'rounds', args: [before] });
console.log(`before: round=${before} phase=${r1[3]} entrants_stake=${r1[4]} closeBlock=${r1[2]}`);

if (r1[3] !== 1) {
  console.log(`round ${before} is not Open (phase=${r1[3]}) — settle() would revert WrongPhase. Stopping.`);
  process.exit(0);
}

const hash = await wal.writeContract({ address: GAME, abi, functionName: 'settle', chain, account: acct });
console.log('settle tx:', hash);
const rec = await pub.waitForTransactionReceipt({ hash });
console.log('status:', rec.status, 'gas:', rec.gasUsed);

const after = await pub.readContract({ address: GAME, abi, functionName: 'currentRoundId' });
const r2 = await pub.readContract({ address: GAME, abi, functionName: 'rounds', args: [after] });
const secs = await pub.readContract({ address: GAME, abi, functionName: 'secondsRemaining' });
const settled = await pub.readContract({ address: GAME, abi, functionName: 'totalRoundsSettled' });

console.log(`\nafter : round=${after} phase=${r2[3]} (1=Open)  openBlock=${r2[1]} closeBlock=${r2[2]}`);
console.log(`        secondsRemaining=${secs}  totalRoundsSettled=${settled}`);
const head = await pub.getBlockNumber();
console.log(`        chain head=${head}  blocks until close=${Number(r2[2]) - Number(head)}`);
