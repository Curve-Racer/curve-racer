import GameBoard from '@/components/GameBoard';
import type { Metadata } from 'next';

const DESCRIPTION =
  'Stake ETH, ride a live bonding curve for 30 seconds, highest PnL takes the pot.';

export const metadata: Metadata = {
  title: 'Curve Racer',
  description: DESCRIPTION,
  openGraph: {
    title: 'Curve Racer',
    description: DESCRIPTION,
    type: 'website',
  },
};

const SOCIALS = {
  telegram: 'https://t.me/curveracerann',
  twitter: 'https://x.com/curveracereth',
  website: 'https://curve-racer.vercel.app',
};

export default function Page() {
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

      <GameBoard />

      <nav
        style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'center' }}
      >
        <a href={SOCIALS.telegram} target="_blank" rel="noreferrer noopener">
          Telegram
        </a>
        <a href={SOCIALS.twitter} target="_blank" rel="noreferrer noopener">
          X
        </a>
      </nav>
    </main>
  );
}
