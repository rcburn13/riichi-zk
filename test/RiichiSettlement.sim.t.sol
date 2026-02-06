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
}

contract RiichiSettlementSimTest {
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

    struct Params {
        bytes32 gameId;
        uint256 stake;
        uint256 bond;
        uint256 fund;
        uint256 settle;
        uint256 challenge;
    }

    function _deploy() internal returns (RiichiSettlementV1_1) {
        MockVerifier mock = new MockVerifier();
        return new RiichiSettlementV1_1(address(mock), 123);
    }

    function _params(bytes32 gameId, uint256 stake, uint256 bond) internal pure returns (Params memory) {
        return Params({gameId: gameId, stake: stake, bond: bond, fund: 10, settle: 100, challenge: 5});
    }

    function _signCreateGame(
        uint256 pk,
        address verifyingContract,
        address[] memory players,
        Params memory p
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
                p.stake,
                p.bond,
                p.fund,
                p.settle,
                p.challenge
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signAll(
        RiichiSettlementV1_1 settlement,
        address[] memory players,
        Params memory p
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
        Params memory p
    ) internal {
        bytes[] memory sigs = _signAll(settlement, players, p);
        settlement.createGame(
            p.gameId,
            players,
            sigs,
            p.stake,
            p.bond,
            p.fund,
            p.settle,
            p.challenge
        );
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

    function _settle(RiichiSettlementV1_1 settlement, bytes32 gameId, address winner) internal {
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        uint256[] memory ps = new uint256[](5);
        ps[0] = 123;
        ps[1] = uint256(gameId);
        ps[2] = 0;
        ps[3] = uint256(uint160(winner));
        ps[4] = 1;
        settlement.settle(gameId, a, b, c, ps);
    }

    function testSimHappyPath() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = c;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-happy")), 100, 10);
        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, p.gameId, players, p.stake + p.bond);
        _settle(settlement, p.gameId, a);

        vm.warp(block.timestamp + p.challenge + 1);
        settlement.finalizeSettlement(p.gameId);

        uint256 pot = p.stake * players.length;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();
        uint256 payout = pot - fee;
        uint256 perBond = (p.bond * players.length) / players.length;

        require(settlement.claimable(a) == payout + perBond, "winner");
        require(settlement.claimable(b) == perBond, "p2");
        require(settlement.claimable(c) == perBond, "p3");
        require(settlement.claimable(address(this)) == fee, "house");
    }

    function testSimChallengeCancel() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-cancel")), 50, 5);
        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, p.gameId, players, p.stake + p.bond);
        _settle(settlement, p.gameId, a);

        uint256 bond = settlement.challengeBond(p.gameId);
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(p.gameId, bytes32("reason"));

        settlement.resolveChallengeCancel(p.gameId);

        require(settlement.claimable(a) == p.stake + p.bond, "refundA");
        require(settlement.claimable(b) == p.stake + p.bond + bond, "refundB");
    }

    function testSimChallengeOverride() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-override")), 60, 6);
        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, p.gameId, players, p.stake + p.bond);
        _settle(settlement, p.gameId, a);

        uint256 bond = settlement.challengeBond(p.gameId);
        vm.deal(b, bond);
        vm.prank(b);
        settlement.challenge{value: bond}(p.gameId, bytes32("reason"));

        settlement.resolveChallengeOverride(p.gameId, b);

        uint256 pot = p.stake * players.length;
        uint256 fee = (pot * settlement.HOUSE_FEE_BPS()) / settlement.BPS_DENOM();
        uint256 payout = pot - fee;
        uint256 perBond = (p.bond * players.length) / players.length;

        require(settlement.claimable(b) == payout + perBond + bond, "winner");
        require(settlement.claimable(address(this)) == fee, "house");
    }

    function testSimExpired() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = c;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-expired")), 30, 7);
        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, p.gameId, players, p.stake + p.bond);

        vm.warp(block.timestamp + p.settle + 1);
        vm.prank(a);
        settlement.finalizeExpired(p.gameId);

        uint256 pot = p.stake * players.length;
        uint256 perStake = pot / players.length;

        uint256 bondPool = p.bond * players.length;
        uint256 bounty = bondPool / 10;
        uint256 rest = bondPool - bounty;
        uint256 perBond = rest / players.length;
        uint256 dust = rest - (perBond * players.length);

        require(settlement.claimable(a) == perStake + perBond + bounty, "caller");
        require(settlement.claimable(b) == perStake + perBond, "p2");
        require(settlement.claimable(c) == perStake + perBond, "p3");
        require(settlement.claimable(address(this)) == dust, "house");
    }

    function testSimCancelUnfunded() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);
        address c = vm.addr(PK_C);

        address[] memory players = new address[](3);
        players[0] = a;
        players[1] = b;
        players[2] = c;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-cancel")), 40, 4);
        _createGameSigned(settlement, players, p);

        vm.prank(a);
        settlement.join(p.gameId);
        vm.deal(a, p.stake + p.bond);
        vm.prank(a);
        settlement.fund{value: p.stake + p.bond}(p.gameId);

        vm.prank(b);
        settlement.join(p.gameId);

        vm.warp(block.timestamp + p.fund + 1);
        settlement.cancelUnfunded(p.gameId);

        require(settlement.claimable(a) == p.stake + p.bond, "refundA");
        require(settlement.claimable(b) == 0, "refundB");
        require(settlement.claimable(c) == 0, "refundC");
    }

    function testSimFreeGameChallengeBond() public {
        RiichiSettlementV1_1 settlement = _deploy();
        address a = vm.addr(PK_A);
        address b = vm.addr(PK_B);

        address[] memory players = new address[](2);
        players[0] = a;
        players[1] = b;

        Params memory p = _params(keccak256(abi.encodePacked("game-sim-free")), 0, 0);
        _createGameSigned(settlement, players, p);
        _joinAndFundAll(settlement, p.gameId, players, 0);
        _settle(settlement, p.gameId, a);

        uint256 bond = settlement.challengeBond(p.gameId);
        require(bond == settlement.FREE_GAME_CHALLENGE_BOND(), "bond");
    }
}
