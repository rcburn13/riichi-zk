#!/usr/bin/env bash
set -euo pipefail

# Simple Foundry deployment stub (Anvil/local by default)
# Usage:
#   RPC_URL=<rpc> PRIVATE_KEY=<pk> VERIFIER=<addr> ENGINE_HASH=<uint256> ./deploy.sh

: "${RPC_URL:=http://127.0.0.1:8545}"
: "${PRIVATE_KEY:?Set PRIVATE_KEY}"
: "${VERIFIER:?Set VERIFIER (Groth16 verifier address)}"
: "${ENGINE_HASH:?Set ENGINE_HASH (uint256 engine version hash)}"

export FOUNDRY_OFFLINE=true

forge create \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  /Applications/riichi-zk/contracts/RiichiSettlementV1_1.sol:RiichiSettlementV1_1 \
  --constructor-args "$VERIFIER" "$ENGINE_HASH"
