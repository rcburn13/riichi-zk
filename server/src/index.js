import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { Pool } from "pg";
import {
  buildDeck,
  shuffleDeck,
  dealInitial,
  drawTile,
  canWin,
  formatHand,
  combineSeeds,
  seedCommit,
} from "./simpleEngine.js";
import { nameToType, typeToName } from "./tiles.js";
import { hashEngineOutput } from "./engineHash.js";
import { generateProof } from "./prover.js";

const PORT = Number(process.env.PORT || 8787);
const TURN_SECONDS = Number(process.env.TURN_SECONDS || 45);
const FAIRNESS_MODE = process.env.FAIRNESS_MODE || "commit-reveal";
const IS_MENTAL_POKER = FAIRNESS_MODE === "mental-poker";
const ALLOW_STUB_CRYPTO = process.env.ALLOW_STUB_CRYPTO !== "false";
const AUTO_SETTLE = process.env.AUTO_SETTLE === "true";

const RPC_URL = process.env.RPC_URL || "";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const ENGINE_VERSION_HASH = process.env.ENGINE_VERSION_HASH || "";
const SETTLER_KEY = process.env.SETTLER_KEY || "";
const CHAIN_ID = process.env.CHAIN_ID ? BigInt(process.env.CHAIN_ID) : null;
const DATABASE_URL = process.env.DATABASE_URL || "";
const PGSSL = process.env.PGSSL;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const ROOMS_PATH = path.join(DATA_DIR, "rooms.json");

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const queue = [];
const rooms = new Map();
const clients = new Map();
let saveTimer = null;
let pgPool = null;

function cloneFill(fillValue) {
  if (Array.isArray(fillValue)) return [];
  if (fillValue && typeof fillValue === "object") return { ...fillValue };
  return fillValue;
}

function normalizeArray(value, length, fillValue) {
  const arr = Array.isArray(value) ? value.slice(0, length) : [];
  while (arr.length < length) arr.push(cloneFill(fillValue));
  return arr;
}

function serializePendingReveal(pendingMap) {
  return Array.from(pendingMap.entries()).map(([drawId, entry]) => ({
    drawId,
    seat: entry.seat,
    cardIndex: entry.cardIndex,
    tokens: Array.from(entry.tokens.values()),
  }));
}

function hydratePendingReveal(items, playerCount) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  items.forEach((entry) => {
    if (!entry?.drawId) return;
    const tokens = new Map();
    const list = Array.isArray(entry.tokens) ? entry.tokens : [];
    list.forEach((token) => {
      if (token && Number.isInteger(token.seat) && token.seat >= 0 && token.seat < playerCount) {
        tokens.set(token.seat, token);
      }
    });
    map.set(entry.drawId, { seat: entry.seat, cardIndex: entry.cardIndex, tokens });
  });
  return map;
}

function serializeRoom(room) {
  return {
    id: room.id,
    phase: room.phase,
    playerMeta: room.playerMeta,
    gameId: room.gameId,
    deck: room.deck,
    hands: room.hands,
    discards: room.discards,
    turnIndex: room.turnIndex,
    timeouts: room.timeouts,
    ready: room.ready,
    deadlineMs: room.deadlineMs,
    countdownEndsAt: room.countdownEndsAt,
    seeds: {
      commits: room.seeds.commits,
      reveals: room.seeds.reveals,
    },
    mp: {
      keygen: room.mp.keygen,
      shuffleStage: room.mp.shuffleStage,
      shuffleAcks: room.mp.shuffleAcks,
      drawCursor: room.mp.drawCursor,
      pendingReveal: serializePendingReveal(room.mp.pendingReveal),
    },
    log: room.log,
  };
}

