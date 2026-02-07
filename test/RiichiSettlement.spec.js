const { expect } = require("chai");
const { ethers } = require("hardhat");

const CREATE_GAME_TYPES = {
  CreateGame: [
    { name: "gameId", type: "bytes32" },
    { name: "playersHash", type: "bytes32" },
    { name: "stakePerPlayer", type: "uint256" },
    { name: "bondPerPlayer", type: "uint256" },
    { name: "fundDuration", type: "uint256" },
    { name: "settleDuration", type: "uint256" },
    { name: "challengeWindow", type: "uint256" },
  ],
};

async function signCreateGame({
  signer,
  verifyingContract,
  chainId,
  gameId,
  players,
  stakePerPlayer,
  bondPerPlayer,
  fundDuration,
  settleDuration,
  challengeWindow,
}) {
  const playersHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [players])
  );
  const domain = {
    name: "RiichiSettlementV1_1",
    version: "1",
    chainId,
    verifyingContract,
  };
  const value = {
    gameId,
    playersHash,
    stakePerPlayer,
    bondPerPlayer,
    fundDuration,
    settleDuration,
    challengeWindow,
  };
  return signer.signTypedData(domain, CREATE_GAME_TYPES, value);
}

async function deploy() {
  const [deployer, ...rest] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockVerifier");
  const mock = await Mock.deploy();
  const Settlement = await ethers.getContractFactory("RiichiSettlementV1_1");
  const settlement = await Settlement.deploy(mock.target, 123n);
  return { deployer, rest, settlement };
}

describe("RiichiSettlementV1_1", function () {
  it("rejects duplicate players", async function () {
    const { rest, settlement } = await deploy();
    const [a, b] = rest;
    const players = [a.address, b.address, a.address];
    const gameId = ethers.id("game-dup");
    const stakePerPlayer = 100n;
    const bondPerPlayer = 10n;
    const fundDuration = 100n;
    const settleDuration = 1000n;
    const challengeWindow = 50n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const sigs = [
      await signCreateGame({
        signer: a,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
      await signCreateGame({
        signer: b,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
      await signCreateGame({
        signer: a,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
    ];

    await expect(
      settlement.createGame(
        gameId,
        players,
        sigs,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow
      )
    ).to.be.revertedWith("dup");
  });

  it("rejects join/fund after fundDeadline", async function () {
    const { rest, settlement } = await deploy();
    const [a, b] = rest;
    const players = [a.address, b.address];
    const gameId = ethers.id("game-late");
    const stakePerPlayer = 100n;
    const bondPerPlayer = 10n;
    const fundDuration = 10n;
    const settleDuration = 1000n;
    const challengeWindow = 50n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const sigs = [
      await signCreateGame({
        signer: a,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
      await signCreateGame({
        signer: b,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
    ];

    await settlement.createGame(
      gameId,
      players,
      sigs,
      stakePerPlayer,
      bondPerPlayer,
      fundDuration,
      settleDuration,
      challengeWindow
    );

    await settlement.connect(a).join(gameId);

    await ethers.provider.send("evm_increaseTime", [11]);
    await ethers.provider.send("evm_mine", []);

    await expect(settlement.connect(b).join(gameId)).to.be.revertedWith("late");
    await expect(
      settlement.connect(a).fund(gameId, { value: stakePerPlayer + bondPerPlayer })
    ).to.be.revertedWith("late");
  });

  it("rejects non-player signatures", async function () {
    const { rest, settlement } = await deploy();
    const [a, b, c] = rest;
    const players = [a.address, b.address];
    const gameId = ethers.id("game-sig");
    const stakePerPlayer = 100n;
    const bondPerPlayer = 10n;
    const fundDuration = 100n;
    const settleDuration = 1000n;
    const challengeWindow = 50n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const sigs = [
      await signCreateGame({
        signer: a,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
      await signCreateGame({
        signer: c,
        verifyingContract: settlement.target,
        chainId,
        gameId,
        players,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow,
      }),
    ];

    await expect(
      settlement.createGame(
        gameId,
        players,
        sigs,
        stakePerPlayer,
        bondPerPlayer,
        fundDuration,
        settleDuration,
        challengeWindow
      )
    ).to.be.revertedWith("sig");
  });
});
