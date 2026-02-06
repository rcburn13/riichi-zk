// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[] calldata
    ) external view returns (bool);
}

contract RiichiSettlementV1_1 is ReentrancyGuard {
    uint256 public constant HOUSE_FEE_BPS = 5; // 0.05%
    uint256 public constant BPS_DENOM = 10_000;

    uint256 public immutable ENGINE_VERSION_HASH;
    IGroth16Verifier public immutable verifier;
    address public immutable house;

    enum GameStatus { None, Open, Active, Settled, Finalized }

    struct Game {
        GameStatus status;
        address[] players;

        uint256 stakePerPlayer;
        uint256 bondPerPlayer;

        uint256 fundDeadline;
        uint256 settleDeadline;
        uint256 challengeWindow;

        uint256 pot;
        uint256 bondPool;

        mapping(address => bool) joined;
        mapping(address => bool) funded;

        bytes32 engineOutputHash;
        address winner;
        uint256 settledAt;
    }

    mapping(bytes32 => Game) private games;
    mapping(address => uint256) public claimable;

    constructor(address _verifier, uint256 _engineVersionHash) {
        verifier = IGroth16Verifier(_verifier);
        ENGINE_VERSION_HASH = _engineVersionHash;
        house = msg.sender;
    }

    function createGame(
        bytes32 gameId,
        address[] calldata players,
        uint256 stakePerPlayer,
        uint256 bondPerPlayer,
        uint256 fundDuration,
        uint256 settleDuration,
        uint256 challengeWindow
    ) external {
        require(games[gameId].status == GameStatus.None, "exists");
        require(players.length >= 2 && players.length <= 4, "players");
        require(stakePerPlayer > 0, "stake");

        Game storage g = games[gameId];
        g.status = GameStatus.Open;
        g.players = players;
        g.stakePerPlayer = stakePerPlayer;
        g.bondPerPlayer = bondPerPlayer;
        g.fundDeadline = block.timestamp + fundDuration;
        g.settleDeadline = block.timestamp + settleDuration;
        g.challengeWindow = challengeWindow;
    }

    function join(bytes32 gameId) external {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Open, "not open");
        require(_isPlayer(g.players, msg.sender), "not player");
        g.joined[msg.sender] = true;
    }

    function fund(bytes32 gameId) external payable {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Open, "not open");
        require(g.joined[msg.sender], "join first");
        require(!g.funded[msg.sender], "funded");

        uint256 required = g.stakePerPlayer + g.bondPerPlayer;
        require(msg.value == required, "value");

        g.funded[msg.sender] = true;
        g.pot += g.stakePerPlayer;
        g.bondPool += g.bondPerPlayer;

        if (_allFunded(g)) {
            g.status = GameStatus.Active;
        }
    }

    function cancelUnfunded(bytes32 gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Open, "bad state");
        require(block.timestamp > g.fundDeadline, "too early");

        g.status = GameStatus.Finalized;

        for (uint256 i = 0; i < g.players.length; i++) {
            address p = g.players[i];
            if (g.funded[p]) {
                claimable[p] += g.stakePerPlayer + g.bondPerPlayer;
            }
        }
    }

    function settle(
        bytes32 gameId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata ps
    ) external {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Active, "not active");
        require(block.timestamp <= g.settleDeadline, "late");

        require(ps.length >= 5, "signals");
        require(ps[0] == ENGINE_VERSION_HASH, "engine");
        require(ps[1] == uint256(gameId), "game");
        require(ps[4] == 1, "no win");

        address winner = address(uint160(ps[3]));
        require(_isPlayer(g.players, winner), "winner");
        require(verifier.verifyProof(a, b, c, ps), "proof");

        g.status = GameStatus.Settled;
        g.engineOutputHash = bytes32(ps[2]);
        g.winner = winner;
        g.settledAt = block.timestamp;
    }

    function finalizeSettlement(bytes32 gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Settled, "not settled");
        require(block.timestamp > g.settledAt + g.challengeWindow, "challenge");

        g.status = GameStatus.Finalized;

        uint256 fee = (g.pot * HOUSE_FEE_BPS) / BPS_DENOM;
        uint256 payout = g.pot - fee;

        claimable[house] += fee;
        claimable[g.winner] += payout;

        uint256 perBond = g.bondPool / g.players.length;
        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += perBond;
        }
    }

    function finalizeExpired(bytes32 gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Active, "bad state");
        require(block.timestamp > g.settleDeadline, "too early");

        g.status = GameStatus.Finalized;

        uint256 perStake = g.pot / g.players.length;
        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += perStake;
        }

        uint256 bounty = g.bondPool / 10;
        claimable[msg.sender] += bounty;

        uint256 rest = g.bondPool - bounty;
        uint256 per = rest / g.players.length;
        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += per;
        }
    }

    function withdraw() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        require(amt > 0, "none");
        claimable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "transfer");
    }

    function getGameStatus(bytes32 gameId) external view returns (GameStatus) {
        return games[gameId].status;
    }

    function _allFunded(Game storage g) internal view returns (bool) {
        for (uint256 i = 0; i < g.players.length; i++) {
            if (!g.funded[g.players[i]]) return false;
        }
        return true;
    }

    function _isPlayer(address[] memory ps, address p) internal pure returns (bool) {
        for (uint256 i = 0; i < ps.length; i++) {
            if (ps[i] == p) return true;
        }
        return false;
    }
}