function hydrateRoom(data) {
  const playerCount = Array.isArray(data.playerMeta) ? data.playerMeta.length : 0;
  const room = {
    id: data.id,
    players: new Array(playerCount).fill(null),
    playerMeta: Array.isArray(data.playerMeta) ? data.playerMeta : [],
    spectators: new Set(),
    phase: data.phase || "READY",
    log: Array.isArray(data.log) ? data.log : [],
    seeds: {
      commits: normalizeArray(data.seeds?.commits, playerCount, null),
      reveals: normalizeArray(data.seeds?.reveals, playerCount, null),
    },
    gameId: data.gameId || null,
    deck: Array.isArray(data.deck) ? data.deck : [],
    hands: Array.isArray(data.hands) ? data.hands : [],
    discards: normalizeArray(data.discards, playerCount, []).map((row) => Array.isArray(row) ? row : []),
    turnIndex: Number.isInteger(data.turnIndex) ? data.turnIndex : 0,
    deadlineMs: data.deadlineMs || null,
    turnTimer: null,
    timeouts: normalizeArray(data.timeouts, playerCount, 0),
    ready: normalizeArray(data.ready, playerCount, false),
    countdownTimer: null,
    countdownEndsAt: data.countdownEndsAt || null,
    mp: {
      keygen: normalizeArray(data.mp?.keygen, playerCount, null),
      shuffleStage: Number.isInteger(data.mp?.shuffleStage) ? data.mp.shuffleStage : 0,
      shuffleAcks: normalizeArray(data.mp?.shuffleAcks, playerCount, false),
      drawCursor: Number.isInteger(data.mp?.drawCursor) ? data.mp.drawCursor : 0,
      pendingReveal: hydratePendingReveal(data.mp?.pendingReveal, playerCount),
    },
  };

  if (IS_MENTAL_POKER && room.phase !== "OVER") {
    room.phase = "READY";
    room.turnIndex = 0;
    room.ready = room.ready.map(() => false);
    room.seeds = {
      commits: normalizeArray([], playerCount, null),
      reveals: normalizeArray([], playerCount, null),
    };
    room.deck = [];
    room.hands = [];
    room.discards = normalizeArray([], playerCount, []);
    room.deadlineMs = null;
    room.countdownEndsAt = null;
    room.mp = {
      keygen: normalizeArray([], playerCount, null),
      shuffleStage: 0,
      shuffleAcks: normalizeArray([], playerCount, false),
      drawCursor: 0,
      pendingReveal: new Map(),
    };
    room.log.push(`[${new Date().toISOString()}] Restart detected; mental-poker match reset to READY.`);
  }

  return room;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveRooms();
  }, 200);
}

async function saveRoomsFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      rooms: Array.from(rooms.values()).map(serializeRoom),
    };
    const tmp = `${ROOMS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, ROOMS_PATH);
  } catch (err) {
    console.error("Failed to persist rooms (file):", err);
  }
}

async function saveRooms() {
  if (!pgPool) {
    return saveRoomsFile();
  }
  let client;
  const now = Date.now();
  try {
    client = await pgPool.connect();
    await client.query("BEGIN");
    for (const room of rooms.values()) {
      const data = serializeRoom(room);
      await client.query(
        "INSERT INTO rooms (id, data, updated_at) VALUES ($1, $2, $3) " +
          "ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
        [room.id, data, now]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("Failed to persist rooms (postgres):", err);
  } finally {
    if (client) client.release();
  }
}

function resumeRoom(room) {
  if (room.phase === "COUNTDOWN" && room.countdownEndsAt) {
    const remaining = room.countdownEndsAt - Date.now();
    if (remaining <= 0) {
      room.phase = IS_MENTAL_POKER ? "MP_KEYGEN" : "SEED_COMMIT";
      if (IS_MENTAL_POKER) {
        broadcastPlayers(room, { type: "MP_KEYGEN_REQUEST", payload: { context: room.id } });
      } else {
        broadcastPlayers(room, { type: "SEED_COMMIT_REQUEST", payload: { mode: FAIRNESS_MODE } });
      }
      scheduleSave();
      return;
    }
    room.countdownTimer = setTimeout(() => {
      if (room.phase !== "COUNTDOWN") return;
      room.phase = IS_MENTAL_POKER ? "MP_KEYGEN" : "SEED_COMMIT";
      if (IS_MENTAL_POKER) {
        broadcastPlayers(room, { type: "MP_KEYGEN_REQUEST", payload: { context: room.id } });
      } else {
        broadcastPlayers(room, { type: "SEED_COMMIT_REQUEST", payload: { mode: FAIRNESS_MODE } });
      }
      scheduleSave();
    }, remaining);
  }

  if (room.phase === "PLAY" && room.deadlineMs) {
    const remaining = room.deadlineMs - Date.now();
    if (remaining <= 0) {
      setTimeout(() => handleTimeout(room), 0);
    } else {
      room.turnTimer = setTimeout(() => handleTimeout(room), remaining);
    }
  }
}

async function initDb() {
  if (!DATABASE_URL) return;
  try {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: PGSSL === "false" ? false : { rejectUnauthorized: false },
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
  } catch (err) {
    console.error("Failed to initialize Postgres persistence:", err);
    pgPool = null;
  }
}

async function loadRoomsFile() {
  try {
    if (!fs.existsSync(ROOMS_PATH)) return;
    const raw = fs.readFileSync(ROOMS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.rooms)) return;
    parsed.rooms.forEach((data) => {
      if (!data?.id) return;
      const room = hydrateRoom(data);
      rooms.set(room.id, room);
      resumeRoom(room);
    });
    console.log(`Loaded ${rooms.size} rooms from file persistence.`);
  } catch (err) {
    console.error("Failed to load file persistence:", err);
  }
}

async function loadRooms() {
  if (!pgPool) return loadRoomsFile();
  try {
    const result = await pgPool.query("SELECT data FROM rooms");
    result.rows.forEach((row) => {
      if (!row?.data) return;
      const room = hydrateRoom(row.data);
      rooms.set(room.id, room);
      resumeRoom(room);
    });
    console.log(`Loaded ${rooms.size} rooms from Postgres persistence.`);
  } catch (err) {
    console.error("Failed to load Postgres persistence:", err);
  }
}

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastPlayers(room, msg) {
  for (const clientId of room.players) {
    const client = clients.get(clientId);
    if (client) send(client.ws, msg);
  }
}

function broadcastRoom(room, msg) {
  broadcastPlayers(room, msg);
  if (!room.spectators) return;
  for (const clientId of room.spectators) {
    const client = clients.get(clientId);
    if (client) send(client.ws, msg);
  }
}

function makeRoom(playerIds) {
  return {
    id: nanoid(8),
    players: playerIds,
    playerMeta: playerIds.map(() => ({ address: null, name: null })),
    spectators: new Set(),
    phase: "READY",
    log: [],
    seeds: {
      commits: playerIds.map(() => null),
      reveals: playerIds.map(() => null),
    },
    gameId: null,
    deck: [],
    hands: [],
    discards: playerIds.map(() => []),
    turnIndex: 0,
    deadlineMs: null,
    turnTimer: null,
    timeouts: playerIds.map(() => 0),
    ready: playerIds.map(() => false),
    countdownTimer: null,
    countdownEndsAt: null,
    mp: {
      keygen: playerIds.map(() => null),
      shuffleStage: 0,
      shuffleAcks: playerIds.map(() => false),
      drawCursor: 0,
      pendingReveal: new Map(),
    },
  };
}

function buildRejoinMessage(roomId, address, nonce) {
  return [
    "Riichi zk Rejoin",
    `Room: ${roomId}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

