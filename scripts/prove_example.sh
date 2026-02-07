#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/circuits/build"
CIRCOM="${CIRCOM:-circom}"
SNARKJS="${SNARKJS:-$ROOT/node_modules/.bin/snarkjs}"

if [[ ! -x "$SNARKJS" ]]; then
  echo "snarkjs not found at $SNARKJS. Run: npm install" >&2
  exit 1
fi

if ! command -v "$CIRCOM" >/dev/null 2>&1; then
  echo "circom not found in PATH. Set CIRCOM=/path/to/circom" >&2
  exit 1
fi

node "$ROOT/scripts/prove_example.mjs"

"$SNARKJS" groth16 fullprove \
  "$BUILD/input.json" \
  "$BUILD/EngineOutputInvariant_main_js/EngineOutputInvariant_main.wasm" \
  "$BUILD/EngineOutputInvariant_main_final.zkey" \
  "$BUILD/proof.json" \
  "$BUILD/public.json"

"$SNARKJS" groth16 verify \
  "$BUILD/verification_key.json" \
  "$BUILD/public.json" \
  "$BUILD/proof.json"

echo "Proof generated: $BUILD/proof.json"
