# Riichi zk Settlement (v1.1)

- Peer-to-peer Mahjong settlement
- zk-proof verified outcomes
- Liveness + bonds + slashing
- 0.05% house fee
- Engine-output hash binding

This folder is a complete protocol snapshot.

## Engine Output Hash (Poseidon)

The circuit binds `pubEngineOutputHash` to the witness using Poseidon. Off‑chain must compute the same hash (see `reference/engineHash.ts`).

**Packing (MAX_YAKU = 50)**
- `chunk0 = [win, shanten, yakuCount, hanTotal, fuTotal, waitsCount, yakuHan[0..9]]`
- `chunk1 = yakuHan[10..25]`
- `chunk2 = yakuHan[26..41]`
- `chunk3 = yakuHan[42..49] + 8 zero pads`
- `hash = Poseidon([Poseidon(chunk0), Poseidon(chunk1), Poseidon(chunk2), Poseidon(chunk3)])`

**Off‑chain dependency**
- `reference/engineHash.ts` uses `circomlibjs` to compute the same Poseidon hash as the circuit.
- The returned hash is a field element encoded as a 32‑byte hex string (fit for `uint256`).
- If you change `MAX_YAKU` or the packing order, you must update both the circuit and `engineHash.ts`, then regenerate keys.

## EIP-712 CreateGame Digest (off-chain)

Each player must sign the same typed data for `createGame`. The players array order is **binding** (it is hashed), so all signers must agree on the exact ordering.

**Domain**
- name: `RiichiSettlementV1_1`
- version: `1`
- chainId: the current chain id
- verifyingContract: deployed contract address

**Type**
```
CreateGame(
  bytes32 gameId,
  bytes32 playersHash,
  uint256 stakePerPlayer,
  uint256 bondPerPlayer,
  uint256 fundDuration,
  uint256 settleDuration,
  uint256 challengeWindow
)
```

**playersHash**
```
playersHash = keccak256(abi.encode(players))
```

**JavaScript (ethers v6)**
```js
import { ethers } from "ethers";

const abi = ethers.AbiCoder.defaultAbiCoder();
const playersHash = ethers.keccak256(abi.encode(["address[]"], [players]));

const domain = {
  name: "RiichiSettlementV1_1",
  version: "1",
  chainId,
  verifyingContract
};

const types = {
  CreateGame: [
    { name: "gameId", type: "bytes32" },
    { name: "playersHash", type: "bytes32" },
    { name: "stakePerPlayer", type: "uint256" },
    { name: "bondPerPlayer", type: "uint256" },
    { name: "fundDuration", type: "uint256" },
    { name: "settleDuration", type: "uint256" },
    { name: "challengeWindow", type: "uint256" }
  ]
};

const value = {
  gameId,
  playersHash,
  stakePerPlayer,
  bondPerPlayer,
  fundDuration,
  settleDuration,
  challengeWindow
};

const signature = await wallet.signTypedData(domain, types, value);
```

## Challenges / Disputes

After a game is **settled** (proof verified), there is a `challengeWindow` where anyone can challenge the result by posting a bond:

- **Paid games:** `challengeBond = pot / 2`
- **Free games:** `challengeBond = 0.001 ETH`

While challenged, the game is **Disputed** and cannot be finalized until the arbiter resolves it. The arbiter is the `house` address.

**Resolution options (arbiter only)**
- **Uphold**: finalize the original result. Challenger bond is **paid to house**.
- **Cancel**: refund all players their stake + bond. Challenger bond is **refunded**.
- **Override**: set a new winner and finalize. Challenger bond is **refunded**.

Challenges include a `reasonHash` (arbitrary `bytes32`) for off-chain context.

## Threat Model (Hackathon)

This protocol assumes the zk verifier and circuit are correct and that the `house` (arbiter) is honest. The dispute system is a safety valve, but it is **not** fully trustless because the arbiter can uphold, cancel, or override results. Off‑chain engine outputs are trusted only via zk proofs; if the proving system or verifier is compromised, funds can be misallocated. Always validate verifier keys and circuit hashes before deployment.