function logEvent(room, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  room.log.push(line);
  if (room.log.length > 200) {
    room.log.splice(0, room.log.length - 200);
  }
  scheduleSave();
}

function playerLabels(room) {
  return room.playerMeta.map((meta, idx) => meta.address || meta.name || `Seat ${idx + 1}`);
}

function sendRoomAssigned(client, room, seat, rejoined = false) {
  send(client.ws, {
    type: "ROOM_ASSIGNED",
    payload: {
      roomId: room.id,
      seat,
      players: playerLabels(room),
      rejoined,
    },
  });
}

function tryMatchmake() {
  while (queue.length >= 4) {
    const group = queue.splice(0, 4);
    const room = makeRoom(group.map((c) => c.id));
    rooms.set(room.id, room);
    group.forEach((client, idx) => {
      client.roomId = room.id;
      client.seat = idx;
      room.playerMeta[idx] = { address: client.address || null, name: client.name || null };
    });
    logEvent(room, "Room created.");
    group.forEach((client, idx) => {
      sendRoomAssigned(client, room, idx, false);
    });
    broadcastRoom(room, {
      type: "READY_STATE",
      payload: { ready: room.ready.slice() },
    });
    scheduleSave();
  }
}

function requireRoom(client) {
  if (!client.roomId) throw new Error("Not in a room");
  const room = rooms.get(client.roomId);
  if (!room) throw new Error("Room not found");
  return room;
}

function startGame(room, seed) {
  room.phase = "PLAY";
  room.turnIndex = 0;
  room.timeouts = room.players.map(() => 0);
  logEvent(room, "Game started.");

  if (IS_MENTAL_POKER) {
    room.players.forEach((clientId, idx) => {
      const client = clients.get(clientId);
      if (!client) return;
      send(client.ws, {
        type: "GAME_START",
        payload: {
          roomId: room.id,
          seat: idx,
          turnSeat: room.turnIndex,
          wallCount: 136 - (room.mp.drawCursor || 0),
          discards: room.discards.map((d) => d.map(typeToName)),
          hand: [],
        },
      });
    });
    room.spectators.forEach((clientId) => {
      const client = clients.get(clientId);
      if (!client) return;
      send(client.ws, {
        type: "GAME_START",
        payload: {
          roomId: room.id,
          seat: null,
          turnSeat: room.turnIndex,
          wallCount: 136 - (room.mp.drawCursor || 0),
          discards: room.discards.map((d) => d.map(typeToName)),
          hand: null,
        },
      });
    });
    beginTurn(room);
    return;
  }

  room.deck = shuffleDeck(buildDeck(), seed);
  room.hands = dealInitial(room.deck, room.players);

  room.players.forEach((clientId, idx) => {
    const client = clients.get(clientId);
    if (!client) return;
    send(client.ws, {
      type: "GAME_START",
      payload: {
        roomId: room.id,
        seat: idx,
        turnSeat: room.turnIndex,
        wallCount: room.deck.length,
        discards: room.discards.map((d) => d.map(typeToName)),
        hand: formatHand(room.hands[idx]),
      },
    });
  });
  room.spectators.forEach((clientId) => {
    const client = clients.get(clientId);
    if (!client) return;
    send(client.ws, {
      type: "GAME_START",
      payload: {
        roomId: room.id,
        seat: null,
        turnSeat: room.turnIndex,
        wallCount: room.deck.length,
        discards: room.discards.map((d) => d.map(typeToName)),
        hand: null,
      },
    });
  });

  beginTurn(room);
}

