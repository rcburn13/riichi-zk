// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/RiichiSettlementV1_1.sol";
import "../contracts/MockVerifier.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function deal(address, uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract RiichiSettlementTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256(bytes("RiichiSettlementV1_1"));
    bytes32 private constant VERSION_HASH = keccak256(bytes("1"));
    bytes32 private constant CREATE_GAME_TYPEHASH =
        keccak256(
            "CreateGame(bytes32 gameId,bytes32 playersHash,uint256 stakePerPlayer,uint256 bondPerPlayer,uint256 fundDuration,uint256 settleDuration,uint256 challengeWindow)"
        );
    uint256 private constant PK_A = 0xA11CE;
    uint256 private constant PK_B = 0xB0B;
    uint256 private constant PK_C = 0xC0C;

    event GameCreated(
        bytes32 indexed gameId,
        bytes32 indexed playersHash,
        uint256 playersCount,
        uint256 stakePerPlayer,
        uint256 bondPerPlayer,
        uint256 fundDeadline,
        uint256 settleDeadline,
        uint256 challengeWindow
    );
    event PlayerJoined(bytes32 indexed gameId, address indexed player);
    event PlayerFunded(bytes32 indexed gameId, address indexed player, uint256 amount);
    event GameActivated(bytes32 indexed gameId);
    event GameSettled(bytes32 indexed gameId, address indexed winner, bytes32 engineOutputHash);
    event GameFinalized(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 fee);
    event GameExpiredFinalized(bytes32 indexed gameId, address indexed caller, uint256 bounty);
    event GameChallenged(bytes32 indexed gameId, address indexed challenger, uint256 bond, bytes32 reasonHash);
    event ChallengeResolved(bytes32 indexed gameId, uint8 outcome, address indexed winner);
    event GameCanceled(bytes32 indexed gameId);
    event Withdrawal(address indexed player, uint256 amount);

    struct GameParams {
        bytes32 gameId;
        uint256 stakePerPlayer;
        uint256 bondPerPlayer;
        uint256 fundDuration;
        uint256 settleDuration;
        uint256 challengeWindow;
    }

    function _params(bytes32 gameId, uint256 fundDuration) internal pure returns (GameParams memory) {
        return
            GameParams({
                gameId: gameId,
                stakePerPlayer: 100,
                bondPerPlayer: 10,
                fundDuration: fundDuration,
                settleDuration: 1000,
                challengeWindow: 50
            });
    }

    function _paramsCustom(
        bytes32 gameId,
        uint256 stakePerPlayer,
        uint256 bondPerPlayer,
        uint256 fundDuration,
        uint256 settleDuration
    ) internal pure returns (GameParams memory) {
        return
            GameParams({
                gameId: gameId,
                stakePerPlayer: stakePerPlayer,
                bondPerPlayer: bondPerPlayer,
                fundDuration: fundDuration,
                settleDuration: settleDuration,
                challengeWindow: 50
            });
    }

    function _signCreateGame(
        uint256 pk,
        address verifyingContract,
        address[] memory players,
        GameParams memory p
    ) internal returns (bytes memory) {
        bytes32 playersHash = keccak256(abi.encode(players));
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, verifyingContract)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_GAME_TYPEHASH,
                p.gameId,
                playersHash,
                p.stakePerPlayer,
                p.bondPerPlayer,
                p.fundDuration,
                p.settleDuration,
                p.challengeWindow
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deploy() internal returns (RiichiSettlementV1_1) {
        MockVerifier mock = new MockVerifier();
        return new RiichiSettlementV1_1(address(mock), 123);
    }

    function _joinAndFundAll(
        RiichiSettlementV1_1 settlement,
        bytes32 gameId,
        address[] memory players,
        uint256 value
    ) internal {
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            vm.prank(p);
            settlement.join(gameId);
            vm.deal(p, value);
            vm.prank(p);
            settlement.fund{value: value}(gameId);
        }
    }

    function _publicSignals(bytes32 gameId, address winner) internal pure returns (uint256[5] memory ps) {
        ps[0] = 123;
        ps[1] = uint256(gameId);
        ps[2] = 0;
        ps[3] = uint256(uint160(winner));
        ps[4] = 1;
    }

    function _settle(RiichiSettlementV1_1 settlement, bytes32 gameId, address winner) internal {
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        uint256[5] memory ps = _publicSignals(gameId, winner);
        settlement.settle(gameId, a, b, c, ps);
    }

    function _snapshotClaims(
        RiichiSettlementV1_1 settlement,
        address[] memory addrs
    ) internal view returns (uint256[] memory snap) {
        snap = new uint256[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            snap[i] = settlement.claimable(addrs[i]);
        }
    }

    function _assertMonotonic(
        RiichiSettlementV1_1 settlement,
        address[] memory addrs,
        uint256[] memory prev
    ) internal view returns (uint256[] memory next) {
        next = new uint256[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            next[i] = settlement.claimable(addrs[i]);
            require(next[i] >= prev[i], "claimable");
        }
    }

    function _updateTotals(
        RiichiSettlementV1_1 settlement,
        address[] memory tracked,
        uint256[] memory withdrawn,
        uint256[] memory prevTotals
    ) internal view {
        for (uint256 i = 0; i < tracked.length; i++) {
            uint256 total = settlement.claimable(tracked[i]) + withdrawn[i];
            require(total >= prevTotals[i], "total");
            prevTotals[i] = total;
        }
    }

    function _withdrawAll(
        RiichiSettlementV1_1 settlement,
        address[] memory players,
        uint256[] memory withdrawn
    ) internal {
        for (uint256 i = 0; i < players.length; i++) {
            address paddr = players[i];
            uint256 amt = settlement.claimable(paddr);
            if (amt > 0) {
                withdrawn[i] += amt;
                vm.prank(paddr);
                settlement.withdraw();
            }
        }
    }

    function _signAll(
        RiichiSettlementV1_1 settlement,
        address[] memory players,
        GameParams memory p
    ) internal returns (bytes[] memory sigs) {
        sigs = new bytes[](players.length);
        for (uint256 i = 0; i < players.length; i++) {
            uint256 pk = i == 0 ? PK_A : (i == 1 ? PK_B : PK_C);
            sigs[i] = _signCreateGame(pk, address(settlement), players, p);
        }
    }

    function _createGameSigned(
        RiichiSettlementV1_1 settlement,
        address[] memory players,
        GameParams memory p
    ) internal {
        bytes[] memory sigs = _signAll(settlement, players, p);
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testDuplicatePlayersReverts() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = a;

        bytes32 gameId = keccak256(abi.encodePacked("game-dup"));
        GameParams memory p = _params(gameId, 100);

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);
        sigs[2] = _signCreateGame(PK_A, address(settlement), players, p);

        vm.expectRevert(bytes("dup"));
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testJoinFundLateReverts() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-late"));
        GameParams memory p = _params(gameId, 10);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        vm.prank(a);
        settlement.join(gameId);

        vm.warp(block.timestamp + 11);

        vm.expectRevert(bytes("late"));
        vm.prank(b);
        settlement.join(gameId);

        vm.deal(a, p.stakePerPlayer + p.bondPerPlayer);
        vm.expectRevert(bytes("late"));
        vm.prank(a);
        settlement.fund{value: p.stakePerPlayer + p.bondPerPlayer}(gameId);
    }

    function testNonPlayerSignatureReverts() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-sig"));
        GameParams memory p = _params(gameId, 100);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_C, address(settlement), players, p);

        vm.expectRevert(bytes("sig"));
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testSettleDurationTooShortReverts() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-dur"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 100, 10);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        vm.expectRevert(bytes("dur"));
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testPaidGameRequiresBond() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-bond"));
        GameParams memory p = _paramsCustom(gameId, 100, 0, 100, 1000);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        vm.expectRevert(bytes("bond"));
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testFreeGameRequiresZeroBond() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-free"));
        GameParams memory p = _paramsCustom(gameId, 0, 0, 100, 1000);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testFreeGameNonZeroBondReverts() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-free-bond"));
        GameParams memory p = _paramsCustom(gameId, 0, 1, 100, 1000);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        vm.expectRevert(bytes("free"));
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testFuzzDurationRule(uint64 fundDuration, uint64 settleDuration) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-fuzz", fundDuration, settleDuration));
        GameParams memory p = _paramsCustom(gameId, 1, 1, fundDuration, settleDuration);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        if (settleDuration < fundDuration) {
            vm.expectRevert(bytes("dur"));
        }
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testExpiredBondDustToHouse() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = c;

        bytes32 gameId = keccak256(abi.encodePacked("game-exp-dust"));
        GameParams memory p = _paramsCustom(gameId, 1, 4, 10, 100);

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);
        sigs[2] = _signCreateGame(PK_C, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);

        vm.warp(block.timestamp + p.settleDuration + 1);
        vm.prank(a);
        settlement.finalizeExpired(gameId);

        uint256 bondPool = p.bondPerPlayer * players.length;
        uint256 bounty = bondPool / 10;
        uint256 rest = bondPool - bounty;
        uint256 per = rest / players.length;
        uint256 dust = rest - (per * players.length);
        require(settlement.claimable(address(this)) == dust, "dust");
    }

    function testFuzzPlayerOrdering(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-order", seed));
        GameParams memory p = _paramsCustom(gameId, 1, 1, 10, 20);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        address[] memory swapped = new address[](2);
        swapped[0] = b;
        swapped[1] = a;

        vm.expectRevert(bytes("sig"));
        settlement.createGame(
            p.gameId,
            swapped,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );
    }

    function testFuzzBondDustToHouse(uint64 bondInput) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = c;

        uint256 bondPerPlayer = (uint256(bondInput) % 1000) + 1;
        bytes32 gameId = keccak256(abi.encodePacked("game-bond-dust", bondPerPlayer, bondInput));
        GameParams memory p = _paramsCustom(gameId, 1, bondPerPlayer, 10, 100);

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);
        sigs[2] = _signCreateGame(PK_C, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);

        vm.warp(block.timestamp + p.settleDuration + 1);
        vm.prank(a);
        settlement.finalizeExpired(gameId);

        uint256 bondPool = p.bondPerPlayer * players.length;
        uint256 bounty = bondPool / 10;
        uint256 rest = bondPool - bounty;
        uint256 per = rest / players.length;
        uint256 dust = rest - (per * players.length);
        require(settlement.claimable(address(this)) == dust, "dust");
    }

    function testFuzzDeadlineEdges(uint64 fundDeltaRaw, uint64 settleDeltaRaw) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-deadline", fundDeltaRaw, settleDeltaRaw));
        GameParams memory p = _paramsCustom(gameId, 1, 1, 10, 20);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        uint256 start = block.timestamp;
        uint256 fundDelta = uint256(fundDeltaRaw % 3);
        uint256 settleDelta = uint256(settleDeltaRaw % 3);

        vm.warp(start + p.fundDuration + fundDelta);
        if (fundDelta == 0) {
            _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        } else {
            vm.expectRevert(bytes("late"));
            vm.prank(a);
            settlement.join(gameId);
            return;
        }

        vm.warp(start + p.settleDuration + settleDelta);
        if (settleDelta > 0) {
            vm.expectRevert(bytes("late"));
        }
        _settle(settlement, gameId, a);
    }

    function testEventsCreateJoinFundActivate() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-1"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        uint256 start = block.timestamp;
        uint256 fundDeadline = start + p.fundDuration;
        uint256 settleDeadline = start + p.settleDuration;

        vm.expectEmit(true, true, false, true);
        emit GameCreated(
            p.gameId,
            keccak256(abi.encode(players)),
            players.length,
            p.stakePerPlayer,
            p.bondPerPlayer,
            fundDeadline,
            settleDeadline,
            p.challengeWindow
        );
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        vm.expectEmit(true, true, false, true);
        emit PlayerJoined(gameId, a);
        vm.prank(a);
        settlement.join(gameId);

        vm.expectEmit(true, true, false, true);
        emit PlayerFunded(gameId, a, p.stakePerPlayer + p.bondPerPlayer);
        vm.deal(a, p.stakePerPlayer + p.bondPerPlayer);
        vm.prank(a);
        settlement.fund{value: p.stakePerPlayer + p.bondPerPlayer}(gameId);

        vm.expectEmit(true, true, false, true);
        emit PlayerJoined(gameId, b);
        vm.prank(b);
        settlement.join(gameId);

        vm.expectEmit(true, true, false, true);
        emit PlayerFunded(gameId, b, p.stakePerPlayer + p.bondPerPlayer);
        vm.expectEmit(true, false, false, true);
        emit GameActivated(gameId);
        vm.deal(b, p.stakePerPlayer + p.bondPerPlayer);
        vm.prank(b);
        settlement.fund{value: p.stakePerPlayer + p.bondPerPlayer}(gameId);
    }

    function testEventsSettleFinalizeWithdraw() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-2"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);

        vm.expectEmit(true, true, false, true);
        emit GameSettled(gameId, a, bytes32(0));
        _settle(settlement, gameId, a);

        vm.warp(block.timestamp + p.challengeWindow + 1);
        uint256 pot = p.stakePerPlayer * players.length;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();
        uint256 payout = pot - fee;
        vm.expectEmit(true, true, false, true);
        emit GameFinalized(gameId, a, payout, fee);
        settlement.finalizeSettlement(gameId);

        uint256 amt = settlement.claimable(a);
        vm.expectEmit(true, false, false, true);
        emit Withdrawal(a, amt);
        vm.prank(a);
        settlement.withdraw();
    }

    function testEventsFinalizeExpired() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-3"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stakePerPlayer,
            p.bondPerPlayer,
            p.fundDuration,
            p.settleDuration,
            p.challengeWindow
        );

        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);

        vm.warp(block.timestamp + p.settleDuration + 1);
        uint256 bondPool = p.bondPerPlayer * players.length;
        uint256 bounty = bondPool / 10;
        vm.expectEmit(true, true, false, true);
        emit GameExpiredFinalized(gameId, a, bounty);
        vm.prank(a);
        settlement.finalizeExpired(gameId);
    }

    function testEventsCancelUnfunded() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-unfunded"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);

        vm.prank(a);
        settlement.join(gameId);
        vm.deal(a, p.stakePerPlayer + p.bondPerPlayer);
        vm.prank(a);
        settlement.fund{value: p.stakePerPlayer + p.bondPerPlayer}(gameId);

        vm.warp(block.timestamp + p.fundDuration + 1);

        vm.expectEmit(true, true, false, true);
        emit GameCanceled(gameId);
        settlement.cancelUnfunded(gameId);
    }

    function testChallengeBondPaidGame() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-challenge-bond"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 bond = (p.stakePerPlayer * players.length) / 2;
        vm.deal(b, bond - 1);
        vm.expectRevert(bytes("bond"));
        vm.prank(b);
        settlement.challenge{value: bond - 1}(gameId, bytes32("reason"));

        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, bytes32("reason"));

        require(settlement.getGameStatus(gameId) == RiichiSettlementV1_1.GameStatus.Disputed, "status");
    }

    function testChallengeUpholdBondToHouse() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-challenge-uphold"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 pot = p.stakePerPlayer * players.length;
        uint256 bond = pot / 2;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();

        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, bytes32("reason"));

        settlement.resolveChallengeUphold(gameId);

        require(settlement.claimable(address(this)) == bond + fee, "house");
        require(settlement.claimable(b) == p.bondPerPlayer, "challenger");
    }

    function testFuzzChallengeCancel(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        uint256 stake = (uint256(seed) % 50) + 1;
        uint256 bond = (uint256(seed >> 8) % 25) + 1;
        bytes32 gameId = keccak256(abi.encodePacked("game-chal-cancel", seed));
        GameParams memory p = _paramsCustom(gameId, stake, bond, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 challengeBond = (p.stakePerPlayer * players.length) / 2;
        vm.deal(b, challengeBond);
        vm.prank(b);
        settlement.challenge{value: challengeBond}(gameId, bytes32("cancel"));

        settlement.resolveChallengeCancel(gameId);

        require(settlement.claimable(a) == p.stakePerPlayer + p.bondPerPlayer, "refund");
        require(settlement.claimable(b) == p.stakePerPlayer + p.bondPerPlayer + challengeBond, "challenger");
    }

    function testFuzzChallengeOverride(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        uint256 stake = (uint256(seed) % 50) + 1;
        uint256 bond = (uint256(seed >> 8) % 25) + 1;
        bytes32 gameId = keccak256(abi.encodePacked("game-chal-override", seed));
        GameParams memory p = _paramsCustom(gameId, stake, bond, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 pot = p.stakePerPlayer * players.length;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();
        uint256 payout = pot - fee;
        uint256 challengeBond = pot / 2;

        vm.deal(b, challengeBond);
        vm.prank(b);
        settlement.challenge{value: challengeBond}(gameId, bytes32("override"));

        settlement.resolveChallengeOverride(gameId, b);

        require(settlement.claimable(b) == payout + p.bondPerPlayer + challengeBond, "winner");
        require(settlement.claimable(address(this)) == fee, "house");
    }

    function testEventsChallengeAndResolve() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-challenge"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 bond = (p.stakePerPlayer * players.length) / 2;
        bytes32 reason = bytes32("reason");

        vm.expectEmit(true, true, false, true);
        emit GameChallenged(gameId, b, bond, reason);
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, reason);

        vm.expectEmit(true, true, false, true);
        emit ChallengeResolved(gameId, 1, address(0));
        settlement.resolveChallengeCancel(gameId);
    }

    function testEventsChallengeResolveUphold() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-challenge-uphold"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 bond = (p.stakePerPlayer * players.length) / 2;
        bytes32 reason = bytes32("reason");

        vm.expectEmit(true, true, false, true);
        emit GameChallenged(gameId, b, bond, reason);
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, reason);

        vm.expectEmit(true, true, false, true);
        emit ChallengeResolved(gameId, 0, a);
        settlement.resolveChallengeUphold(gameId);
    }

    function testEventsChallengeResolveOverride() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-challenge-override"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 bond = (p.stakePerPlayer * players.length) / 2;
        bytes32 reason = bytes32("reason");

        vm.expectEmit(true, true, false, true);
        emit GameChallenged(gameId, b, bond, reason);
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, reason);

        vm.expectEmit(true, true, false, true);
        emit ChallengeResolved(gameId, 2, b);
        settlement.resolveChallengeOverride(gameId, b);
    }

    function testEventsChallengeUpholdFinalized() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-uphold-finalized"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 pot = p.stakePerPlayer * players.length;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();
        uint256 payout = pot - fee;
        uint256 bond = pot / 2;

        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, bytes32("reason"));

        vm.expectEmit(true, true, false, true);
        emit GameFinalized(gameId, a, payout, fee);
        settlement.resolveChallengeUphold(gameId);
    }

    function testEventsChallengeCancelFinalized() public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-events-cancel-finalized"));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _settle(settlement, gameId, a);

        uint256 bond = (p.stakePerPlayer * players.length) / 2;
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(gameId, bytes32("reason"));

        vm.expectEmit(true, true, false, true);
        emit GameCanceled(gameId);
        settlement.resolveChallengeCancel(gameId);
    }

    function testFuzzTotalClaimableNeverDecreases(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        bool useThree = (seed & 1) == 1;
        address[] memory players = new address[](useThree ? 3 : 2);
        players[0] = a;
        players[1] = b;
        if (useThree) {
            players[2] = c;
        }

        uint256 stake = (uint256(seed) % 50) + 1;
        uint256 bond = (uint256(seed >> 8) % 25) + 1;
        GameParams memory p = _paramsCustom(
            keccak256(abi.encodePacked("game-total", seed)),
            stake,
            bond,
            10,
            20
        );

        address[] memory tracked = new address[](players.length + 1);
        for (uint256 i = 0; i < players.length; i++) {
            tracked[i] = players[i];
        }
        tracked[tracked.length - 1] = address(this);

        uint256[] memory withdrawn = new uint256[](tracked.length);
        uint256[] memory prevTotals = new uint256[](tracked.length);

        _createGameSigned(settlement, players, p);
        _updateTotals(settlement, tracked, withdrawn, prevTotals);

        _joinAndFundAll(settlement, p.gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        _updateTotals(settlement, tracked, withdrawn, prevTotals);

        if ((seed & 2) == 0) {
            _settle(settlement, p.gameId, a);
            _updateTotals(settlement, tracked, withdrawn, prevTotals);

            vm.warp(block.timestamp + p.challengeWindow + 1);
            settlement.finalizeSettlement(p.gameId);
        } else {
            vm.warp(block.timestamp + p.settleDuration + 1);
            settlement.finalizeExpired(p.gameId);
        }

        _updateTotals(settlement, tracked, withdrawn, prevTotals);

        _withdrawAll(settlement, players, withdrawn);

        _updateTotals(settlement, tracked, withdrawn, prevTotals);
    }

    function testFuzzSignatureMismatch(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        bytes32 gameId = keccak256(abi.encodePacked("game-sig-mismatch", seed));
        GameParams memory p = _paramsCustom(gameId, 100, 10, 10, 100);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _signCreateGame(PK_A, address(settlement), players, p);
        sigs[1] = _signCreateGame(PK_B, address(settlement), players, p);

        if (seed % 2 == 0) {
            bytes32 wrongId = keccak256(abi.encodePacked(gameId, seed, "x"));
            vm.expectRevert(bytes("sig"));
            settlement.createGame(
                wrongId,
                players,
                sigs,
                p.stakePerPlayer,
                p.bondPerPlayer,
                p.fundDuration,
                p.settleDuration,
                p.challengeWindow
            );
        } else {
            uint256 wrongStake = p.stakePerPlayer + (seed % 10) + 1;
            vm.expectRevert(bytes("sig"));
            settlement.createGame(
                p.gameId,
                players,
                sigs,
                wrongStake,
                p.bondPerPlayer,
                p.fundDuration,
                p.settleDuration,
                p.challengeWindow
            );
        }
    }

    function testFuzzClaimableNeverDecreases(uint64 seed) public {
        RiichiSettlementV1_1 settlement = _deploy();

        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        bool useThree = (seed & 1) == 1;
        address[] memory players = new address[](useThree ? 3 : 2);
        players[0] = a;
        players[1] = b;
        if (useThree) {
            players[2] = c;
        }

        uint256 stake = (uint256(seed) % 50) + 1;
        uint256 bond = (uint256(seed >> 8) % 25) + 1;
        GameParams memory p = _paramsCustom(
            keccak256(abi.encodePacked("game-claimable", seed)),
            stake,
            bond,
            10,
            20
        );

        address[] memory tracked = new address[](players.length + 1);
        for (uint256 i = 0; i < players.length; i++) {
            tracked[i] = players[i];
        }
        tracked[tracked.length - 1] = address(this);

        uint256[] memory prev = _snapshotClaims(settlement, tracked);

        _createGameSigned(settlement, players, p);
        prev = _assertMonotonic(settlement, tracked, prev);

        _joinAndFundAll(settlement, p.gameId, players, p.stakePerPlayer + p.bondPerPlayer);
        prev = _assertMonotonic(settlement, tracked, prev);

        if ((seed & 2) == 0) {
            _settle(settlement, p.gameId, a);
            prev = _assertMonotonic(settlement, tracked, prev);

            vm.warp(block.timestamp + p.challengeWindow + 1);
            settlement.finalizeSettlement(p.gameId);
            prev = _assertMonotonic(settlement, tracked, prev);
        } else {
            vm.warp(block.timestamp + p.settleDuration + 1);
            settlement.finalizeExpired(p.gameId);
            prev = _assertMonotonic(settlement, tracked, prev);
        }

        if ((seed & 4) != 0) {
            bytes32 gameId2 = keccak256(abi.encodePacked("game-cancel", seed));
            GameParams memory p2 = _paramsCustom(gameId2, stake, bond, 5, 10);

            _createGameSigned(settlement, players, p2);
            prev = _assertMonotonic(settlement, tracked, prev);

            vm.prank(players[0]);
            settlement.join(p2.gameId);
            vm.deal(players[0], p2.stakePerPlayer + p2.bondPerPlayer);
            vm.prank(players[0]);
            settlement.fund{value: p2.stakePerPlayer + p2.bondPerPlayer}(p2.gameId);
            prev = _assertMonotonic(settlement, tracked, prev);

            vm.warp(block.timestamp + p2.fundDuration + 1);
            settlement.cancelUnfunded(p2.gameId);
            prev = _assertMonotonic(settlement, tracked, prev);
        }

        prev;
    }
}