## Security Checklist (Hackathon)

- Contract compiled with Solidity `0.8.20`+ (checked).
- Reentrancy protection on all fund-moving functions (`withdraw`, finalizers, challenge/resolve).
- Pull-payments only; no direct transfers to players in state changes.
- Player list validated: non-zero, unique, and signature-gated via EIP-712.
- Funding/settlement deadlines enforced.
- Dust handling defined (to house).
- Challenge hook enabled with bounded window and explicit outcomes.
- Free games must have `stake=0` and `bond=0`; paid games must have `bond>0`.
- ZK verifier address and engine version hash are immutable.
- Fuzz + simulation tests passing (`forge test`).

**Operational reminders**
- Verify the zk circuit/verifier pair before deployment.
- Ensure off-chain signing uses the exact player ordering.

## Deployment Checklist

- Verify chain ID (used in EIP-712 signatures) matches the target network.
- Deploy the Groth16 verifier contract and record its address.
- Compute and verify the `ENGINE_VERSION_HASH` for the engine/circuit version.
- Deploy `RiichiSettlementV1_1` with:
  - `verifier = <Groth16Verifier address>`
  - `engineVersionHash = <ENGINE_VERSION_HASH>`
- Confirm the `house` address (deployer) is correct and secured.
- If using an AI agent as `house`, ensure key management and rate limits are set.
- Smoke test on a testnet:
  - Create game, join/fund, settle, finalize.
  - Challenge and resolve (uphold/cancel/override).
- Freeze the final contract address in any client or backend configs.

## Multiplayer Server (Simplified Riichi)

- `server/` hosts open matchmaking (4 seats), 45‑second turns, and a simplified Riichi loop.
- Simplified rules: no calls (chi/pon/kan), tsumo‑only wins, standard hand + seven‑pairs accepted.
- Fairness mode: `commit-reveal` (working default) uses per‑player seed commits + reveals to shuffle the deck deterministically.
- Fairness mode: `mental-poker` uses a WASM‑integrated Ziffle shuffle protocol (verifiable shuffle + reveal tokens).
  - **N‑of‑N reveal**: all players must provide reveal tokens to decrypt a card.
  - If a player drops, the game can time out; funds can be recovered on‑chain via `Resolve Timeout` + `Withdraw`.
- Server‑side proofs are optional; set `AUTO_SETTLE=true` and provide RPC + key config to submit proofs on game end.

### Mental‑Poker WASM Build

```
cd wasm/ziffle-wasm
wasm-pack build --target web --release
```

Copy the output into the frontend (already scaffolded):

```
cp -R wasm/ziffle-wasm/pkg frontend/wasm/ziffle
```

## Agent-Friendly API Snippets

Below are minimal `ethers` (v6) examples to help agents plug in quickly. These assume a deployed `RiichiSettlementV1_1` address and a connected signer.

### 1) Create Game (EIP-712 signatures)
```js
import { ethers } from "ethers";

const contract = new ethers.Contract(address, abi, signer);

// Players must agree on order
const players = [playerA, playerB, playerC];

const playersHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [players])
);

const domain = {
  name: "RiichiSettlementV1_1",
  version: "1",
  chainId,
  verifyingContract: address
};

const types = {
  CreateGame: [
    { name: "gameId", type: "bytes32" },
    { name: "playersHash", type: "bytes32" },
    { name: "stakePerPlayer", type: "uint256" },
    { name: "bondPerPlayer", type: "uint256" },
    { name: "fundDuration", type: "uint256" },
    { name: "settleDuration", type: "uint256" },
    { name: "challengeWindow", type: "uint256" }
  ]
};

const value = {
  gameId,
  playersHash,
  stakePerPlayer,
  bondPerPlayer,
  fundDuration,
  settleDuration,
  challengeWindow
};

// Each player signs the same typed data
const sigs = await Promise.all(players.map(p => p.signTypedData(domain, types, value)));

await contract.createGame(
  gameId,
  players,
  sigs,
  stakePerPlayer,
  bondPerPlayer,
  fundDuration,
  settleDuration,
  challengeWindow
);
```

