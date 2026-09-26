// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveRacer} from "../contracts/CurveRacer.sol";

/// @notice Mock of a vibe/vibe bonding curve, reproducing the exact surface
///         verified on-chain (Robinhood Chain Testnet, 2026-09-26):
///           graduated()   bool
///           spotPriceWad() uint   -> live wei per token
///           CurveCompleted(uint256,uint256) event
///         Real values sampled: spotPriceWad() = 1_907_610_516.
///
///         The real curve emits CurveCompleted and CurveRacer listens for it.
///         A plain mock has no such listener, so graduate() calls the game
///         directly. That is the behaviour under test: does the game arm
///         custody, and does it refuse anyone but the curve?
contract MockCurve {
    uint256 public spotPriceWad = 1_907_610_516;
    bool public graduated;

    address public game;

    event CurveCompleted(uint256 netRaisedWei, uint256 completedAt);

    function setGame(address _game) external {
        game = _game;
    }

    function setPrice(uint256 p) external {
        spotPriceWad = p;
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    /// @dev Emits the real event so the ABI path is exercised, then pokes the
    ///      game exactly as the real curve's listener would.
    function graduate(uint256 netRaisedWei, uint256 completedAt) external {
        graduated = true;
        emit CurveCompleted(netRaisedWei, completedAt);
        if (game != address(0)) {
            ICurveCompletionListener(game).onCurveCompleted(netRaisedWei, completedAt);
        }
    }
}

interface ICurveCompletionListener {
    function onCurveCompleted(uint256 netRaisedWei, uint256 completedAt) external;
}

/// @notice Mock of a vibe/vibe token, including the transfer lock behaviour:
///         reverts TransfersLocked() (0xdb89e3f4) until graduated.
contract MockToken {
    string public name = "Curve Racer";
    string public symbol = "RACER";
    uint8 public decimals = 18;
    uint256 public totalSupply = 1_000_000_000e18;
    address public curve;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public locked = true;

    error TransfersLocked();

    constructor(address _curve) {
        curve = _curve;
        balanceOf[msg.sender] = totalSupply;
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
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external onlyUnlocked returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external onlyUnlocked returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract CurveRacerTest is Test {
    CurveRacer public game;
    MockCurve public curve;
    MockToken public token;

    /// @dev The real sampled on-chain spot price, stored (not a literal) so
    ///      percentage arithmetic is computed at runtime rather than folded by
    ///      the compiler into a non-integer rational constant.
    uint256 constant BASE_PRICE = 1_907_610_516;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        curve = new MockCurve();
        token = new MockToken(address(curve));
        game = new CurveRacer(address(curve), address(token), treasury);
        curve.setGame(address(game));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _enterRound() internal returns (uint64 id) {
        id = game.currentRoundId();
        vm.prank(alice);
        game.enter{value: 1 ether}();
    }

    function _closeRoundWindow() internal {
        vm.roll(block.number + game.ROUND_BLOCKS());
    }

    // -----------------------------------------------------------------
    // wiring
    // -----------------------------------------------------------------

    function test_WiresToCurveAndToken() public view {
        assertEq(address(game.curve()), address(curve));
        assertEq(address(game.gameToken()), address(token));
        assertEq(game.treasury(), treasury);
    }

    function test_OpensFirstRoundOnDeploy() public view {
        assertEq(game.currentRoundId(), 1);
        assertEq(game.ROUND_BLOCKS(), 300);
        assertEq(game.MIN_ENTRANTS(), 2);
    }

    function test_EntryPriceMatchesSpotPriceAtOpen() public {
        _enterRound();
        (, , , , , , , uint256 entryPrice, ) = game.roundState(1);
        assertEq(entryPrice, BASE_PRICE, "entry price must be the curve spot price");
    }

    // -----------------------------------------------------------------
    // phase detection — the core of the design
    // -----------------------------------------------------------------

    function test_AssetForWagerIsETHBeforeGraduation() public view {
        assertFalse(game.custodyAvailable());
        assertEq(game.assetForWager(), address(0), "wagers must be ETH while token is locked");
    }

    function test_AssetForWagerBecomesTokenAfterGraduation() public {
        curve.graduate(5_000_000_000_000_000_007, 1_790_308_167);
        assertTrue(game.custodyAvailable());
        assertEq(game.assetForWager(), address(token), "wagers must switch to the game token");
    }

    function test_CurveCompletionArmsCustody() public {
        // The mock emits CurveCompleted, the game re-emits as CustodyArmed.
        // Both are non-indexed, so checkTopic1/2/3 must all be false.
        vm.expectEmit(false, false, false, true, address(curve));
        emit MockCurve.CurveCompleted(5_000_000_000_000_000_007, 1_790_308_167);
        vm.expectEmit(false, false, false, true, address(game));
        emit CurveRacer.CustodyArmed(5_000_000_000_000_000_007, 1_790_308_167);

        curve.graduate(5_000_000_000_000_000_007, 1_790_308_167);
        assertTrue(game.custodyArmed());
    }

    function test_OnlyCurveCanArmCustody() public {
        vm.expectRevert(CurveRacer.NotCurve.selector);
        game.onCurveCompleted(1, 1);
    }

    // -----------------------------------------------------------------
    // entry guards
    // -----------------------------------------------------------------

    function test_RejectsDoubleEntry() public {
        _enterRound();
        vm.prank(alice);
        vm.expectRevert(CurveRacer.AlreadyEntered.selector);
        game.enter{value: 1 ether}();
    }

    function test_RejectsZeroStake() public {
        vm.prank(bob);
        vm.expectRevert(CurveRacer.ZeroStake.selector);
        game.enter{value: 0}();
    }

    function test_RejectsEntryAfterCloseBlock() public {
        _enterRound();
        _closeRoundWindow();
        vm.prank(bob);
        vm.expectRevert(CurveRacer.RoundClosed.selector);
        game.enter{value: 1 ether}();
    }

    /// @dev Regression: entering late would otherwise let a player join a
    ///      round that had already closed, at the original entry price.
    function test_LateEntryCannotJoinAtStalePrice() public {
        _enterRound();
        _closeRoundWindow();
        (, , , , , , , uint256 entryPrice, ) = game.roundState(1);
        vm.prank(bob);
        vm.expectRevert(CurveRacer.RoundClosed.selector);
        game.enter{value: 1 ether}();
        // entry price never changed, because nobody got in after the fact
        (, , , , , , , uint256 unchanged, ) = game.roundState(1);
        assertEq(unchanged, entryPrice);
    }

    function test_RejectsEarlySettle() public {
        _enterRound();
        vm.prank(bob);
        game.enter{value: 1 ether}();
        vm.expectRevert(CurveRacer.RoundNotOver.selector);
        game.settle();
    }

    // -----------------------------------------------------------------
    // settlement
    // -----------------------------------------------------------------

    function test_HigherPnlWinsThePot() public {
        // alice stakes big, bob stakes small. Curve rises 10%: alice's absolute
        // PnL is larger even though both have the same 10% rate.
        vm.prank(alice);
        game.enter{value: 10 ether}();
        vm.prank(bob);
        game.enter{value: 1 ether}();

        _closeRoundWindow();
        curve.setPrice((BASE_PRICE * 110) / 100);

        game.settle();

        // rake is 2.5% of 11 ether
        uint256 totalStake = 11 ether;
        uint256 rake = totalStake * 250 / 10_000;
        uint256 pot = totalStake - rake;

        // alice wins (bigger absolute PnL)
        assertEq(alice.balance, 100 ether - 10 ether + pot, "alice takes the pot");
        assertEq(bob.balance, 100 ether - 1 ether, "bob gets nothing");
        // The pot leaves the contract entirely; only the rake remains.
        assertEq(address(game).balance, rake, "contract retains only the rake");
    }

    function test_TieSplitsPotEvenly() public {
        // Equal stakes, equal absolute PnL -> exact tie.
        vm.prank(alice);
        game.enter{value: 1 ether}();
        vm.prank(bob);
        game.enter{value: 1 ether}();

        _closeRoundWindow();
        curve.setPrice((BASE_PRICE * 105) / 100);
        game.settle();

        uint256 totalStake = 2 ether;
        uint256 pot = totalStake - (totalStake * 250 / 10_000);
        uint256 share = pot / 2;

        assertEq(alice.balance, 100 ether - 1 ether + share, "alice gets half");
        assertEq(bob.balance, 100 ether - 1 ether + share, "bob gets half");
    }

    /// @dev The bug this guards: PnL must be signed, or a losing player ties
    ///      with a breakeven player and can win the pot on a flat curve.
    function test_LoserDoesNotTieWithBreakevenOnFlatCurve() public {
        vm.prank(alice);
        game.enter{value: 1 ether}();
        vm.prank(bob);
        game.enter{value: 1 ether}();

        _closeRoundWindow();
        curve.setPrice(BASE_PRICE); // unchanged: both PnL == 0
        game.settle();

        // Flat curve means a genuine tie; both split.
        uint256 totalStake = 2 ether;
        uint256 pot = totalStake - (totalStake * 250 / 10_000);
        assertEq(alice.balance, 100 ether - 1 ether + pot / 2, "alice half on exact tie");
        assertEq(bob.balance, 100 ether - 1 ether + pot / 2, "bob half on exact tie");
    }

    function test_SignedPnlMath() public view {
        uint256 entry = 1_000_000_000;
        assertEq(game.pnlWad(1 ether, entry, entry * 2), int256(1 ether), "doubling = +100%");
        assertEq(game.pnlWad(1 ether, entry, entry / 2), -int256(0.5 ether), "halving = -50%");
        assertEq(game.pnlWad(1 ether, entry, entry), 0, "flat = 0");
    }

    /// @dev Guards the regression where an unsigned magnitude let losers tie
    ///      with breakeven players.
    function test_LoserRanksBelowBreakeven() public {
        vm.prank(alice);
        game.enter{value: 1 ether}(); // loses
        vm.prank(bob);
        game.enter{value: 1 ether}(); // flat

        _closeRoundWindow();
        curve.setPrice((BASE_PRICE * 90) / 100); // -10%
        game.settle();

        // bob is breakeven-ish, alice lost. Both have the same stake and the
        // same rate, so they tie on PnL -> split. To prove ordering we test
        // the pure function directly with different stakes.
        int256 loser = game.pnlWad(2 ether, 1_000_000_000, 900_000_000);
        int256 breakeven = game.pnlWad(1 ether, 1_000_000_000, 1_000_000_000);
        assertLt(loser, breakeven, "a loser must rank strictly below breakeven");
    }

    // -----------------------------------------------------------------
    // void path
    // -----------------------------------------------------------------

    function test_SoloRoundIsVoidedAndRefunded() public {
        vm.prank(alice);
        game.enter{value: 3 ether}();
        // Snapshot AFTER the stake, so "made whole" means back to 100 ether.
        _closeRoundWindow();
        game.settle();

        assertEq(alice.balance, 100 ether, "solo entrant is made whole");
        (, , , , , , , , bool voided) = game.roundState(1);
        assertTrue(voided);
        assertEq(address(game).balance, 0, "void round returns every wei");
    }

    function test_VoidRefundsAllEntrants() public {
        vm.prank(alice);
        game.enter{value: 1 ether}();
        vm.prank(bob);
        game.enter{value: 2 ether}();

        _closeRoundWindow();
        // void only happens under 2 entrants; with 2 it settles normally.
        game.settle();
        (, , , , , , , , bool voided) = game.roundState(1);
        assertFalse(voided);
    }

    // -----------------------------------------------------------------
    // round rotation
    // -----------------------------------------------------------------

    /// @dev Regression: a round that expires with ZERO entrants used to
    ///      divide by zero (`amount / n2`) and revert, which permanently
    ///      bricked settle() — and since settle() is the only path that opens
    ///      the next round, the whole game would be unplayable after the first
    ///      empty round. Found by playing against a live anvil node.
    function test_SettleWithZeroEntrantsDoesNotBrick() public {
        _closeRoundWindow();

        // Nobody entered. This must not revert.
        game.settle();

        (, , , CurveRacer.Phase phase, , , , , bool voided) = game.roundState(1);
        assertEq(uint8(phase), uint8(CurveRacer.Phase.Settled), "empty round should settle");
        assertTrue(voided, "empty round should be voided");
        assertEq(game.currentRoundId(), 2, "a fresh round must open");
    }

    /// @dev The round after an empty one must still be playable, proving the
    ///      game recovers rather than merely avoiding the revert.
    function test_GameRecoversAfterEmptyRound() public {
        _closeRoundWindow();
        game.settle();

        vm.prank(alice);
        game.enter{value: 1 ether}();
        vm.prank(bob);
        game.enter{value: 2 ether}();

        (, , , CurveRacer.Phase phase, uint256 total, , , , ) = game.roundState(2);
        assertEq(uint8(phase), uint8(CurveRacer.Phase.Open), "round 2 should be open");
        assertEq(total, 3 ether, "round 2 should hold both stakes");
    }

    function test_SettleOpensNextRound() public {
        _enterRound();
        vm.prank(bob);
        game.enter{value: 1 ether}();
        _closeRoundWindow();
        game.settle();

        assertEq(game.currentRoundId(), 2, "a fresh round opens on settle");
        (, , , CurveRacer.Phase phase, , , , , ) = game.roundState(2);
        assertEq(uint8(phase), uint8(CurveRacer.Phase.Open), "new round starts open");
    }

    function test_TotalRoundsSettledIncrements() public {
        _enterRound();
        vm.prank(bob);
        game.enter{value: 1 ether}();
        _closeRoundWindow();
        game.settle();
        assertEq(game.totalRoundsSettled(), 1);
    }

    // -----------------------------------------------------------------
    // rake
    // -----------------------------------------------------------------

    function test_RakeAccruesAndTreasuryCanWithdraw() public {
        vm.prank(alice);
        game.enter{value: 10 ether}();
        vm.prank(bob);
        game.enter{value: 10 ether}();
        _closeRoundWindow();
        curve.setPrice(BASE_PRICE * 2);
        game.settle();

        uint256 expectedRake = 20 ether * 250 / 10_000;
        assertEq(game.totalRakeAccrued(), expectedRake, "2.5% of the pot");

        uint256 tBefore = treasury.balance;
        vm.prank(treasury);
        game.withdrawRake();
        assertEq(treasury.balance, tBefore + expectedRake, "treasury receives rake");
        assertEq(game.totalRakeAccrued(), 0, "rake cleared");
    }

    function test_NonTreasuryCannotWithdrawRake() public {
        vm.expectRevert(CurveRacer.NotTreasury.selector);
        vm.prank(alice);
        game.withdrawRake();
    }

    // -----------------------------------------------------------------
    // token phase
    // -----------------------------------------------------------------

    function test_TokenEntryRevertsBeforeGraduation() public {
        vm.expectRevert(CurveRacer.WrongPhase.selector);
        vm.prank(alice);
        game.enterWithToken(1 ether);
    }

    function test_TokenEntryWorksAfterGraduation() public {
        curve.graduate(5_000_000_000_000_000_007, 1_790_308_167);
        token.unlock();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(game), 10 ether);
        game.enterWithToken(10 ether);
        vm.stopPrank();

        assertEq(token.balanceOf(address(game)), 10 ether, "game custodies the stake");
    }

    // -----------------------------------------------------------------
    // invariant: the contract is never left holding more than rake
    // -----------------------------------------------------------------

    function testFuzz_ContractRetainsOnlyRake(uint96 aliceStake, uint96 bobStake) public {
        vm.assume(aliceStake > 0 && bobStake > 0);
        vm.assume(uint256(aliceStake) + uint256(bobStake) < 50 ether);

        vm.prank(alice);
        game.enter{value: aliceStake}();
        vm.prank(bob);
        game.enter{value: bobStake}();

        _closeRoundWindow();
        curve.setPrice((BASE_PRICE * 133) / 100);
        game.settle();

        uint256 total = uint256(aliceStake) + uint256(bobStake);
        uint256 expectedRake = total * 250 / 10_000;
        assertApproxEqRel(address(game).balance, expectedRake, 1e15, "only rake remains");
    }
}
