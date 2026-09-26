// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVibeCurve
/// @notice Bonding-curve surface used by Curve Racer, verified on-chain
///         against Robinhood Chain Testnet (chainId 46630).
///
/// VERIFICATION NOTES (session of 2026-09-26, all confirmed by eth_call):
///   graduated()            -> false on a live curve, true after graduation
///   spotPriceWad()         -> live price in wei per token
///                             (returned 1_907_610_516 on the sampled curve;
///                              vibe API oracle independently read
///                              1_917_232_559 — a ~0.5% spread)
///   curveTokensRemaining() -> 716_370_987.7e18
///   virtualEthReserve()    -> 1.900497e18
///   virtualTokenReserve()  -> 996_270_987.7e18
///   tokensSoldFromCurve()  -> 76_729_012.2e18
///   quoteBuyExactTokens(n) -> cost in wei to buy exactly n tokens
///   token()                -> the token this curve prices
///
/// EVENT (recovered from deployed bytecode + confirmed in a real receipt):
///   CurveCompleted(uint256 netRaisedWei, uint256 completedAt)
///     topic0 = 0x654e1d49372e305713e05ff2ed090670dd8683b365ce33618c15e187b875d21d
///     decoded on token 0xc47beb...d1 as netRaisedWei = 5.000000000000000007e18
///     and completedAt = 1790308167 (unix ts), matching vibe API completedAt.
///
/// NOT PRESENT: quoteSell*, spotPrice(), previewBuy/Sell, buyCost, sellProceeds.
/// The word "exists (reverted)" in the session probe means the selector is
/// unknown; do not rely on any of them.
interface IVibeCurve {
    /// @notice True once the curve has completed and migrated to Uniswap V4.
    /// @dev This is the single source of truth for the game's custody phase.
    function graduated() external view returns (bool);

    /// @notice Live spot price in wei per whole token (18-decimal wad).
    function spotPriceWad() external view returns (uint256);

    /// @notice Cost in wei to buy exactly `tokensOut` from the curve.
    function quoteBuyExactTokens(uint256 tokensOut) external view returns (uint256);

    /// @notice Tokens still sellable on the curve.
    function curveTokensRemaining() external view returns (uint256);

    /// @notice Tokens already sold from the curve.
    function tokensSoldFromCurve() external view returns (uint256);

    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);

    /// @notice The token this curve prices.
    function token() external view returns (address);

    /// @notice Emitted when the curve reaches its raise target.
    /// @param netRaisedWei Net ETH raised, e.g. 5.000000000000000007e18
    /// @param completedAt  Unix timestamp of completion
    event CurveCompleted(uint256 netRaisedWei, uint256 completedAt);
}