function beginTurn(room) {
  clearTimeout(room.turnTimer);
  if (room.phase !== "PLAY") return;

  const seat = room.turnIndex;
  const deadlineMs = Date.now() + TURN_SECONDS * 1000;
  room.deadlineMs = deadlineMs;

  room.turnTimer = setTimeout(() => handleTimeout(room), TURN_SECONDS * 1000);

  if (IS_MENTAL_POKER) {
    if (room.mp.drawCursor >= 136) {
      return gameOver(room, { reason: "wall_empty" });
    }
    const drawId = `${room.id}-${room.mp.drawCursor}`;
    const cardIndex = room.mp.drawCursor;
    room.mp.drawCursor += 1;
    room.mp.pendingReveal.set(drawId, { seat, cardIndex, tokens: new Map() });

    broadcastPlayers(room, {
      type: "MP_REVEAL_REQUEST",
      payload: {
        drawId,
        cardIndex,
        seat,
        deadlineMs,
      },
    });

    room.players.forEach((clientId, idx) => {
      const client = clients.get(clientId);
      if (!client) return;
      send(client.ws, {
        type: "TURN",
        payload: {
          seat,
          isYou: idx === seat,
          deadlineMs,
          canWin: false,
          drawn: idx === seat ? "?" : null,
          hand: null,
        },
      });
    });
    room.spectators.forEach((clientId) => {
      const client = clients.get(clientId);
      if (!client) return;
      send(client.ws, {
        type: "TURN",
        payload: {
          seat,
          isYou: false,
          deadlineMs,
          canWin: false,
          drawn: null,
          hand: null,
        },
      });
    });
    scheduleSave();
    return;
  }

  if (room.deck.length === 0) {
    return gameOver(room, { reason: "wall_empty" });
  }

  const drawn = drawTile(room.deck);
  room.hands[seat].push(drawn);

  const handNames = formatHand(room.hands[seat]);
  const canDeclare = canWin(room.hands[seat]);

  room.players.forEach((clientId, idx) => {
    const client = clients.get(clientId);
    if (!client) return;
    send(client.ws, {
      type: "TURN",
      payload: {
        seat,
        isYou: idx === seat,
        deadlineMs,
        canWin: idx === seat ? canDeclare : false,
        drawn: idx === seat ? typeToName(drawn) : null,
        hand: idx === seat ? handNames : null,
      },
    });
  });
  room.spectators.forEach((clientId) => {
    const client = clients.get(clientId);
    if (!client) return;
    send(client.ws, {
      type: "TURN",
      payload: {
        seat,
        isYou: false,
        deadlineMs,
        canWin: false,
        drawn: null,
        hand: null,
      },
    });
  });
  scheduleSave();
}

function handleTimeout(room) {
  if (room.phase !== "PLAY") return;
  const seat = room.turnIndex;
  room.timeouts[seat] += 1;

  if (IS_MENTAL_POKER) {
    if (room.timeouts[seat] >= 2) {
      const winnerSeat = room.players.findIndex((_p, idx) => idx !== seat);
      return gameOver(room, { reason: "timeout_forfeit", winnerSeat });
    }
    logEvent(room, `Seat ${seat + 1} timeout warning.`);
    broadcastRoom(room, {
      type: "TIMEOUT_WARNING",
      payload: { seat, strikes: room.timeouts[seat] },
    });
    room.turnTimer = setTimeout(() => handleTimeout(room), TURN_SECONDS * 1000);
    return;
  }

  if (room.timeouts[seat] >= 2) {
    const winnerSeat = room.players.findIndex((_p, idx) => idx !== seat);
    return gameOver(room, { reason: "timeout_forfeit", winnerSeat });
  }

  const hand = room.hands[seat];
  const idx = Math.floor(Math.random() * hand.length);
  const tile = hand.splice(idx, 1)[0];
  room.discards[seat].push(tile);
  logEvent(room, `Seat ${seat + 1} auto-discarded ${typeToName(tile)}.`);
  broadcastRoom(room, {
    type: "STATE",
    payload: {
      discards: room.discards.map((d) => d.map(typeToName)),
      turnSeat: seat,
      action: "AUTO_DISCARD",
      seat,
      tile: typeToName(tile),
      wallCount: room.deck.length,
    },
  });

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  beginTurn(room);
}

async function gameOver(room, { reason, winnerSeat = null }) {
  room.phase = "OVER";
  clearTimeout(room.turnTimer);
  room.deadlineMs = null;
  logEvent(room, `Game over (${reason}).`);

  let winner = null;
  let engineOutputHash = null;
  if (winnerSeat !== null && winnerSeat >= 0) {
    const winnerClient = clients.get(room.players[winnerSeat]);
    winner = winnerClient?.address || null;
    const engineOutput = {
      win: 1,
      shanten: 9,
      yakuCount: 1,
      yakuHan: [1],
      hanTotal: 1,
      fuTotal: 30,
      waitsCount: 0,
    };
    engineOutputHash = await hashEngineOutput(engineOutput);

    if (AUTO_SETTLE) {
      try {
        await settleOnChain(room, winner, engineOutput, engineOutputHash);
      } catch (err) {
        console.error("Auto-settle failed:", err);
      }
    }
  }

  broadcastRoom(room, {
    type: "GAME_OVER",
    payload: {
      roomId: room.id,
      reason,
      winnerSeat,
      winner,
      engineOutputHash,
    },
  });
}

