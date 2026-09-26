import type { Metadata } from 'next';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Curve Racer',
  description:
    'Stake ETH, ride a live bonding curve for 30 seconds, highest PnL takes the pot. Launching on Seedify Launchpad.',
  openGraph: {
    title: 'Curve Racer',
    description:
      'Stake ETH, ride a live bonding curve for 30 seconds, highest PnL takes the pot.',
    type: 'website',
  },
};

// Placeholder page. Kept separate from the live game app so the full app can
// be deployed later against the final onchain game contract without touching
// this file.
export default function ComingSoon() {
  return (
    <main className="wrap">
      <header className="top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo" src="/racer.png" alt="Curve Racer" width={40} height={40} />
        <h1>Curve Racer</h1>
      </header>

      <p className="tag">
        Stake ETH &middot; ride a live bonding curve for 30s &middot; highest PnL takes the pot
      </p>

      <div className="banner info" style={{ marginTop: '2rem' }}>
        <b>Coming soon.</b> Curve Racer is launching on the Seedify Launchpad
        (Robinhood Chain Testnet). The playable game goes live here shortly.
      </div>

      <p style={{ marginTop: '2rem', opacity: 0.7, fontSize: '0.9rem' }}>
        Launchpad metadata is fixed at token creation, so this page is the official
        site linked from the token.
      </p>
    </main>
  );
}
