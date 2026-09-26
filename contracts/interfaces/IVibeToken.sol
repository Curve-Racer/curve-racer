// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVibeToken
/// @notice Minimal surface of a vibe/vibe launchpad token, verified on-chain
///         against Robinhood Chain Testnet (chainId 46630).
///
/// VERIFICATION NOTES (session of 2026-09-26, all confirmed by eth_call):
///   totalSupply()  -> callable, 1e27 (1,000,000,000 tokens, 18 decimals)
///   balanceOf(a)   -> callable, live and accurate
///   curve()        -> callable, returns the bonding-curve address
///   name/symbol/decimals -> callable, decimals == 18
///   approve(s,v)   -> callable and NOT gated by the transfer lock
///   transfer/transferFrom -> revert 0xdb89e3f4 (TransfersLocked()) while the
///                     curve is active; work normally after graduation
///
/// NOT PRESENT on the token (do not call, will revert with empty data):
///   graduated(), complete(), transfersLocked(), permit(), burn(), mint()
///
/// Graduation state therefore has to be read from the curve, not the token.
interface IVibeToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function curve() external view returns (address);
    function decimals() external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}
