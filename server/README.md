# Riichi zk Multiplayer Server

This server hosts open matchmaking and a simplified, playable Riichi round
with server-side proving hooks. It is designed to coordinate an on-chain
settlement, but the gameplay itself runs off-chain.

## Quick start
1. `cd server`
2. `npm install`
3. `npm run dev`

## Environment
- `PORT`: HTTP/WS port (default: 8787)
- `TURN_SECONDS`: turn timer in seconds (default: 45)
- `FAIRNESS_MODE`: `commit-reveal` or `mental-poker` (default: `commit-reveal`)
- `ALLOW_STUB_CRYPTO`: `true` to allow mental‑poker stubs (default: `true`)
- `DATA_DIR`: override the persistence directory (default: `server/data`)
- `DATABASE_URL`: Postgres connection string (enables DB persistence)
- `PGSSL`: set to `false` to disable SSL for Postgres (default: enabled)

### On-chain settlement (optional)
- `RPC_URL`: Base RPC URL
- `CONTRACT_ADDRESS`: deployed settlement contract
- `CHAIN_ID`: Base chain id (8453)
- `ENGINE_VERSION_HASH`: circuit version hash
- `SETTLER_KEY`: private key for the settlement account
- `AUTO_SETTLE`: `true` to auto-submit a proof + settle on game end

## Notes
- `mental-poker` mode uses the Ziffle WASM client for verifiable shuffles
  and reveal tokens (N‑of‑N). The server relays messages and enforces turn order.
- The simplified engine ignores calls (chi/pon/kan) and accepts any complete
  hand as a win. This keeps gameplay fast for the contest while still letting
  you generate a valid proof for the invariant circuit.

## Persistence
- If `DATABASE_URL` is set, room state is stored in Postgres (`rooms` table).
- If not set, room state falls back to a JSON snapshot at `server/data/rooms.json`.
- On restart, `commit-reveal` games resume with deck/hands/discards restored.
- `mental-poker` games reset to `READY` after restart because private keys live
  on the clients; players must ready up again to start a new shuffle.
- To wipe state, delete `server/data/rooms.json` (or drop the `rooms` table).