async function settleOnChain(room, winner, engineOutput, engineOutputHash) {
  if (!RPC_URL || !CONTRACT_ADDRESS || !ENGINE_VERSION_HASH || !SETTLER_KEY || !CHAIN_ID) {
    throw new Error("Missing on-chain config for auto-settle");
  }
  if (!room.gameId) throw new Error("Room has no bound gameId");

  const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID));
  const wallet = new ethers.Wallet(SETTLER_KEY, provider);
  const abi = [
    "function settle(bytes32 gameId,uint256[2] a,uint256[2][2] b,uint256[2] c,uint256[5] ps) external",
  ];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

  const input = {
    pubEngineVersionHash: ENGINE_VERSION_HASH,
    pubGameId: room.gameId,
    pubEngineOutputHash: engineOutputHash,
    pubWinner: BigInt(winner),
    pubWin: 1,
    win: engineOutput.win,
    shanten: engineOutput.shanten,
    yakuCount: engineOutput.yakuCount,
    yakuHan: engineOutput.yakuHan,
    hanTotal: engineOutput.hanTotal,
    fuTotal: engineOutput.fuTotal,
    waitsCount: engineOutput.waitsCount,
  };

  const { proof, publicSignals } = await generateProof(input);
  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];
  const ps = publicSignals.map((p) => BigInt(p));

  const tx = await contract.settle(room.gameId, a, b, c, ps);
  await tx.wait();
}

function handleSeedCommit(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "SEED_COMMIT") throw new Error("Not in commit phase");
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  room.seeds.commits[client.seat] = payload.commit;
  if (room.seeds.commits.every(Boolean)) {
    room.phase = "SEED_REVEAL";
    broadcastPlayers(room, { type: "SEED_REVEAL_REQUEST" });
  }
  scheduleSave();
}

function handleSeedReveal(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "SEED_REVEAL") throw new Error("Not in reveal phase");
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  const commit = room.seeds.commits[client.seat];
  if (!commit) throw new Error("Missing commit");
  const expected = seedCommit(payload.seed);
  if (expected !== commit) throw new Error("Commit mismatch");
  room.seeds.reveals[client.seat] = payload.seed;
  if (room.seeds.reveals.every(Boolean)) {
    const seeds = room.seeds.reveals.slice();
    const combined = combineSeeds(seeds);
    startGame(room, combined);
  }
  scheduleSave();
}

function handleReadySet(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "READY" && room.phase !== "COUNTDOWN") {
    throw new Error("Not in ready phase");
  }
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  room.ready[client.seat] = !!payload?.ready;
  const readyList = room.ready.slice();
  broadcastRoom(room, { type: "READY_STATE", payload: { ready: readyList } });

  const allReady = readyList.every(Boolean);
  if (allReady && room.phase !== "COUNTDOWN") {
    room.phase = "COUNTDOWN";
    logEvent(room, "All players ready. Countdown started.");
    broadcastRoom(room, { type: "COUNTDOWN", payload: { seconds: 3 } });
    room.countdownEndsAt = Date.now() + 3000;
    room.countdownTimer = setTimeout(() => {
      if (room.phase !== "COUNTDOWN") return;
      room.phase = IS_MENTAL_POKER ? "MP_KEYGEN" : "SEED_COMMIT";
      if (IS_MENTAL_POKER) {
        broadcastPlayers(room, { type: "MP_KEYGEN_REQUEST", payload: { context: room.id } });
      } else {
        broadcastPlayers(room, { type: "SEED_COMMIT_REQUEST", payload: { mode: FAIRNESS_MODE } });
      }
      room.countdownEndsAt = null;
      scheduleSave();
    }, 3000);
  }

  if (!allReady && room.phase === "COUNTDOWN") {
    room.phase = "READY";
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    logEvent(room, "Countdown canceled.");
    broadcastRoom(room, { type: "COUNTDOWN_CANCEL" });
  }
  scheduleSave();
}

