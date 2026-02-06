# Riichi zk Settlement (v1.1)

- Peer-to-peer Mahjong settlement
- zk-proof verified outcomes
- Liveness + bonds + slashing
- 0.05% house fee
- Engine-output hash binding

This folder is a complete protocol snapshot.

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
