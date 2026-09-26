// Generate a fresh EVM wallet for Curve Racer (contract + token creator).
//
//   node script/new-wallet.mjs
//
// Generates a key pair ONLY. It does NOT fund the wallet, deploy anything, or
// touch the token. Funding and deployment require explicit approval.
//
// Writes curve-racer-wallet.json at mode 600 and prints the address so it can
// be funded or added to MetaMask.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, chmodSync } from 'node:fs';

const label = process.argv[2] || 'Curve Racer (contract + token creator)';
const out = new URL('../curve-racer-wallet.json', import.meta.url);

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const record = {
  label,
  address: account.address,
  privateKey,
  chainId: 46630,
  network: 'Robinhood Chain Testnet',
  note: 'Generated for Curve Racer. NOT funded at creation time. Never commit this file.',
  created: new Date().toISOString(),
};

writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
chmodSync(out, 0o600);

console.log('fresh wallet generated\n');
console.log(`  label    ${label}`);
console.log(`  address  ${account.address}`);
console.log(`  file     ${out.pathname}  (mode 600)`);
console.log('\n  NOT funded. NOT deployed. Token NOT launched.');
console.log('  Fund it or import it into MetaMask when you decide to.');