function handleMpKeygen(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "MP_KEYGEN") {
    throw new Error("Not in keygen phase");
  }
  if (!payload?.pk || !payload?.proof) throw new Error("Missing keygen payload");
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  room.phase = "MP_KEYGEN";
  room.mp.keygen[client.seat] = { pk: payload.pk, proof: payload.proof, seat: client.seat };
  broadcastPlayers(room, {
    type: "MP_KEYGEN_BROADCAST",
    payload: { seat: client.seat, pk: payload.pk, proof: payload.proof },
  });

  if (room.mp.keygen.every(Boolean)) {
    room.phase = "MP_SHUFFLE";
    room.mp.shuffleStage = 0;
    room.mp.shuffleAcks = room.players.map(() => false);
    const shufflerSeat = 0;
    const shufflerId = room.players[shufflerSeat];
    const shuffler = clients.get(shufflerId);
    if (shuffler) {
      send(shuffler.ws, {
        type: "MP_SHUFFLE_REQUEST",
        payload: { seat: shufflerSeat, stage: 0, context: room.id },
      });
    }
  }
  scheduleSave();
}

function handleMpShuffleSubmit(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "MP_SHUFFLE") throw new Error("Not in shuffle phase");
  if (payload?.stage !== room.mp.shuffleStage) throw new Error("Shuffle stage mismatch");
  if (!payload?.deck || !payload?.proof) throw new Error("Missing shuffle payload");
  room.mp.shuffleAcks = room.players.map(() => false);
  broadcastPlayers(room, {
    type: "MP_SHUFFLE_BROADCAST",
    payload: {
      seat: client.seat,
      stage: payload.stage,
      deck: payload.deck,
      proof: payload.proof,
      context: room.id,
    },
  });
  scheduleSave();
}

function handleMpShuffleAck(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "MP_SHUFFLE") throw new Error("Not in shuffle phase");
  if (payload?.stage !== room.mp.shuffleStage) throw new Error("Shuffle stage mismatch");
  if (payload?.ok === false) {
    return gameOver(room, { reason: "shuffle_rejected" });
  }
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  room.mp.shuffleAcks[client.seat] = true;
  if (room.mp.shuffleAcks.every(Boolean)) {
    room.mp.shuffleStage += 1;
    room.mp.shuffleAcks = room.players.map(() => false);
    if (room.mp.shuffleStage < room.players.length) {
      const shufflerSeat = room.mp.shuffleStage;
      const shufflerId = room.players[shufflerSeat];
      const shuffler = clients.get(shufflerId);
      if (shuffler) {
        send(shuffler.ws, {
          type: "MP_SHUFFLE_REQUEST",
          payload: { seat: shufflerSeat, stage: room.mp.shuffleStage, context: room.id },
        });
      }
    } else {
      broadcastPlayers(room, { type: "MP_SHUFFLE_DONE", payload: { roomId: room.id } });
      startGame(room, null);
    }
  }
  scheduleSave();
}

function handleMpRevealToken(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "PLAY") throw new Error("Game not active");
  const drawId = payload?.drawId;
  const token = payload?.token;
  const proof = payload?.proof;
  if (!drawId || !token || !proof) throw new Error("Missing reveal token payload");
  const pending = room.mp.pendingReveal.get(drawId);
  if (!pending) throw new Error("Unknown draw");
  if (client.seat === null || client.seat === undefined) throw new Error("Missing seat");
  pending.tokens.set(client.seat, { seat: client.seat, token, proof });
  if (pending.tokens.size === room.players.length) {
    const tokens = Array.from(pending.tokens.values());
    broadcastPlayers(room, {
      type: "MP_REVEAL_TOKENS",
      payload: {
        drawId,
        cardIndex: pending.cardIndex,
        seat: pending.seat,
        tokens,
      },
    });
    room.mp.pendingReveal.delete(drawId);
  }
  scheduleSave();
}

function handleDiscard(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "PLAY") throw new Error("Game not active");
  if (room.players[room.turnIndex] !== client.id) throw new Error("Not your turn");
  const type = nameToType(payload.tile);
  if (type === null) throw new Error("Invalid tile");
  if (!IS_MENTAL_POKER) {
    const hand = room.hands[client.seat];
    const idx = hand.indexOf(type);
    if (idx === -1) throw new Error("Tile not in hand");
    hand.splice(idx, 1);
  }
  room.discards[client.seat].push(type);

  logEvent(room, `Seat ${client.seat + 1} discarded ${payload.tile}.`);
  broadcastRoom(room, {
    type: "STATE",
    payload: {
      discards: room.discards.map((d) => d.map(typeToName)),
      action: "DISCARD",
      seat: client.seat,
      tile: payload.tile,
      wallCount: room.deck.length,
    },
  });

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  beginTurn(room);
}

function handleDeclareWin(client, payload) {
  const room = requireRoom(client);
  if (room.phase !== "PLAY") throw new Error("Game not active");
  if (room.players[room.turnIndex] !== client.id) throw new Error("Not your turn");
  if (IS_MENTAL_POKER) {
    if (!payload || !Array.isArray(payload.hand)) {
      throw new Error("Provide hand for win validation");
    }
    const hand = payload.hand.map(nameToType);
    if (hand.some((t) => t === null)) throw new Error("Invalid tile in hand");
    if (!canWin(hand)) throw new Error("Hand is not complete");
    logEvent(room, `Seat ${client.seat + 1} declared win.`);
    gameOver(room, { reason: "tsumo", winnerSeat: client.seat });
    return;
  }
  const hand = room.hands[client.seat];
  if (!canWin(hand)) throw new Error("Hand is not complete");
  logEvent(room, `Seat ${client.seat + 1} declared win.`);
  gameOver(room, { reason: "tsumo", winnerSeat: client.seat });
}

