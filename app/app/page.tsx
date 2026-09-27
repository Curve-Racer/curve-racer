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
};

/**
 * The page owns the shell only. GameBoard renders its own header, status and
 * layout, so repeating them here produced two "Curve Racer" headings.
 */
export default function Page() {
  return (
    // min-h-screen + flex keeps the footer at the bottom of short pages
    // instead of leaving a large dead area beneath it.
    <main className="flex min-h-screen flex-col">
      <div className="flex-1">
        <GameBoard />
      </div>

      <footer className="flex items-center justify-center gap-6 border-t border-border py-6 text-xs text-muted-foreground">
        <a
          href={SOCIALS.telegram}
          target="_blank"
          rel="noreferrer noopener"
          className="transition-colors hover:text-foreground"
        >
          Telegram
        </a>
        <a
          href={SOCIALS.twitter}
          target="_blank"
          rel="noreferrer noopener"
          className="transition-colors hover:text-foreground"
        >
          X
        </a>
      </footer>
    </main>
  );
}