### 2) Join + Fund
```js
await contract.join(gameId);

const value = stakePerPlayer + bondPerPlayer;
await contract.fund(gameId, { value });
```

### 3) Settle (submit proof)
```js
// a, b, c are Groth16 proof elements; ps are public signals
await contract.settle(gameId, a, b, c, ps);
```

**Example (wiring `pubEngineOutputHash`)**
```js
import { hashEngineOutput } from "./reference/engineHash";

const engineOutput = {
  win: 1,
  shanten: 9,
  yakuCount: 1,
  yakuHan: [1], // pad to MAX_YAKU off-chain
  hanTotal: 1,
  fuTotal: 30,
  waitsCount: 0,
};

const engineOutputHash = await hashEngineOutput(engineOutput);
const ps = [
  ENGINE_VERSION_HASH,
  gameId,
  engineOutputHash,
  BigInt(winner),
  1,
];

await contract.settle(gameId, a, b, c, ps);
```

### 4) Finalize
```js
await contract.finalizeSettlement(gameId);
// or, if settleDeadline passed:
await contract.finalizeExpired(gameId);
```

### 5) Challenge + Resolve (arbiter only)
```js
const bond = await contract.challengeBond(gameId);
await contract.challenge(gameId, reasonHash, { value: bond });

// arbiter (house) resolves:
await contract.resolveChallengeUphold(gameId);
// or:
await contract.resolveChallengeCancel(gameId);
// or:
await contract.resolveChallengeOverride(gameId, newWinner);
```

### 6) Withdraw Winnings
```js
await contract.withdraw();
```

### 7) Agent Bot Loop (minimal example)
```js
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(address, abi, wallet);

// Minimal loop: watch for Open games, join/fund, then wait for settle.
async function agentLoop() {
  // Example: watch for GameCreated events and join if you're a listed player
  contract.on("GameCreated", async (gameId, playersHash) => {
    // You must know the full `players` array off-chain to compare with hash
    // If you're in the game, join + fund
    try {
      await contract.join(gameId);
      const stakePerPlayer = /* from game config */;
      const bondPerPlayer = /* from game config */;
      await contract.fund(gameId, { value: stakePerPlayer + bondPerPlayer });
    } catch (e) {
      // ignore if already joined/funded or not eligible
    }
  });

  // Example: auto-withdraw when claimable > 0
  setInterval(async () => {
    const claimable = await contract.claimable(wallet.address);
    if (claimable > 0n) {
      await contract.withdraw();
    }
  }, 30_000);
}

agentLoop().catch(console.error);
```

## Agent Playbook (Quick Start)

1. **Watch for new games**  
   Subscribe to `GameCreated` events and match on the `players` list you expect.

2. **Join + Fund**  
   Call `join(gameId)` then `fund(gameId, { value: stake + bond })` before `fundDeadline`.

3. **Monitor settlement**  
   Listen for `GameSettled` and/or track `getGameStatus(gameId)` for `Settled`.

4. **Handle disputes**  
   If you detect an invalid outcome, call `challenge(gameId, reasonHash)` within the `challengeWindow`.

5. **Finalize + Withdraw**  
   After settlement (or expiry), finalize and call `withdraw()` to claim funds.

**Free-play mode:** set `stakePerPlayer=0` and `bondPerPlayer=0`. Challenges are still possible with a fixed `0.001 ETH` bond to prevent spam.

## Event Index (Agent Subscriptions)

- `GameCreated`: new game created; includes `playersHash` and deadlines  
- `PlayerJoined`: a player has joined  
- `PlayerFunded`: a player has funded  
- `GameActivated`: all players funded; game is live  
- `GameSettled`: zk proof verified, winner determined  
- `GameChallenged`: dispute opened  
- `ChallengeResolved`: dispute resolved (uphold/cancel/override)  
- `GameFinalized`: payouts assigned  
- `GameExpiredFinalized`: liveness expiry payout assigned  
- `GameCanceled`: game canceled (unfunded or dispute cancel)  
- `Withdrawal`: player has withdrawn funds
