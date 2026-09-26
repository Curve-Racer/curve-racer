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
      {process.env.NEXT_PUBLIC_IS_LOCAL === 'true' && (
        <div className="banner info">
          <b>Local anvil mode</b> &mdash; no real funds, no real chain. Add network
          {' '}<code>Anvil (local)</code> to your wallet: RPC <code>http://127.0.0.1:8545</code>, chain ID{' '}
          <code>31337</code>. See <code>script/deploy-local.mjs</code> for funded demo keys.
        </div>
      )}
      <GameBoard />
    </main>
  );
}
