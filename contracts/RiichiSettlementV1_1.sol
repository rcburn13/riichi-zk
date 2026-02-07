// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external view returns (bool);
}

contract RiichiSettlementV1_1 is ReentrancyGuard, EIP712 {
    uint256 public constant HOUSE_FEE_BPS = 5; // 0.05%
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant FREE_GAME_CHALLENGE_BOND = 0.001 ether;

    uint256 public immutable ENGINE_VERSION_HASH;
    IGroth16Verifier public immutable verifier;
    address public immutable house;

    enum GameStatus { None, Open, Active, Settled, Disputed, Finalized }

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

        address challenger;
        uint256 challengeBond;
        bytes32 challengeReasonHash;
        uint256 challengedAt;
    }

    mapping(bytes32 => Game) private games;
    mapping(address => uint256) public claimable;

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
    event GameCanceled(bytes32 indexed gameId);
    event GameSettled(bytes32 indexed gameId, address indexed winner, bytes32 engineOutputHash);
    event GameFinalized(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 fee);
    event GameExpiredFinalized(bytes32 indexed gameId, address indexed caller, uint256 bounty);
    event GameChallenged(bytes32 indexed gameId, address indexed challenger, uint256 bond, bytes32 reasonHash);
    event ChallengeResolved(bytes32 indexed gameId, uint8 outcome, address indexed winner);
    event Withdrawal(address indexed player, uint256 amount);

    bytes32 private constant CREATE_GAME_TYPEHASH =
        keccak256(
            "CreateGame(bytes32 gameId,bytes32 playersHash,uint256 stakePerPlayer,uint256 bondPerPlayer,uint256 fundDuration,uint256 settleDuration,uint256 challengeWindow)"
        );

    modifier onlyHouse() {
        require(msg.sender == house, "house");
        _;
    }

    constructor(address _verifier, uint256 _engineVersionHash)
        EIP712("RiichiSettlementV1_1", "1")
    {
        verifier = IGroth16Verifier(_verifier);
        ENGINE_VERSION_HASH = _engineVersionHash;
        house = msg.sender;
    }

    function createGame(
        bytes32 gameId,
        address[] calldata players,
        bytes[] calldata sigs,
        uint256 stakePerPlayer,
        uint256 bondPerPlayer,
        uint256 fundDuration,
        uint256 settleDuration,
        uint256 challengeWindow
    ) external {
        require(games[gameId].status == GameStatus.None, "exists");
        require(players.length >= 2 && players.length <= 4, "players");
        require(sigs.length == players.length, "sigs");
        require(settleDuration >= fundDuration, "dur");
        if (stakePerPlayer == 0) {
            require(bondPerPlayer == 0, "free");
        } else {
            require(bondPerPlayer > 0, "bond");
        }
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            require(p != address(0), "zero");
            for (uint256 j = i + 1; j < players.length; j++) {
                require(players[j] != p, "dup");
            }
        }

        bytes32 digest = _createGameDigest(
            gameId,
            players,
            stakePerPlayer,
            bondPerPlayer,
            fundDuration,
            settleDuration,
            challengeWindow
        );
        bool[] memory used = new bool[](players.length);
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            bool found = false;
            for (uint256 j = 0; j < players.length; j++) {
                if (players[j] == signer) {
                    require(!used[j], "dup sig");
                    used[j] = true;
                    found = true;
                    break;
                }
            }
            require(found, "sig");
        }

        Game storage g = games[gameId];
        g.status = GameStatus.Open;
        g.players = players;
        g.stakePerPlayer = stakePerPlayer;
        g.bondPerPlayer = bondPerPlayer;
        g.fundDeadline = block.timestamp + fundDuration;
        g.settleDeadline = block.timestamp + settleDuration;
        g.challengeWindow = challengeWindow;

        emit GameCreated(
            gameId,
            keccak256(abi.encode(players)),
            players.length,
            stakePerPlayer,
            bondPerPlayer,
            g.fundDeadline,
            g.settleDeadline,
            challengeWindow
        );
    }

    function join(bytes32 gameId) external {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Open, "not open");
        require(block.timestamp <= g.fundDeadline, "late");
        require(_isPlayer(g.players, msg.sender), "not player");
        g.joined[msg.sender] = true;
        emit PlayerJoined(gameId, msg.sender);
    }

    function fund(bytes32 gameId) external payable {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Open, "not open");
        require(block.timestamp <= g.fundDeadline, "late");
        require(g.joined[msg.sender], "join first");
        require(!g.funded[msg.sender], "funded");

        uint256 required = g.stakePerPlayer + g.bondPerPlayer;
        require(msg.value == required, "value");

        g.funded[msg.sender] = true;
        g.pot += g.stakePerPlayer;
        g.bondPool += g.bondPerPlayer;
        emit PlayerFunded(gameId, msg.sender, msg.value);

        if (_allFunded(g)) {
            g.status = GameStatus.Active;
            emit GameActivated(gameId);
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
        emit GameCanceled(gameId);
    }

    function settle(
        bytes32 gameId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[5] calldata ps
    ) external {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Active, "not active");
        require(block.timestamp <= g.settleDeadline, "late");

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
        emit GameSettled(gameId, winner, g.engineOutputHash);
    }

    function challengeBond(bytes32 gameId) external view returns (uint256) {
        Game storage g = games[gameId];
        require(g.status != GameStatus.None, "game");
        return _challengeBond(g);
    }

    function challenge(bytes32 gameId, bytes32 reasonHash) external payable nonReentrant {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Settled, "not settled");
        require(block.timestamp <= g.settledAt + g.challengeWindow, "late");
        require(g.challenger == address(0), "challenged");

        uint256 bond = _challengeBond(g);
        require(msg.value == bond, "bond");

        g.status = GameStatus.Disputed;
        g.challenger = msg.sender;
        g.challengeBond = bond;
        g.challengeReasonHash = reasonHash;
        g.challengedAt = block.timestamp;

        emit GameChallenged(gameId, msg.sender, bond, reasonHash);
    }

    function finalizeSettlement(bytes32 gameId) external nonReentrant {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Settled, "not settled");
        require(block.timestamp > g.settledAt + g.challengeWindow, "challenge");

        _finalizeWithWinner(gameId, g, g.winner);
    }

    function resolveChallengeUphold(bytes32 gameId) external nonReentrant onlyHouse {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Disputed, "not disputed");

        claimable[house] += g.challengeBond;
        g.challengeBond = 0;

        _finalizeWithWinner(gameId, g, g.winner);
        emit ChallengeResolved(gameId, 0, g.winner);
    }

    function resolveChallengeCancel(bytes32 gameId) external nonReentrant onlyHouse {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Disputed, "not disputed");

        g.status = GameStatus.Finalized;

        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += g.stakePerPlayer + g.bondPerPlayer;
        }

        if (g.challengeBond > 0) {
            claimable[g.challenger] += g.challengeBond;
            g.challengeBond = 0;
        }

        emit GameCanceled(gameId);
        emit ChallengeResolved(gameId, 1, address(0));
    }

    function resolveChallengeOverride(bytes32 gameId, address newWinner) external nonReentrant onlyHouse {
        Game storage g = games[gameId];
        require(g.status == GameStatus.Disputed, "not disputed");
        require(_isPlayer(g.players, newWinner), "winner");

        g.winner = newWinner;

        if (g.challengeBond > 0) {
            claimable[g.challenger] += g.challengeBond;
            g.challengeBond = 0;
        }

        _finalizeWithWinner(gameId, g, newWinner);
        emit ChallengeResolved(gameId, 2, newWinner);
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
        uint256 potDust = g.pot - (perStake * g.players.length);
        if (potDust > 0) {
            claimable[house] += potDust;
        }

        uint256 bounty = g.bondPool / 10;
        claimable[msg.sender] += bounty;

        uint256 rest = g.bondPool - bounty;
        uint256 per = rest / g.players.length;
        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += per;
        }
        uint256 bondDust = rest - (per * g.players.length);
        if (bondDust > 0) {
            claimable[house] += bondDust;
        }
        emit GameExpiredFinalized(gameId, msg.sender, bounty);
    }

    function withdraw() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        require(amt > 0, "none");
        claimable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "transfer");
        emit Withdrawal(msg.sender, amt);
    }

    function getGameStatus(bytes32 gameId) external view returns (GameStatus) {
        return games[gameId].status;
    }

    function _challengeBond(Game storage g) internal view returns (uint256) {
        if (g.stakePerPlayer == 0) {
            return FREE_GAME_CHALLENGE_BOND;
        }
        return g.pot / 2;
    }

    function _finalizeWithWinner(bytes32 gameId, Game storage g, address winner) internal {
        g.status = GameStatus.Finalized;

        uint256 fee = (g.pot * HOUSE_FEE_BPS) / BPS_DENOM;
        uint256 payout = g.pot - fee;

        claimable[house] += fee;
        claimable[winner] += payout;

        uint256 perBond = g.bondPool / g.players.length;
        for (uint256 i = 0; i < g.players.length; i++) {
            claimable[g.players[i]] += perBond;
        }
        uint256 bondDust = g.bondPool - (perBond * g.players.length);
        if (bondDust > 0) {
            claimable[house] += bondDust;
        }

        emit GameFinalized(gameId, winner, payout, fee);
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

    function _createGameDigest(
        bytes32 gameId,
        address[] calldata players,
        uint256 stakePerPlayer,
        uint256 bondPerPlayer,
        uint256 fundDuration,
        uint256 settleDuration,
        uint256 challengeWindow
    ) internal view returns (bytes32) {
        bytes32 playersHash = keccak256(abi.encode(players));
        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_GAME_TYPEHASH,
                gameId,
                playersHash,
                stakePerPlayer,
                bondPerPlayer,
                fundDuration,
                settleDuration,
                challengeWindow
            )
        );
        return _hashTypedDataV4(structHash);
    }
}
