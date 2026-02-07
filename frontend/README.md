# Riichi zk Frontend

Quick start:

```bash
cd frontend
python3 -m http.server 5173
```

Open `http://localhost:5173` in your browser, connect your wallet, and switch to Base if prompted.

Notes:
- `Create Game` requires signatures from all players. Use the built‑in Sign button to collect your own signature and paste others.
- `Settle` expects `proof.json` and `public.json` from snarkjs. The UI will parse and map `a`, `b`, `c`, and `ps` automatically.
- Durations are preset for simplicity: fund 30m, settle 2h, challenge 30m.
- For multiplayer, start the server in `server/` and set the WebSocket URL in the Matchmaking panel (default is `ws://localhost:8787`).
- Mental‑poker mode loads the Ziffle WASM bundle from `frontend/wasm/ziffle` (see root README for build steps).