function handleBindGame(client, payload) {
  const room = requireRoom(client);
  if (room.gameId && room.gameId !== payload.gameId) {
    throw new Error("Room already bound to a different game");
  }
  room.gameId = payload.gameId;
  logEvent(room, `Room bound to game ${room.gameId}.`);
  broadcastRoom(room, { type: "GAME_BOUND", payload: { gameId: room.gameId } });
}

function sendReplayLog(client, room) {
  send(client.ws, { type: "REPLAY_LOG", payload: { lines: room.log.slice() } });
}

function buildSyncState(room, client) {
  const readyList = room.ready.slice();
  const discards = room.discards.map((d) => d.map(typeToName));
  const seat = client.seat ?? null;
  const inPlay = room.phase === "PLAY";
  const isYou = inPlay && seat !== null && room.turnIndex === seat;
  let hand = null;
  let canWinHand = false;
  let handKnown = false;
  if (!IS_MENTAL_POKER && seat !== null && Array.isArray(room.hands[seat])) {
    hand = formatHand(room.hands[seat]);
    handKnown = true;
    if (inPlay && room.turnIndex === seat) {
      canWinHand = canWin(room.hands[seat]);
    }
  }
  return {
    roomId: room.id,
    phase: room.phase,
    seat,
    players: playerLabels(room),
    ready: readyList,
    turnSeat: room.turnIndex,
    discards,
    wallCount: IS_MENTAL_POKER ? 136 - (room.mp.drawCursor || 0) : room.deck.length,
    deadlineMs: room.deadlineMs,
    countdownEndsAt: room.countdownEndsAt,
    hand,
    handKnown,
    isYou,
    canWin: canWinHand,
    gameId: room.gameId,
  };
}

function sendSyncState(client, room) {
  send(client.ws, { type: "SYNC_STATE", payload: buildSyncState(room, client) });
}

function handleRejoinRequest(client, payload) {
  const roomId = payload?.roomId;
  const address = payload?.address?.toLowerCase();
  if (!roomId) throw new Error("Missing roomId");
  if (!address) throw new Error("Missing address");
  const room = rooms.get(roomId);
  if (!room) throw new Error("Room not found");
  const seat = room.playerMeta.findIndex((meta) => meta.address?.toLowerCase() === address);
  if (seat === -1) throw new Error("No matching seat for address");

  const nonce = crypto.randomBytes(16).toString("hex");
  client.rejoinChallenge = {
    roomId,
    address,
    nonce,
    issuedAt: Date.now(),
  };
  send(client.ws, {
    type: "REJOIN_CHALLENGE",
    payload: {
      roomId,
      address,
      nonce,
      expiresIn: 120,
    },
  });
}

function handleSpectateJoin(client, payload) {
  const roomId = payload?.roomId;
  if (!roomId) throw new Error("Missing roomId");
  const room = rooms.get(roomId);
  if (!room) throw new Error("Room not found");
  if (client.roomId && client.roomId !== roomId) {
    throw new Error("Already in a different room");
  }
  const queueIdx = queue.indexOf(client);
  if (queueIdx >= 0) queue.splice(queueIdx, 1);
  client.roomId = roomId;
  client.seat = null;
  room.spectators.add(client.id);
  send(client.ws, { type: "SPECTATE_JOINED", payload: { roomId } });
  sendReplayLog(client, room);
  sendSyncState(client, room);
}

function handleSyncRequest(client) {
  const room = requireRoom(client);
  sendSyncState(client, room);
}

function handleRejoin(client, payload) {
  const roomId = payload?.roomId;
  if (!roomId) throw new Error("Missing roomId");
  const room = rooms.get(roomId);
  if (!room) throw new Error("Room not found");
  const address = payload?.address?.toLowerCase() || null;
  const signature = payload?.signature || null;
  const name = payload?.name || null;
  if (address) {
    const challenge = client.rejoinChallenge;
    if (!challenge || challenge.roomId !== roomId || challenge.address !== address) {
      throw new Error("Missing rejoin challenge");
    }
    if (Date.now() - challenge.issuedAt > 120_000) {
      client.rejoinChallenge = null;
      throw new Error("Rejoin challenge expired");
    }
    if (!signature) throw new Error("Missing signature");
    const message = buildRejoinMessage(roomId, address, challenge.nonce);
    const recovered = ethers.verifyMessage(message, signature).toLowerCase();
    if (recovered !== address) throw new Error("Invalid rejoin signature");
  }
  let seat = null;
  if (address) {
    seat = room.playerMeta.findIndex((meta) => meta.address?.toLowerCase() === address);
  }
  if (seat === null || seat === -1) {
    if (name) {
      seat = room.playerMeta.findIndex((meta) => meta.name === name);
    }
  }
  if (seat === null || seat === -1) {
    throw new Error("No matching seat for rejoin");
  }
  const oldClientId = room.players[seat];
  if (oldClientId && clients.has(oldClientId) && oldClientId !== client.id) {
    throw new Error("Seat already occupied");
  }
  const queueIdx = queue.indexOf(client);
  if (queueIdx >= 0) queue.splice(queueIdx, 1);
  room.players[seat] = client.id;
  client.roomId = roomId;
  client.seat = seat;
  client.rejoinChallenge = null;
  room.playerMeta[seat] = { address: address || room.playerMeta[seat].address || null, name: name || room.playerMeta[seat].name || null };
  sendRoomAssigned(client, room, seat, true);
  sendReplayLog(client, room);
  sendSyncState(client, room);
  scheduleSave();
}

