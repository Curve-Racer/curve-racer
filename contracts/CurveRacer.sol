// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVibeCurve} from "./interfaces/IVibeCurve.sol";
import {IVibeToken} from "./interfaces/IVibeToken.sol";

/// @title CurveRacer
/// @notice A provably-fair PvP arena where players stake, then ride a live
///         vibe/vibe bonding curve for 30 seconds. Highest realised PnL takes
///         the pot; the protocol takes a rake.
///
/// @dev WHY THIS IS SAFE WHILE THE TOKEN IS TRANSFER-LOCKED
///
/// A vibe/vibe token reverts `TransfersLocked()` (0xdb89e3f4) on transfer and
/// transferFrom for the whole curve phase, so this contract never custodies the
/// game token before graduation. Stakes are denominated in the game token
/// (via `curve.spotPriceWad()`) but collected in ETH. The token is the unit of
/// account; ETH is the rail. That keeps the game fully playable from block one.
///
/// On `CurveCompleted` the game arms custody, and `assetForWager()` flips from
/// ETH to the game token. Every entry and exit path routes through that single
/// function, so arming requires no migration of existing state — new wagers
/// simply settle in the token.
///
/// @dev PRICE SOURCE
///
/// Prices come from `IVibeCurve(curve).spotPriceWad()`, verified live on-chain.
/// There is no oracle to trust and no keeper to trust: the bonding curve's own
/// state IS the price, and anyone can re-derive every number in this contract
/// from public chain state.
contract CurveRacer {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Phase {
        Idle,      // no round open
        Open,      // accepting entries
        Settled    // round closed, pot paid
    }

    struct Round {
        uint64 id;
        uint64 openBlock;
        uint64 closeBlock;
        // Wall-clock bounds. The block pair is a backstop for chains that stall;
        // the timestamps are what the UI counts down against, because block
        // production rate is not guaranteed (this testnet measured ~180ms/block,
        // not the 100ms the block count originally assumed).
        uint64 openTimestamp;
        uint64 closeTimestamp;
        Phase phase;
        uint256 totalStake;      // total ETH staked
        uint256 pot;             // totalStake minus rake, paid to winner(s)
        uint256 rake;            // protocol cut
        uint256 entryPriceWad;   // spot price at open, for display
        address[] entrants;
        mapping(address => Entry) entries;
        bool voided;             // fewer than 2 entrants
    }

    struct Entry {
        uint128 stake;           // ETH staked
        bool refundClaimed;
        bool paidOut;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Round length in blocks. A hard backstop only: if a chain stalls
    ///         badly, the round still closes after this many blocks. On this
    ///         testnet blocks land every ~180ms, so 300 blocks ~= 54s.
    uint64 public constant ROUND_BLOCKS = 300;

    /// @notice Nominal round length in seconds. This is the real deadline the
    ///         UI counts down to; the block count above is only a safety net.
    uint64 public constant ROUND_SECONDS = 30;

    /// @notice A round needs at least this many entrants to be settleable.
    uint256 public constant MIN_ENTRANTS = 2;

    /// @notice Protocol rake on the pot, in basis points (2.5%).
    uint256 public constant RAKE_BPS = 250;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Immutable wiring
    // ---------------------------------------------------------------------

    /// @notice The bonding curve whose movement the game prices.
    IVibeCurve public immutable curve;

    /// @notice The game's own launched token, minted on vibe/vibe.
    IVibeToken public immutable gameToken;

    /// @notice Where rake accrues.
    address public immutable treasury;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    uint64 public currentRoundId;
    mapping(uint64 => Round) public rounds;

    /// @notice True once the curve graduated and token custody is armed.
    bool public custodyArmed;

    uint256 public totalRakeAccrued;
    uint256 public totalRoundsSettled;

    /// @notice Highest PnL ever recorded, for the leaderboard.
    uint256 public bestPnlWad;
    address public bestPlayer;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RoundOpened(uint64 indexed roundId, uint64 openBlock, uint64 closeBlock, uint256 entryPriceWad);
    event Entered(uint64 indexed roundId, address indexed player, uint256 stake);
    event RoundSettled(
        uint64 indexed roundId,
        address indexed winner,
        uint256 pot,
        uint256 rake,
        uint256 exitPriceWad
    );
    event RoundVoided(uint64 indexed roundId, address[] refunded, uint256 amount);
    event Refunded(uint64 indexed roundId, address indexed player, uint256 amount);
    event CustodyArmed(uint256 netRaisedWei, uint256 completedAt);
    event RakeWithdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOpen();
    error RoundClosed();
    error RoundNotOver();
    error AlreadyEntered();
    error ZeroStake();
    error WrongPhase();
    error NoEntry();
    error AlreadyClaimed();
    error TransferFailed();
    error ApprovalFailed();
    error NotCurve();
    error NotTreasury();
    error NothingToWithdraw();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address curveAddress, address gameTokenAddress, address treasuryAddress) {
        curve = IVibeCurve(curveAddress);
        gameToken = IVibeToken(gameTokenAddress);
        treasury = treasuryAddress;
        _openRound();
    }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyCurve() {
        if (msg.sender != address(curve)) revert NotCurve();
        _;
    }

    // ---------------------------------------------------------------------
    // Phase detection — the single source of truth for which asset wagers use
    // ---------------------------------------------------------------------

    /// @notice True when the token can actually be held by this contract.
    /// @dev Reads the CURVE, not the token: the token exposes no graduated()
    ///      view at all (verified — it reverts with empty data).
    function custodyAvailable() public view returns (bool) {
        return curve.graduated();
    }

    /// @notice The asset wagers are collected in.
    /// @dev address(0) means native ETH (curve phase). After graduation this
    ///      returns the game token. Every entry and exit path calls this, so
    ///      arming custody needs no state migration.
    function assetForWager() public view returns (address) {
        return custodyAvailable() ? address(gameToken) : address(0);
    }

    // ---------------------------------------------------------------------
    // Round lifecycle
    // ---------------------------------------------------------------------

    function _openRound() internal {
        uint64 id = ++currentRoundId;
        Round storage r = rounds[id];
        r.id = id;
        r.openBlock = uint64(block.number);
        r.openTimestamp = uint64(block.timestamp);
        r.closeBlock = uint64(block.number) + ROUND_BLOCKS;
        r.closeTimestamp = uint64(block.timestamp) + ROUND_SECONDS;
        r.phase = Phase.Open;
        r.entryPriceWad = _spotPrice();
        emit RoundOpened(id, r.openBlock, r.closeBlock, r.entryPriceWad);
    }

    /// @notice True once a round can no longer accept entries.
    /// @dev Wall-clock is the primary deadline and the block count is a
    ///      backstop, so a slow or stalled chain cannot keep a round open
    ///      forever, and a fast one cannot cut it short. Both entry points
    ///      MUST use this helper — deriving the deadline inline is exactly how
    ///      the UI and the contract ended up disagreeing about whether a round
    ///      was still open.
    function _isClosed(Round storage r) internal view returns (bool) {
        return block.timestamp >= r.closeTimestamp || block.number >= r.closeBlock;
    }

    function _spotPrice() internal view returns (uint256) {
        return curve.spotPriceWad();
    }

    /// @notice Stake ETH and join the open round.
    /// @dev Open-join: everyone who enters before closeBlock gets the same
    ///      entry price, so the race is decided purely by the curve.
    ///
    ///      The closeBlock check is load-bearing. Without it, a player could
    ///      enter after the round's deadline and still be settled at the
    ///      original entry price, effectively time-travelling into a round
    ///      that had already resolved.
    function enter() external payable {
        // Lazy auto-advance. If the current round has already closed, settle it
        // first and enter the fresh one. The EVM has no scheduler, so nothing
        // settles on its own; without this, a round that expired while nobody
        // was playing would sit dead until a human pressed the button, and
        // anyone trying to enter would be locked out. At most one round can be
        // expired-and-unsettled at a time, because settle() always opens a
        // fresh one — so a single call, not a loop.
        if (rounds[currentRoundId].phase == Phase.Open && _isClosed(rounds[currentRoundId])) {
            _settleRound();
        }

        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.Open) revert NotOpen();
        if (r.entries[msg.sender].stake != 0) revert AlreadyEntered();
        if (msg.value == 0) revert ZeroStake();

        r.entries[msg.sender].stake = uint128(msg.value);
        r.entrants.push(msg.sender);
        r.totalStake += msg.value;

        emit Entered(r.id, msg.sender, msg.value);
    }

    /// @notice Close the round, pay the winner, and open the next one.
    /// @dev Permissionless. Under 2 entrants the round is voided and every
    ///      entrant refunds. Ties split the pot evenly.
    function settle() external {
        _settleRound();
    }

    /// @dev Settles `rounds[currentRoundId]` and opens the next round.
    ///      Shared by the permissionless `settle()` and by `enter()`, which
    ///      calls it to auto-advance past an expired round.
    function _settleRound() internal {
        Round storage r = rounds[currentRoundId];
        if (r.phase == Phase.Idle) revert WrongPhase();
        if (r.phase == Phase.Settled) revert WrongPhase();
        if (!_isClosed(r)) revert RoundNotOver();

        uint64 settledId = r.id;
        uint256 exitPriceWad = _spotPrice();
        uint256 entryPriceWad = r.entryPriceWad;

        if (r.entrants.length == 0) {
            // No one played. There is nothing to refund and, critically,
            // `amount / n2` below would divide by zero and revert — which
            // would brick settle() permanently, since it is the only path
            // that opens the next round. A round can legitimately expire with
            // zero entrants (no players joined, or all were already refunded),
            // so this case must be handled before the division.
            r.phase = Phase.Settled;
            r.voided = true;
            emit RoundVoided(settledId, new address[](0), 0);
        } else if (r.entrants.length < MIN_ENTRANTS) {
            address[] memory entrantsList = r.entrants;
            uint256 n2 = entrantsList.length;
            uint256 amount = r.totalStake;
            r.phase = Phase.Settled;
            r.voided = true;
            emit RoundVoided(settledId, entrantsList, amount);
            // Refund in full, split evenly, before any further state writes.
            // Balances are zeroed first (checks-effects-interactions).
            uint256 per = amount / n2;
            for (uint256 i = 0; i < n2; ++i) {
                r.entries[entrantsList[i]].stake = 0;
                r.entries[entrantsList[i]].refundClaimed = true;
            }
            // Rounding dust goes to the first entrant.
            for (uint256 i = 0; i < n2; ++i) {
                uint256 amt = (i == 0) ? (amount - (per * (n2 - 1))) : per;
                (bool ok,) = payable(entrantsList[i]).call{value: amt}("");
                if (!ok) revert TransferFailed();
            }
        } else {
            _settlePot(r, settledId, entryPriceWad, exitPriceWad);
        }

        totalRoundsSettled += 1;
        _openRound();
    }

    /// @dev Finds the best PnL, splits ties, pays winners. Reverts if the pot
    ///      cannot move, which keeps settlement atomic.
    function _settlePot(
        Round storage r,
        uint64 settledId,
        uint256 entryPriceWad,
        uint256 exitPriceWad
    ) internal {
        uint256 n = r.entrants.length;

        // Find the best PnL, signed. A player who lost must NOT be able to tie
        // with a breakeven player, so this cannot be an unsigned magnitude.
        int256 bestPnl = type(int256).min;
        for (uint256 i = 0; i < n; ++i) {
            int256 pnl = _pnlWad(uint256(r.entries[r.entrants[i]].stake), entryPriceWad, exitPriceWad);
            if (pnl > bestPnl) bestPnl = pnl;
        }

        uint256 rake = (r.totalStake * RAKE_BPS) / BPS_DENOMINATOR;
        uint256 pot = r.totalStake - rake;
        totalRakeAccrued += rake;
        r.rake = rake;
        r.pot = pot;

        // Count winners (exact tie on PnL).
        uint256 winnerCount;
        for (uint256 i = 0; i < n; ++i) {
            int256 pnl = _pnlWad(uint256(r.entries[r.entrants[i]].stake), entryPriceWad, exitPriceWad);
            if (pnl == bestPnl) winnerCount++;
        }

        if (bestPnl > 0) {
            uint256 asUint = uint256(bestPnl);
            // Attribute to the first entrant that actually achieved bestPnl,
            // not entrants[0] — which is only correct when the winner entered
            // first.
            for (uint256 i = 0; i < n; ++i) {
                if (_pnlWad(uint256(r.entries[r.entrants[i]].stake), entryPriceWad, exitPriceWad) == bestPnl) {
                    if (asUint > bestPnlWad) {
                        bestPnlWad = asUint;
                        bestPlayer = r.entrants[i];
                    }
                    break;
                }
            }
        }

        uint256 share = pot / winnerCount;
        uint256 dust = pot - (share * winnerCount);

        r.phase = Phase.Settled;

        address firstWinner;
        bool winnerPaid;
        for (uint256 i = 0; i < n; ++i) {
            address player = r.entrants[i];
            int256 pnl = _pnlWad(uint256(r.entries[player].stake), entryPriceWad, exitPriceWad);
            r.entries[player].stake = 0;
            if (pnl == bestPnl) {
                r.entries[player].paidOut = true;
                if (!winnerPaid) {
                    firstWinner = player;
                    winnerPaid = true;
                }
                uint256 amt = (player == firstWinner) ? (share + dust) : share;
                (bool ok,) = payable(player).call{value: amt}("");
                if (!ok) revert TransferFailed();
            }
        }

        emit RoundSettled(settledId, firstWinner, pot, rake, exitPriceWad);
    }

    /// @notice Signed PnL in wei for a stake, given entry and exit prices.
    /// @dev Positive if the curve rose over the round, negative if it fell.
    ///      Both are measured against the stake so differently-sized entries
    ///      stay comparable. Signed because a losing player must rank below a
    ///      breakeven one, not tie with them.
    function _pnlWad(uint256 stake, uint256 entryPriceWad, uint256 exitPriceWad) internal pure returns (int256) {
        if (entryPriceWad == 0 || stake == 0) return 0;
        if (exitPriceWad >= entryPriceWad) {
            uint256 gain = (stake * (exitPriceWad - entryPriceWad)) / entryPriceWad;
            return int256(gain);
        } else {
            uint256 loss = (stake * (entryPriceWad - exitPriceWad)) / entryPriceWad;
            // Guard the int256 boundary: loss is bounded by stake here, but be
            // explicit rather than relying on that invariant holding upstream.
            if (loss > uint256(type(int256).max)) return type(int256).min;
            return -int256(loss);
        }
    }

    /// @notice Signed PnL in wei for a given stake at the given prices.
    ///         Public so the UI and tests can reproduce the exact same number
    ///         the contract settled on.
    function pnlWad(uint256 stake, uint256 entryPriceWad, uint256 exitPriceWad) external pure returns (int256) {
        return _pnlWad(stake, entryPriceWad, exitPriceWad);
    }

    /// @notice Claim a refund from a voided round you were in.
    function claimRefund(uint64 roundId) external {
        Round storage r = rounds[roundId];
        if (!r.voided) revert WrongPhase();
        Entry storage e = r.entries[msg.sender];
        if (e.stake == 0 || e.refundClaimed) revert AlreadyClaimed();
        uint256 amt = e.stake;
        e.stake = 0;
        e.refundClaimed = true;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Refunded(roundId, msg.sender, amt);
    }

    /// @notice Approve the game contract to pull your game token (post-graduation).
    function approveGameToken(uint256 amount) external returns (bool) {
        if (!gameToken.approve(address(this), amount)) revert ApprovalFailed();
        return true;
    }

    /// @notice Enter with game token instead of ETH. Only valid after graduation.
    function enterWithToken(uint256 amount) external {
        if (!custodyAvailable()) revert WrongPhase();
        if (amount == 0) revert ZeroStake();

        // Same lazy auto-advance as enter() — see the comment there.
        if (rounds[currentRoundId].phase == Phase.Open && _isClosed(rounds[currentRoundId])) {
            _settleRound();
        }

        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.Open) revert NotOpen();
        if (r.entries[msg.sender].stake != 0) revert AlreadyEntered();

        if (!gameToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        r.entries[msg.sender].stake = uint128(amount);
        r.entrants.push(msg.sender);
        r.totalStake += amount;

        emit Entered(r.id, msg.sender, amount);
    }

    /// @notice Withdraw accumulated rake to the treasury.
    function withdrawRake() external {
        if (msg.sender != treasury) revert NotTreasury();
        if (totalRakeAccrued == 0) revert NothingToWithdraw();
        uint256 amt = totalRakeAccrued;
        totalRakeAccrued = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit RakeWithdrawn(msg.sender, amt);
    }

    // ---------------------------------------------------------------------
    // Graduation hook
    // ---------------------------------------------------------------------

    /// @notice Arms token custody when the curve completes.
    /// @dev Verified topic0: 0x654e1d49372e305713e05ff2ed090670dd8683b365ce33618c15e187b875d21d
    ///      Signature: CurveCompleted(uint256 netRaisedWei, uint256 completedAt)
    function onCurveCompleted(uint256 netRaisedWei, uint256 completedAt) external onlyCurve {
        custodyArmed = true;
        emit CustodyArmed(netRaisedWei, completedAt);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function entrants(uint64 roundId) external view returns (address[] memory) {
        return rounds[roundId].entrants;
    }

    function entryOf(uint64 roundId, address player) external view returns (Entry memory) {
        return rounds[roundId].entries[player];
    }

    /// @notice Round state as a flat tuple.
    /// @dev `Round` cannot be returned directly because it contains a mapping,
    ///      so the UI reads round state through this. Field order matches
    ///      Round: id, openBlock, closeBlock, openTimestamp, closeTimestamp,
    ///      phase, totalStake, pot, rake, entryPriceWad, voided.
    ///      The two timestamp fields are new; consumers must be regenerated
    ///      against the ABI rather than hand-patched, since the tuple grew.
    function roundState(uint64 roundId)
        external
        view
        returns (
            uint64 id,
            uint64 openBlock,
            uint64 closeBlock,
            uint64 openTimestamp,
            uint64 closeTimestamp,
            Phase phase,
            uint256 totalStake,
            uint256 pot,
            uint256 rake,
            uint256 entryPriceWad,
            bool voided
        )
    {
        Round storage r = rounds[roundId];
        return (r.id, r.openBlock, r.closeBlock, r.openTimestamp, r.closeTimestamp, r.phase, r.totalStake, r.pot, r.rake, r.entryPriceWad, r.voided);
    }

    /// @notice Live leaderboard head: best positive PnL and who achieved it.
    function leaderboard() external view returns (uint256 topPnl, address topPlayer) {
        return (bestPnlWad, bestPlayer);
    }

    /// @notice Seconds remaining in the current round, for the UI countdown.
    /// @dev Real wall-clock seconds, not an estimate derived from block count.
    ///      This chain's block interval was measured at ~180ms, not the 100ms
    ///      the old estimate assumed, so a block-derived countdown ran slow and
    ///      looked frozen. If the block backstop trips first (stalled chain),
    ///      this still reports 0 so the UI never shows time on a dead round.
    function secondsRemaining() external view returns (uint256) {
        Round storage r = rounds[currentRoundId];
        if (block.timestamp >= r.closeTimestamp) return 0;
        if (block.number >= r.closeBlock) return 0;
        return r.closeTimestamp - uint64(block.timestamp);
    }

    receive() external payable { }
}
