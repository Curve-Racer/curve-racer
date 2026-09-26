import GameBoard from '@/components/GameBoard';

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
    </main>
  );
}