wss.on("connection", (ws) => {
  const client = {
    id: nanoid(),
    ws,
    address: null,
    name: null,
    roomId: null,
    seat: null,
    rejoinChallenge: null,
  };
  clients.set(client.id, client);
  send(ws, { type: "WELCOME", payload: { clientId: client.id } });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;
      switch (type) {
        case "HELLO": {
          client.address = payload?.address || null;
          client.name = payload?.name || null;
          if (client.roomId) {
            const room = rooms.get(client.roomId);
            if (room && client.seat !== null && client.seat !== undefined) {
              room.playerMeta[client.seat] = {
                address: client.address || room.playerMeta[client.seat]?.address || null,
                name: client.name || room.playerMeta[client.seat]?.name || null,
              };
            }
          }
          break;
        }
        case "QUEUE_JOIN": {
          if (client.roomId) throw new Error("Already in room");
          if (!queue.includes(client)) queue.push(client);
          send(ws, { type: "QUEUE_STATUS", payload: { size: queue.length } });
          tryMatchmake();
          break;
        }
        case "QUEUE_LEAVE": {
          const idx = queue.indexOf(client);
          if (idx >= 0) queue.splice(idx, 1);
          send(ws, { type: "QUEUE_STATUS", payload: { size: queue.length } });
          break;
        }
        case "SEED_COMMIT":
          if (FAIRNESS_MODE !== "commit-reveal") {
            if (!ALLOW_STUB_CRYPTO) throw new Error("Mental-poker mode enabled");
          }
          handleSeedCommit(client, payload);
          break;
        case "SEED_REVEAL":
          if (FAIRNESS_MODE !== "commit-reveal") {
            if (!ALLOW_STUB_CRYPTO) throw new Error("Mental-poker mode enabled");
          }
          handleSeedReveal(client, payload);
          break;
        case "READY_SET":
          handleReadySet(client, payload);
          break;
        case "REJOIN_REQUEST":
          handleRejoinRequest(client, payload);
          break;
        case "MP_KEYGEN_SUBMIT":
          if (!IS_MENTAL_POKER) throw new Error("Mental-poker mode not enabled");
          handleMpKeygen(client, payload);
          break;
        case "MP_SHUFFLE_SUBMIT":
          if (!IS_MENTAL_POKER) throw new Error("Mental-poker mode not enabled");
          handleMpShuffleSubmit(client, payload);
          break;
        case "MP_SHUFFLE_ACK":
          if (!IS_MENTAL_POKER) throw new Error("Mental-poker mode not enabled");
          handleMpShuffleAck(client, payload);
          break;
        case "MP_REVEAL_TOKEN":
          if (!IS_MENTAL_POKER) throw new Error("Mental-poker mode not enabled");
          handleMpRevealToken(client, payload);
          break;
        case "ACTION_DISCARD":
          handleDiscard(client, payload);
          break;
        case "ACTION_WIN":
          handleDeclareWin(client, payload);
          break;
        case "BIND_GAME":
          handleBindGame(client, payload);
          break;
        case "SPECTATE_JOIN":
          handleSpectateJoin(client, payload);
          break;
        case "SYNC_REQUEST":
          handleSyncRequest(client);
          break;
        case "REJOIN":
          handleRejoin(client, payload);
          break;
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    } catch (err) {
      send(ws, { type: "ERROR", payload: { message: err.message || String(err) } });
    }
  });

  ws.on("close", () => {
    const idx = queue.indexOf(client);
    if (idx >= 0) queue.splice(idx, 1);
    if (client.roomId) {
      const room = rooms.get(client.roomId);
      if (room && room.spectators) {
        room.spectators.delete(client.id);
      }
    }
    clients.delete(client.id);
  });
});

async function boot() {
  await initDb();
  await loadRooms();
  server.listen(PORT, () => {
    console.log(`riichi-zk server listening on :${PORT}`);
  });
}

boot().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  saveRooms().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  saveRooms().finally(() => process.exit(0));
});
