// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVibeCurve} from "contracts/interfaces/IVibeCurve.sol";
import {IVibeToken} from "contracts/interfaces/IVibeToken.sol";

/// @notice Local stand-ins for the vibe/vibe curve and token, used by the
///         anvil demo (`script/deploy-local.mjs`).
///
///         These mirror the mocks in the test suite but are compiled as their
///         own artifacts so they can be deployed to a live chain. The curve
///         mock starts its spot price from a real Robinhood testnet reading
///         (see the deploy script), so the demo shows plausible numbers
///         instead of an arbitrary constant.
contract MockCurve is IVibeCurve {
    uint256 public spotPriceWad = 1_907_610_516;
    bool public graduated;

    address public game;

    uint256 public virtualEthReserve = 190_049_701_325_112e4;
    uint256 public virtualTokenReserve = 1_000_000_000e18;
    uint256 public tokensSoldFromCurve = 76_729_012_272_231_034_570_870_392;

    // CurveCompleted(uint256,uint256) is inherited from IVibeCurve — do not
    // redeclare it here, or the two declarations collide.

    function setGame(address _game) external {
        game = _game;
    }

    function setPrice(uint256 p) external {
        spotPriceWad = p;
    }

    /// @dev Demo control: push the price up or down mid-round so the leader
    ///      board and PnL visibly move during a recorded demo.
    function bumpPrice(int256 deltaPct) external {
        // deltaPct is in basis points; +100 = +1%.
        int256 current = int256(spotPriceWad);
        int256 next = (current * (10_000 + deltaPct)) / 10_000;
        if (next <= 0) next = 1;
        spotPriceWad = uint256(next);
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    function graduate(uint256 netRaisedWei, uint256 completedAt) external {
        graduated = true;
        emit CurveCompleted(netRaisedWei, completedAt);
    }

    function curveTokensRemaining() external pure returns (uint256) {
        return 0;
    }

    function quoteBuyExactTokens(uint256) external pure returns (uint256) {
        return 0;
    }

    function token() external pure returns (address) {
        return address(0);
    }
}

/// @notice Mock vibe/vibe token: mirrors the real pre-graduation transfer lock
///         so the demo shows the real "token wagering is unavailable yet"
///         state, then flips to spendable via unlock() after graduation.
contract MockToken is IVibeToken {
    string public name = "Curve Racer";
    string public symbol = "RACER";
    string public tokenURI;
    uint256 public constant decimals = 18;
    uint256 public totalSupply;

    address public curveAddress;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public locked = true;

    error TransfersLocked();

    constructor(address _curve) {
        curveAddress = _curve;
        totalSupply = 1_000_000_000e18;
        balanceOf[msg.sender] = totalSupply;
    }

    /// @dev IVibeToken exposes the curve as `curve()`, while this mock's
    ///      constructor arg is also named `curve`; expose the getter the
    ///      interface expects.
    function curve() external view returns (address) {
        return curveAddress;
    }

    modifier onlyUnlocked() {
        if (locked) revert TransfersLocked();
        _;
    }

    function unlock() external {
        locked = false;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external onlyUnlocked returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external onlyUnlocked returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amt, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
        return true;
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
}
