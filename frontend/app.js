const CONTRACT_ADDRESS = "0x56081C9F61427cf841cDc07eCBc56bA1bB0B0ca3";
const BASE_CHAIN_ID = 8453n;
const FUND_DURATION = 1800n;
const SETTLE_DURATION = 7200n;
const CHALLENGE_WINDOW = 1800n;
const MAX_STAKE_WEI = ethers.parseEther("0.01");
const MIN_STAKE_WEI = ethers.parseUnits("0.0005", 18);
const STAKE_STEP_WEI = ethers.parseUnits("0.0001", 18);
const BOND_RATIO_NUM = 1n;
const BOND_RATIO_DEN = 5n;
const ROOM_STORAGE_KEY = "riichi_room_id";

const ABI = [
  "function createGame(bytes32 gameId,address[] players,bytes[] sigs,uint256 stakePerPlayer,uint256 bondPerPlayer,uint256 fundDuration,uint256 settleDuration,uint256 challengeWindow) external",
  "function join(bytes32 gameId) external",
  "function fund(bytes32 gameId) external payable",
  "function settle(bytes32 gameId,uint256[2] a,uint256[2][2] b,uint256[2] c,uint256[5] ps) external",
  "function finalizeSettlement(bytes32 gameId) external",
  "function finalizeExpired(bytes32 gameId) external",
  "function cancelUnfunded(bytes32 gameId) external",
  "function challengeBond(bytes32 gameId) view returns (uint256)",
  "function challenge(bytes32 gameId,bytes32 reasonHash) external payable",
  "function resolveChallengeUphold(bytes32 gameId) external",
  "function resolveChallengeCancel(bytes32 gameId) external",
  "function resolveChallengeOverride(bytes32 gameId,address newWinner) external",
  "function withdraw() external",
  "function getGameStatus(bytes32 gameId) view returns (uint8)",
  "function claimable(address) view returns (uint256)",
  "function ENGINE_VERSION_HASH() view returns (uint256)",
  "function house() view returns (address)",
];

let provider;
let signer;
let contract;
let currentAddress;

const el = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
};

const statusMap = ["None", "Open", "Active", "Settled", "Disputed", "Finalized"];
const TILE_NAMES = [
  "1m","2m","3m","4m","5m","6m","7m","8m","9m",
  "1p","2p","3p","4p","5p","6p","7p","8p","9p",
  "1s","2s","3s","4s","5s","6s","7s","8s","9s",
  "E","S","W","N","P","F","C"
];

let countdownTimer = null;
let gameActive = false;
let pendingGameId = null;
const GAME_ID_FIELDS = [
  "joinGameId",
  "finalizeGameId",
  "settleGameId",
  "challengeGameId",
  "resolveGameId",
  "statusGameId",
  "bindGameId",
];

async function connect() {
  if (!window.ethereum) {
    toast("No wallet found. Install MetaMask.");
    return;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  currentAddress = await signer.getAddress();
  contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  await refreshStatus();
  if (gameWs && gameWs.readyState === WebSocket.OPEN) {
    attemptRejoin().catch(() => {});
  }
  toast("Wallet connected");
}

async function switchToBase() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x2105",
            chainName: "Base",
            rpcUrls: ["https://mainnet.base.org"],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

async function refreshStatus() {
  if (!provider || !contract) return;
  const network = await provider.getNetwork();
  el("wallet").textContent = currentAddress || "—";
  el("network").textContent = network.chainId === BASE_CHAIN_ID ? network.name : `${network.name} (not Base)`;
  el("chainid").textContent = network.chainId.toString();

  const house = await contract.house();
  const engine = await contract.ENGINE_VERSION_HASH();
  el("house").textContent = house;
  el("engine").textContent = engine.toString();
}

function parsePlayers() {
  const raw = el("players").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (raw.length < 2 || raw.length > 4) throw new Error("Players must be 2-4 addresses");
  return raw;
}

function parseBytes32(value, label) {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`${label} must be bytes32 (0x + 64 hex chars)`);
  }
  return value;
}

function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function syncGameIdFields(gameId, { force = false } = {}) {
  GAME_ID_FIELDS.forEach((id) => {
    const field = el(id);
    if (!field) return;
    if (force || !field.value) field.value = gameId;
  });
}

function ensureGameId() {
  if (!pendingGameId) {
    pendingGameId = randomBytes32();
    const display = el("gameIdAuto");
    if (display) display.textContent = pendingGameId;
    logMatch(`Auto gameId generated: ${pendingGameId}`);
    syncGameIdFields(pendingGameId);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("gameId", pendingGameId);
      history.replaceState({}, "", url.toString());
    } catch (_) {}
  }
  return pendingGameId;
}

function parseUint(id) {
  const v = el(id).value.trim();
  if (!v) return 0n;
  return BigInt(v);
}

async function computePlayersHash() {
  const players = parsePlayers();
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(["address[]"], [players]);
  const hash = ethers.keccak256(encoded);
  if (el("playersHash")) el("playersHash").value = hash;
  return hash;
}

async function computeDigest() {
  if (!signer) throw new Error("Connect wallet first");
  const players = parsePlayers();
  const gameId = ensureGameId();
  const playersHash = await computePlayersHash();
  const stakePerPlayer = getCreateStake(true);
  const bondPerPlayer = calcBond(stakePerPlayer);

  const network = await provider.getNetwork();
  const domain = {
    name: "RiichiSettlementV1_1",
    version: "1",
    chainId: network.chainId,
    verifyingContract: CONTRACT_ADDRESS,
  };
  const types = {
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
  const value = {
    gameId,
    playersHash,
    stakePerPlayer,
    bondPerPlayer,
    fundDuration: FUND_DURATION,
    settleDuration: SETTLE_DURATION,
    challengeWindow: CHALLENGE_WINDOW,
  };

  const digest = ethers.TypedDataEncoder.hash(domain, types, value);
  if (el("digest")) el("digest").value = digest;
  return { domain, types, value };
}

async function signTypedData() {
  if (!signer) throw new Error("Connect wallet first");
  const { domain, types, value } = await computeDigest();
  const sig = await signer.signTypedData(domain, types, value);
  const sigs = el("sigs");
  sigs.value = sigs.value ? `${sigs.value}\n${sig}` : sig;
}

async function createGame() {
  if (!contract) throw new Error("Connect wallet first");
  const gameId = ensureGameId();
  const players = parsePlayers();
  const sigs = el("sigs").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const stakePerPlayer = getCreateStake(true);
  const bondPerPlayer = calcBond(stakePerPlayer);

  const tx = await contract.createGame(
    gameId,
    players,
    sigs,
    stakePerPlayer,
    bondPerPlayer,
    FUND_DURATION,
    SETTLE_DURATION,
    CHALLENGE_WINDOW
  );
  await tx.wait();
  const shareUrl = (() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("gameId", gameId);
      return url.toString();
    } catch (_) {
      return gameId;
    }
  })();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(shareUrl).catch(() => {});
  }
  logMatch(`Game created: ${gameId}`);
  logMatch(`Share link copied: ${shareUrl}`);
  toast("Game created");
}

async function joinGame() {
  const gameId = parseBytes32(el("joinGameId").value.trim(), "Game ID");
  const tx = await contract.join(gameId);
  await tx.wait();
  toast("Joined");
}

async function fundGame() {
  const gameId = parseBytes32(el("joinGameId").value.trim(), "Game ID");
  const stake = getJoinStake(true);
  const bond = calcBond(stake);
  const value = stake + bond;
  const tx = await contract.fund(gameId, { value });
  await tx.wait();
  toast("Funded");
}

async function finalize() {
  const gameId = parseBytes32(el("finalizeGameId").value.trim(), "Game ID");
  const tx = await contract.finalizeSettlement(gameId);
  await tx.wait();
  toast("Finalized");
}

async function finalizeExpired() {
  const gameId = parseBytes32(el("finalizeGameId").value.trim(), "Game ID");
  const tx = await contract.finalizeExpired(gameId);
  await tx.wait();
  toast("Finalized expired");
}

async function resolveAndWithdraw() {
  if (!contract) throw new Error("Connect wallet first");
  const gameId = parseBytes32(el("finalizeGameId").value.trim(), "Game ID");
  const status = await contract.getGameStatus(gameId);
  const statusNum = Number(status);
  let tx;
  if (statusNum === 1) {
    tx = await contract.cancelUnfunded(gameId);
  } else if (statusNum === 2) {
    tx = await contract.finalizeExpired(gameId);
  } else if (statusNum === 3) {
    tx = await contract.finalizeSettlement(gameId);
  } else {
    throw new Error("Game not in a timeout-resolvable state");
  }
  await tx.wait();
  toast("Resolved");

  const claimable = await refreshClaimable();
  if (claimable > 0n) {
    const wtx = await contract.withdraw();
    await wtx.wait();
    toast("Withdrawn");
    await refreshClaimable();
  } else {
    toast("No claimable balance");
  }
}

async function refreshClaimable() {
  if (!contract || !currentAddress) return 0n;
  const amt = await contract.claimable(currentAddress);
  el("claimable").value = ethers.formatEther(amt);
  return amt;
}

async function withdraw() {
  const tx = await contract.withdraw();
  await tx.wait();
  toast("Withdrawn");
  await refreshClaimable();
}

function parseSnarkProof() {
  const proof = JSON.parse(el("proofJson").value);
  const pub = JSON.parse(el("publicJson").value);

  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];
  const ps = pub;

  const parsed = { a, b, c, ps };
  el("parsedProof").value = JSON.stringify(parsed, null, 2);
  return parsed;
}

async function settle() {
  const gameId = parseBytes32(el("settleGameId").value.trim(), "Game ID");
  const parsed = parseSnarkProof();
  const tx = await contract.settle(gameId, parsed.a, parsed.b, parsed.c, parsed.ps);
  await tx.wait();
  toast("Settled");
}

async function challenge() {
  const gameId = parseBytes32(el("challengeGameId").value.trim(), "Game ID");
  const reasonHash = parseBytes32(el("reasonHash").value.trim(), "Reason hash");
  const bond = await contract.challengeBond(gameId);
  const tx = await contract.challenge(gameId, reasonHash, { value: bond });
  await tx.wait();
  toast("Challenged");
}

async function resolveUphold() {
  const gameId = parseBytes32(el("resolveGameId").value.trim(), "Game ID");
  const tx = await contract.resolveChallengeUphold(gameId);
  await tx.wait();
  toast("Uphold resolved");
}

async function resolveCancel() {
  const gameId = parseBytes32(el("resolveGameId").value.trim(), "Game ID");
  const tx = await contract.resolveChallengeCancel(gameId);
  await tx.wait();
  toast("Canceled");
}

async function resolveOverride() {
  const gameId = parseBytes32(el("resolveGameId").value.trim(), "Game ID");
  const winner = el("overrideWinner").value.trim();
  const tx = await contract.resolveChallengeOverride(gameId, winner);
  await tx.wait();
  toast("Override resolved");
}

async function statusCheck() {
  const gameId = parseBytes32(el("statusGameId").value.trim(), "Game ID");
  const status = await contract.getGameStatus(gameId);
  el("statusOutput").textContent = statusMap[Number(status)] || "Unknown";
}

function calcReasonHash() {
  const reason = el("challengeReason").value.trim();
  if (!reason) return;
  el("reasonHash").value = ethers.keccak256(ethers.toUtf8Bytes(reason));
}

async function fetchBond() {
  const gameId = parseBytes32(el("challengeGameId").value.trim(), "Game ID");
  const bond = await contract.challengeBond(gameId);
  el("challengeBond").value = ethers.formatEther(bond);
}

function addSig() {
  const sig = el("sigManual").value.trim();
  if (!sig) return;
  const sigs = el("sigs");
  sigs.value = sigs.value ? `${sigs.value}\n${sig}` : sig;
  el("sigManual").value = "";
}

function clearSigs() {
  el("sigs").value = "";
}

function bindEvents() {
  el("connect").addEventListener("click", connect);
  el("switch").addEventListener("click", switchToBase);
  el("calcPlayersHash").addEventListener("click", () => computePlayersHash().catch(err => toast(err.message)));
  el("calcDigest").addEventListener("click", () => computeDigest().catch(err => toast(err.message)));
  el("sign").addEventListener("click", () => signTypedData().catch(err => toast(err.message)));
  el("addSig").addEventListener("click", addSig);
  el("clearSigs").addEventListener("click", clearSigs);
  el("createGame").addEventListener("click", () => createGame().catch(err => toast(err.message)));
  el("join").addEventListener("click", () => joinGame().catch(err => toast(err.message)));
  el("fund").addEventListener("click", () => fundGame().catch(err => toast(err.message)));
  el("finalize").addEventListener("click", () => finalize().catch(err => toast(err.message)));
  const resolveWithdrawBtn = el("resolveWithdraw");
  if (resolveWithdrawBtn) resolveWithdrawBtn.addEventListener("click", () => resolveAndWithdraw().catch(err => toast(err.message)));
  el("refreshClaimable").addEventListener("click", () => refreshClaimable().catch(err => toast(err.message)));
  el("withdraw").addEventListener("click", () => withdraw().catch(err => toast(err.message)));
  el("parseProof").addEventListener("click", () => { try { parseSnarkProof(); } catch (err) { toast(err.message); } });
  el("settle").addEventListener("click", () => settle().catch(err => toast(err.message)));
  el("calcReasonHash").addEventListener("click", calcReasonHash);
  el("fetchBond").addEventListener("click", () => fetchBond().catch(err => toast(err.message)));
  el("challenge").addEventListener("click", () => challenge().catch(err => toast(err.message)));
  el("resolveUphold").addEventListener("click", () => resolveUphold().catch(err => toast(err.message)));
  el("resolveCancel").addEventListener("click", () => resolveCancel().catch(err => toast(err.message)));
  el("resolveOverride").addEventListener("click", () => resolveOverride().catch(err => toast(err.message)));
  el("statusCheck").addEventListener("click", () => statusCheck().catch(err => toast(err.message)));
  el("joinStake").addEventListener("input", () => getJoinStake(false));
  el("stake").addEventListener("input", () => getCreateStake(false));
  const queueJoin = el("queueJoin");
  if (queueJoin) queueJoin.addEventListener("click", () => joinQueue().catch(err => toast(err.message)));
  const queueLeave = el("queueLeave");
  if (queueLeave) queueLeave.addEventListener("click", () => leaveQueue().catch(err => toast(err.message)));
  const spectateBtn = el("spectateBtn");
  if (spectateBtn) spectateBtn.addEventListener("click", () => spectateRoom().catch(err => toast(err.message)));
  const resyncBtn = el("resyncBtn");
  if (resyncBtn) resyncBtn.addEventListener("click", () => requestSync().catch(err => toast(err.message)));
  const readyBtn = el("readyBtn");
  if (readyBtn) readyBtn.addEventListener("click", () => toggleReady().catch(err => toast(err.message)));
  const bindBtn = el("bindGameBtn");
  if (bindBtn) bindBtn.addEventListener("click", () => bindGame().catch(err => toast(err.message)));
  const discardBtn = el("discardBtn");
  if (discardBtn) discardBtn.addEventListener("click", () => sendDiscard().catch(err => toast(err.message)));
  const winBtn = el("winBtn");
  if (winBtn) winBtn.addEventListener("click", () => sendWin().catch(err => toast(err.message)));
  const soundToggle = el("soundToggle");
  if (soundToggle) {
    soundEnabled = soundToggle.checked;
    soundToggle.addEventListener("change", () => {
      soundEnabled = soundToggle.checked;
      if (!soundEnabled) {
        stopAmbient();
      } else if (gameActive) {
        startAmbient();
      }
    });
  }
  updateReadyButton();
}

bindEvents();
(() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("gameId");
    if (fromUrl && ethers.isHexString(fromUrl, 32)) {
      pendingGameId = fromUrl;
      const display = el("gameIdAuto");
      if (display) display.textContent = pendingGameId;
      syncGameIdFields(pendingGameId, { force: false });
      logMatch(`Loaded gameId from link: ${pendingGameId}`);
    }
  } catch (_) {}
})();
function formatEtherTrim(wei) {
  const s = ethers.formatEther(wei);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function normalizeStakeInput(id, opts = {}) {
  const input = el(id);
  if (!input) return 0n;
  const raw = input.value.trim();
  const warnEl = opts.warnId ? el(opts.warnId) : null;
  const freeEl = opts.freeId ? el(opts.freeId) : null;
  const bondEl = opts.bondPreviewId ? el(opts.bondPreviewId) : null;
  const totalEl = opts.totalId ? el(opts.totalId) : null;

  if (!raw) {
    if (warnEl) warnEl.textContent = "";
    if (freeEl) freeEl.textContent = "";
    if (bondEl) bondEl.value = "";
    if (totalEl) totalEl.value = "";
    return 0n;
  }

  let stake;
  try {
    stake = ethers.parseEther(raw);
  } catch (err) {
    if (warnEl) warnEl.textContent = "Enter a valid ETH amount.";
    if (bondEl) bondEl.value = "—";
    if (totalEl) totalEl.value = "—";
    if (freeEl) freeEl.textContent = "";
    if (opts.strict) throw new Error("Invalid stake amount");
    return 0n;
  }

  let warn = "";
  if (stake > MAX_STAKE_WEI) {
    stake = MAX_STAKE_WEI;
    warn = "Max stake is 0.01 ETH; clamped.";
  }
  if (stake > 0n && stake < MIN_STAKE_WEI) {
    stake = MIN_STAKE_WEI;
    warn = warn ? `${warn} Min stake is 0.0005 ETH.` : "Min stake is 0.0005 ETH; clamped.";
  }

  if (stake > 0n) {
    const rounded = (stake / STAKE_STEP_WEI) * STAKE_STEP_WEI;
    if (rounded !== stake) {
      stake = rounded;
      warn = warn ? `${warn} Rounded to 0.0001 ETH step.` : "Rounded to 0.0001 ETH step.";
    }
  }

  if (warnEl) warnEl.textContent = warn;
  if (freeEl) freeEl.textContent = stake === 0n ? "Free game (no bond)." : "";

  const bond = calcBond(stake);
  if (bondEl) bondEl.value = ethers.formatEther(bond);
  if (totalEl) totalEl.value = ethers.formatEther(stake + bond);

  input.value = formatEtherTrim(stake);
  return stake;
}

function getCreateStake(strict) {
  return normalizeStakeInput("stake", {
    warnId: "stakeWarn",
    freeId: "freeGame",
    bondPreviewId: "bondPreview",
    strict,
  });
}

function getJoinStake(strict) {
  return normalizeStakeInput("joinStake", {
    warnId: "joinStakeWarn",
    freeId: "joinFreeGame",
    bondPreviewId: "joinBondPreview",
    totalId: "fundTotal",
    strict,
  });
}

function calcBond(stake) {
  if (stake === 0n) return 0n;
  return (stake * BOND_RATIO_NUM) / BOND_RATIO_DEN;
}

let gameWs = null;
let gameSeed = null;
let gameCommit = null;
let gameWsReady = null;
let gameWsReadyResolver = null;
let ziffleWasm = null;
let ziffleReady = null;
let ziffleReadyResolver = null;
let gameState = {
  roomId: "",
  seat: null,
  yourTurn: false,
  canWin: false,
  hand: [],
  playerCount: 0,
  currentTurnSeat: null,
  deadlineMs: null,
  discards: [[], [], [], []],
  lastDrawnTile: null,
  lastDiscardSeat: null,
  pendingDiscard: null,
  ready: [],
  phase: null,
};

const mpState = {
  enabled: false,
  context: null,
  sk: null,
  pk: null,
  vpkBySeat: new Map(),
  apkHandle: null,
  verifiedDeckHandle: null,
  cardHandles: new Map(),
};

function resetMpState() {
  mpState.enabled = false;
  mpState.context = null;
  mpState.sk = null;
  mpState.pk = null;
  mpState.vpkBySeat.clear();
  mpState.apkHandle = null;
  mpState.verifiedDeckHandle = null;
  mpState.cardHandles.clear();
  gameState.lastDrawnTile = null;
}

function logMatch(msg) {
  const logEl = el("matchLog");
  if (!logEl) return;
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.value = logEl.value ? `${logEl.value}\n${line}` : line;
  logEl.scrollTop = logEl.scrollHeight;
}

function storeRoomId(roomId) {
  try {
    if (roomId) localStorage.setItem(ROOM_STORAGE_KEY, roomId);
  } catch (_) {}
}

function loadRoomId() {
  try {
    return localStorage.getItem(ROOM_STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

function clearRoomId() {
  try {
    localStorage.removeItem(ROOM_STORAGE_KEY);
  } catch (_) {}
}

function setTurnStatus(text) {
  const status = el("turnStatus");
  if (status) status.value = text;
}

function renderHand(hand) {
  gameState.hand = hand || [];
  const container = el("handTiles");
  if (!container) return;
  container.innerHTML = "";
  let marked = false;
  gameState.hand.forEach((tile, idx) => {
    const div = document.createElement("div");
    div.className = "hand-tile";
    div.textContent = tile;
    if (!marked && gameState.lastDrawnTile === tile) {
      div.classList.add("new");
      marked = true;
    }
    div.addEventListener("click", () => handleTileClick(tile, idx));
    container.appendChild(div);
  });
}

function updateActionButtons() {
  const discardBtn = el("discardBtn");
  const winBtn = el("winBtn");
  if (discardBtn) discardBtn.disabled = !gameState.yourTurn;
  if (winBtn) winBtn.disabled = !(gameState.yourTurn && gameState.canWin);
}

function handleTileClick(tile, idx) {
  if (!gameState.yourTurn) {
    const grid = el("handTiles");
    if (grid) {
      grid.classList.remove("shake");
      void grid.offsetWidth;
      grid.classList.add("shake");
    }
    return;
  }
  const tiles = document.querySelectorAll(".hand-tile");
  tiles.forEach((t) => t.classList.remove("selected"));
  if (tiles[idx]) tiles[idx].classList.add("selected");
  sendDiscard(tile).catch((err) => toast(err.message));
}

function setTurnSeat(seat) {
  gameState.currentTurnSeat = seat;
  const row = el("seatRow");
  if (!row) return;
  row.innerHTML = "";
  for (let i = 0; i < gameState.playerCount; i++) {
    const div = document.createElement("div");
    div.className = "seat" + (seat !== null && i === seat ? " active" : "");
    const readyFlag = gameState.ready[i] ? "Ready" : "Not ready";
    div.textContent = `Seat ${i + 1} • ${readyFlag}`;
    row.appendChild(div);
  }
  renderDiscards();
  updateReadyButton();
}

function buildRejoinMessage(roomId, address, nonce) {
  return [
    "Riichi zk Rejoin",
    `Room: ${roomId}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

function renderDiscards() {
  for (let i = 0; i < 4; i++) {
    const seatEl = document.querySelector(`.discard-pile[data-seat="${i}"]`);
    const row = el(`discardSeat${i}`);
    if (!seatEl || !row) continue;
    if (i >= gameState.playerCount) {
      seatEl.style.display = "none";
      continue;
    }
    seatEl.style.display = "block";
    seatEl.classList.toggle("active", gameState.currentTurnSeat === i);
    row.innerHTML = "";
    const pile = gameState.discards[i] || [];
    pile.forEach((tile, idx) => {
      const t = document.createElement("div");
      t.className = "discard-tile";
      if (idx === pile.length - 1 && gameState.lastDiscardSeat === i) {
        t.classList.add("new");
      }
      t.textContent = tile;
      row.appendChild(t);
    });
  }
}

function startTurnTimer(deadlineMs) {
  gameState.deadlineMs = deadlineMs;
  const bar = el("turnTimerBar");
  if (!bar) return;
  const start = Date.now();
  const total = Math.max(deadlineMs - start, 1);
  if (window._turnTimer) clearInterval(window._turnTimer);
  window._turnTimer = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(deadlineMs - now, 0);
    const pct = Math.min((remaining / total) * 100, 100);
    bar.style.width = `${pct}%`;
    if (remaining <= 5000) {
      bar.classList.add("pulse");
    } else {
      bar.classList.remove("pulse");
    }
    if (remaining <= 0) {
      clearInterval(window._turnTimer);
      bar.classList.remove("pulse");
    }
  }, 100);
}

function showWinBanner(text) {
  const existing = document.querySelector(".win-banner");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.className = "win-banner";
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2500);
}

function spawnConfetti() {
  const existing = document.querySelector(".confetti");
  if (existing) existing.remove();
  const container = document.createElement("div");
  container.className = "confetti";
  const colors = ["#d4a14f", "#c7432e", "#f7e7cf", "#1f6b4a"];
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.2}s`;
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 1800);
}

let audioCtx;
let soundEnabled = true;
let ambientOsc;
function playTileSound() {
  if (!soundEnabled) return;
  if (!window.AudioContext) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = 820;
  gain.gain.value = 0.06;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.stop(audioCtx.currentTime + 0.09);
}

function playWinSound() {
  if (!soundEnabled) return;
  if (!window.AudioContext) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(520, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(1040, audioCtx.currentTime + 0.25);
  gain.gain.value = 0.08;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
  osc.stop(audioCtx.currentTime + 0.4);
}

function startAmbient() {
  if (!soundEnabled) return;
  if (!window.AudioContext) return;
  if (!audioCtx) audioCtx = new AudioContext();
  if (ambientOsc) return;
  ambientOsc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  ambientOsc.type = "triangle";
  ambientOsc.frequency.value = 110;
  gain.gain.value = 0.015;
  ambientOsc.connect(gain);
  gain.connect(audioCtx.destination);
  ambientOsc.start();
}

function stopAmbient() {
  if (ambientOsc) {
    ambientOsc.stop();
    ambientOsc = null;
  }
}

function playTurnChime() {
  if (!soundEnabled) return;
  if (!window.AudioContext) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 660;
  gain.gain.value = 0.05;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
  osc.stop(audioCtx.currentTime + 0.2);
}

function showCountdown(seconds) {
  const overlay = el("countdownOverlay");
  if (!overlay) return;
  let remaining = Math.max(Number(seconds) || 0, 0);
  overlay.textContent = remaining > 0 ? String(remaining) : "Go";
  overlay.classList.remove("hidden");
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      overlay.textContent = "Go";
      clearInterval(countdownTimer);
      countdownTimer = null;
      setTimeout(() => hideCountdown(), 600);
      return;
    }
    overlay.textContent = String(remaining);
  }, 1000);
}

function hideCountdown() {
  const overlay = el("countdownOverlay");
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (overlay) overlay.classList.add("hidden");
}

function tileFromIndex(idx) {
  const type = Math.floor(idx / 4);
  return TILE_NAMES[type] || "?";
}

function tileNameToType(name) {
  const idx = TILE_NAMES.indexOf(name);
  return idx === -1 ? null : idx;
}

function canWinHand(handNames) {
  if (!Array.isArray(handNames) || handNames.length !== 14) return false;
  const counts = new Array(34).fill(0);
  for (const name of handNames) {
    const type = tileNameToType(name);
    if (type === null) return false;
    counts[type] += 1;
  }

  if (isSevenPairs(counts)) return true;
  for (let i = 0; i < 34; i++) {
    if (counts[i] >= 2) {
      counts[i] -= 2;
      if (canFormGroups(counts)) {
        counts[i] += 2;
        return true;
      }
      counts[i] += 2;
    }
  }
  return false;
}

function isSevenPairs(counts) {
  let pairs = 0;
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 2) pairs += 1;
    else if (counts[i] === 4) pairs += 2;
    else if (counts[i] !== 0) return false;
  }
  return pairs === 7;
}

function canFormGroups(counts) {
  let i = counts.findIndex((c) => c > 0);
  if (i === -1) return true;

  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormGroups(counts)) {
      counts[i] += 3;
      return true;
    }
    counts[i] += 3;
  }

  const suit = Math.floor(i / 9);
  const indexInSuit = i % 9;
  if (suit < 3 && indexInSuit <= 6) {
    const i1 = i + 1;
    const i2 = i + 2;
    if (counts[i1] > 0 && counts[i2] > 0) {
      counts[i]--;
      counts[i1]--;
      counts[i2]--;
      if (canFormGroups(counts)) {
        counts[i]++;
        counts[i1]++;
        counts[i2]++;
        return true;
      }
      counts[i]++;
      counts[i1]++;
      counts[i2]++;
    }
  }

  return false;
}

async function ensureZiffle() {
  if (ziffleWasm && ziffleWasm.__initialized) return;
  if (ziffleReady) return ziffleReady;
  ziffleReady = new Promise((resolve) => {
    ziffleReadyResolver = resolve;
  });
  const module = await import("./wasm/ziffle/ziffle_wasm.js");
  await module.default();
  module.__initialized = true;
  ziffleWasm = module;
  if (ziffleReadyResolver) ziffleReadyResolver();
  return ziffleReady;
}

async function mpKeygen(context) {
  await ensureZiffle();
  mpState.enabled = true;
  mpState.context = context;
  const { sk, pk, proof } = ziffleWasm.keygen(context);
  mpState.sk = sk;
  mpState.pk = pk;
  sendWs("MP_KEYGEN_SUBMIT", { pk, proof });
  logMatch("Mental-poker keygen submitted.");
}

async function mpHandleKeygenBroadcast(payload) {
  await ensureZiffle();
  mpState.enabled = true;
  mpState.context = mpState.context || gameState.roomId;
  const vpkHandle = ziffleWasm.verify_public_key(payload.pk, payload.proof, mpState.context);
  mpState.vpkBySeat.set(payload.seat, vpkHandle);
  logMatch(`Verified key from seat ${payload.seat}.`);

  if (mpState.vpkBySeat.size === gameState.playerCount && !mpState.apkHandle) {
    const handles = Array.from(mpState.vpkBySeat.values());
    mpState.apkHandle = ziffleWasm.aggregate_public_keys(handles);
    logMatch("Aggregate public key ready.");
  }
}

async function mpHandleShuffleRequest(payload) {
  await ensureZiffle();
  if (gameState.seat !== payload.seat) return;
  if (!mpState.apkHandle) throw new Error("Aggregate key missing");
  mpState.context = payload.context || mpState.context || gameState.roomId;
  const stage = payload.stage;
  let out;
  if (stage === 0) {
    out = ziffleWasm.shuffle_initial(mpState.apkHandle, mpState.context);
  } else {
    if (!mpState.verifiedDeckHandle) throw new Error("No verified deck yet");
    out = ziffleWasm.shuffle_next(mpState.apkHandle, mpState.verifiedDeckHandle, mpState.context);
  }
  sendWs("MP_SHUFFLE_SUBMIT", { stage, deck: out.deck, proof: out.proof });
  logMatch(`Submitted shuffle stage ${stage}.`);
}

async function mpHandleShuffleBroadcast(payload) {
  await ensureZiffle();
  if (!mpState.apkHandle) throw new Error("Aggregate key missing");
  mpState.context = payload.context || mpState.context || gameState.roomId;
  let handle;
  if (payload.stage === 0) {
    handle = ziffleWasm.verify_initial_shuffle(mpState.apkHandle, payload.deck, payload.proof, mpState.context);
  } else {
    if (!mpState.verifiedDeckHandle) throw new Error("Missing previous verified deck");
    handle = ziffleWasm.verify_shuffle(mpState.apkHandle, mpState.verifiedDeckHandle, payload.deck, payload.proof, mpState.context);
  }
  mpState.verifiedDeckHandle = handle;
  sendWs("MP_SHUFFLE_ACK", { stage: payload.stage, ok: true });
  logMatch(`Verified shuffle stage ${payload.stage}.`);
}

async function mpHandleRevealRequest(payload) {
  await ensureZiffle();
  if (!mpState.verifiedDeckHandle) throw new Error("Verified deck missing");
  const cardHandle = ziffleWasm.deck_get_card(mpState.verifiedDeckHandle, payload.cardIndex);
  mpState.cardHandles.set(payload.drawId, cardHandle);
  const out = ziffleWasm.reveal_token(mpState.sk, mpState.pk, cardHandle, mpState.context || gameState.roomId);
  sendWs("MP_REVEAL_TOKEN", { drawId: payload.drawId, token: out.token, proof: out.proof });
}

async function mpHandleRevealTokens(payload) {
  if (payload.seat !== gameState.seat) return;
  await ensureZiffle();
  const cardHandle = mpState.cardHandles.get(payload.drawId);
  if (!cardHandle) throw new Error("Missing card handle");
  const tokenHandles = [];
  for (const t of payload.tokens) {
    const vpkHandle = mpState.vpkBySeat.get(t.seat);
    if (!vpkHandle) throw new Error("Missing verified key");
    const vtoken = ziffleWasm.verify_reveal_token(
      vpkHandle,
      t.token,
      t.proof,
      cardHandle,
      mpState.context || gameState.roomId
    );
    tokenHandles.push(vtoken);
  }
  const artHandle = ziffleWasm.aggregate_reveal_tokens(tokenHandles);
  const idx = ziffleWasm.reveal_card(artHandle, cardHandle);
  const tile = tileFromIndex(idx);
  gameState.lastDrawnTile = tile;
  gameState.hand.push(tile);
  renderHand(gameState.hand);
  gameState.canWin = canWinHand(gameState.hand);
  updateActionButtons();
  playTileSound();
  logMatch(`Drew ${tile}`);

  tokenHandles.forEach((h) => ziffleWasm.free_verified_token(h));
  ziffleWasm.free_art(artHandle);
  ziffleWasm.free_card(cardHandle);
  mpState.cardHandles.delete(payload.drawId);
}

function sendWs(type, payload) {
  if (!gameWs || gameWs.readyState !== WebSocket.OPEN) return;
  gameWs.send(JSON.stringify({ type, payload }));
}

async function sha256Hex(hex) {
  const bytes = ethers.getBytes(hex);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const out = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${out}`;
}

function randomSeedHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const out = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${out}`;
}

async function ensureGameWs() {
  const url = el("wsUrl")?.value.trim();
  if (!url) throw new Error("Missing WebSocket URL");
  if (gameWs && gameWs.readyState === WebSocket.OPEN) return;
  if (gameWs && gameWs.readyState === WebSocket.CONNECTING) return gameWsReady;

  gameWsReady = new Promise((resolve) => {
    gameWsReadyResolver = resolve;
  });
  gameWs = new WebSocket(url);
  gameWs.addEventListener("open", () => {
    sendWs("HELLO", { address: currentAddress || null, name: el("playerName")?.value.trim() || null });
    logMatch("Connected to game server.");
    attemptRejoin().catch((err) => logMatch(`Rejoin skipped: ${err.message}`));
    if (gameWsReadyResolver) gameWsReadyResolver();
  });
  gameWs.addEventListener("close", () => {
    logMatch("Disconnected from game server.");
    gameWs = null;
    gameWsReady = null;
    gameWsReadyResolver = null;
    gameActive = false;
    stopAmbient();
  });
  gameWs.addEventListener("message", async (evt) => {
    const msg = JSON.parse(evt.data);
    const { type, payload } = msg;
    switch (type) {
      case "QUEUE_STATUS":
        logMatch(`Queue size: ${payload.size}`);
        break;
      case "ROOM_ASSIGNED":
        gameState.roomId = payload.roomId;
        gameState.seat = payload.seat;
        gameState.playerCount = Array.isArray(payload.players) ? payload.players.length : 0;
        gameState.phase = "READY";
        resetMpState();
        gameState.ready = Array.from({ length: gameState.playerCount }, () => false);
        gameState.discards = Array.from({ length: gameState.playerCount }, () => []);
        gameState.lastDiscardSeat = null;
        renderDiscards();
        setTurnSeat(null);
        updateReadyButton();
        if (el("roomId")) el("roomId").value = payload.roomId;
        if (el("seatIndex")) el("seatIndex").value = String(payload.seat);
        storeRoomId(payload.roomId);
        logMatch(`Room ${payload.roomId} seat ${payload.seat}`);
        if (payload.rejoined) {
          toast("Rejoined room");
        }
        break;
      case "MP_KEYGEN_REQUEST":
        mpKeygen(payload.context || gameState.roomId).catch((err) => {
          toast(err.message);
          logMatch(`Keygen error: ${err.message}`);
        });
        break;
      case "MP_KEYGEN_BROADCAST":
        mpHandleKeygenBroadcast(payload).catch((err) => {
          toast(err.message);
          logMatch(`Key verify error: ${err.message}`);
        });
        break;
      case "MP_SHUFFLE_REQUEST":
        mpHandleShuffleRequest(payload).catch((err) => {
          toast(err.message);
          logMatch(`Shuffle error: ${err.message}`);
        });
        break;
      case "MP_SHUFFLE_BROADCAST":
        mpHandleShuffleBroadcast(payload).catch((err) => {
          toast(err.message);
          logMatch(`Shuffle verify error: ${err.message}`);
        });
        break;
      case "MP_SHUFFLE_DONE":
        logMatch("Shuffle complete. Game starting.");
        break;
      case "MP_REVEAL_REQUEST":
        mpHandleRevealRequest(payload).catch((err) => {
          toast(err.message);
          logMatch(`Reveal error: ${err.message}`);
        });
        break;
      case "MP_REVEAL_TOKENS":
        mpHandleRevealTokens(payload).catch((err) => {
          toast(err.message);
          logMatch(`Reveal verify error: ${err.message}`);
        });
        break;
      case "SEED_COMMIT_REQUEST":
        if (!gameSeed) gameSeed = randomSeedHex();
        gameCommit = await sha256Hex(gameSeed);
        sendWs("SEED_COMMIT", { commit: gameCommit });
        logMatch("Seed committed.");
        break;
      case "SEED_REVEAL_REQUEST":
        if (!gameSeed) gameSeed = randomSeedHex();
        sendWs("SEED_REVEAL", { seed: gameSeed });
        logMatch("Seed revealed.");
        break;
      case "GAME_START":
        renderHand(payload.hand || []);
        setTurnStatus(`Turn seat ${payload.turnSeat}`);
        setTurnSeat(payload.turnSeat);
        gameState.phase = "PLAY";
        if (payload.discards) {
          gameState.discards = payload.discards.map((d) => d.slice());
          renderDiscards();
        }
        gameActive = true;
        startAmbient();
        logMatch("Game started.");
        break;
      case "TURN":
        gameState.yourTurn = payload.isYou;
        gameState.canWin = !!payload.canWin;
        gameState.lastDrawnTile = payload.drawn && payload.drawn !== "?" ? payload.drawn : null;
        if (payload.hand) renderHand(payload.hand);
        if (payload.isYou) {
          setTurnStatus("Your turn");
          playTurnChime();
        } else {
          setTurnStatus(`Waiting for seat ${payload.seat}`);
        }
        if (payload.seat !== undefined) setTurnSeat(payload.seat);
        if (payload.deadlineMs) startTurnTimer(payload.deadlineMs);
        updateActionButtons();
        break;
      case "READY_STATE":
        if (Array.isArray(payload.ready)) {
          gameState.ready = payload.ready.slice();
          setTurnSeat(gameState.currentTurnSeat);
          updateReadyButton();
        }
        break;
      case "COUNTDOWN":
        gameState.phase = "COUNTDOWN";
        showCountdown(payload.seconds || 3);
        break;
      case "COUNTDOWN_CANCEL":
        gameState.phase = "READY";
        hideCountdown();
        break;
      case "STATE":
        if (payload.action === "DISCARD") {
          logMatch(`Seat ${payload.seat} discarded ${payload.tile}`);
          if (gameState.pendingDiscard &&
              gameState.pendingDiscard.seat === payload.seat &&
              gameState.pendingDiscard.tile === payload.tile) {
            gameState.pendingDiscard = null;
          } else if (gameState.discards[payload.seat]) {
            gameState.discards[payload.seat].push(payload.tile);
            gameState.lastDiscardSeat = payload.seat;
            renderDiscards();
          }
          playTileSound();
        }
        if (payload.action === "AUTO_DISCARD") {
          logMatch(`Auto discard ${payload.tile}`);
          if (gameState.discards[payload.seat]) {
            gameState.discards[payload.seat].push(payload.tile);
            gameState.lastDiscardSeat = payload.seat;
            renderDiscards();
          }
          playTileSound();
        }
        break;
      case "GAME_BOUND":
        logMatch(`Bound to game ${payload.gameId}`);
        break;
      case "GAME_OVER":
        gameState.yourTurn = false;
        gameState.canWin = false;
        updateActionButtons();
        gameActive = false;
        stopAmbient();
        gameState.phase = "OVER";
        if (payload.winner) {
          showWinBanner("Tsumo!");
          spawnConfetti();
          playWinSound();
        } else {
          showWinBanner("Draw");
        }
        logMatch(`Game over (${payload.reason}). Winner: ${payload.winner || "none"}`);
        break;
      case "REJOIN_CHALLENGE":
        if (!signer) {
          toast("Connect wallet to rejoin");
          logMatch("Rejoin challenge received but wallet not connected.");
          break;
        }
        try {
          const msg = buildRejoinMessage(payload.roomId, payload.address, payload.nonce);
          const sig = await signer.signMessage(msg);
          sendWs("REJOIN", { roomId: payload.roomId, address: payload.address, signature: sig });
          logMatch("Rejoin signature sent.");
        } catch (err) {
          toast("Signature rejected");
          logMatch(`Rejoin signature error: ${err.message}`);
        }
        break;
      case "REPLAY_LOG":
        if (Array.isArray(payload.lines)) {
          const logEl = el("matchLog");
          if (logEl) {
            logEl.value = payload.lines.join("\n");
            logEl.scrollTop = logEl.scrollHeight;
          }
          logMatch("Replay log loaded.");
        }
        break;
      case "SYNC_STATE":
        if (payload.roomId) {
          gameState.roomId = payload.roomId;
          storeRoomId(payload.roomId);
        }
        gameState.phase = payload.phase || gameState.phase;
        if (gameState.phase === "PLAY") {
          gameActive = true;
          if (soundEnabled) startAmbient();
        } else {
          gameActive = false;
          stopAmbient();
        }
        if (payload.countdownEndsAt) {
          const remainingMs = payload.countdownEndsAt - Date.now();
          if (remainingMs > 0) {
            const seconds = Math.ceil(remainingMs / 1000);
            showCountdown(seconds);
          } else {
            hideCountdown();
          }
        } else if (gameState.phase !== "COUNTDOWN") {
          hideCountdown();
        }
        gameState.seat = payload.seat ?? gameState.seat;
        if (Array.isArray(payload.players)) {
          gameState.playerCount = payload.players.length;
        }
        if (Array.isArray(payload.ready)) {
          gameState.ready = payload.ready.slice();
        }
        if (Array.isArray(payload.discards)) {
          gameState.discards = payload.discards.map((d) => d.slice());
          renderDiscards();
        }
        if (payload.turnSeat !== undefined && payload.turnSeat !== null) {
          setTurnSeat(payload.turnSeat);
          setTurnStatus(gameState.phase === "PLAY" ? (payload.isYou ? "Your turn" : `Waiting for seat ${payload.turnSeat}`) : `Phase: ${gameState.phase}`);
        }
        if (payload.deadlineMs) startTurnTimer(payload.deadlineMs);
        if (Array.isArray(payload.hand)) {
          renderHand(payload.hand);
        } else if (payload.seat === null) {
          renderHand([]);
        } else if (payload.handKnown === false) {
          toast("Hand cannot be restored in mental-poker mode.");
        }
        gameState.yourTurn = !!payload.isYou;
        gameState.canWin = !!payload.canWin;
        updateActionButtons();
        updateReadyButton();
        logMatch("State synced.");
        break;
      case "SPECTATE_JOINED":
        gameState.seat = null;
        gameState.roomId = payload.roomId;
        updateReadyButton();
        logMatch(`Spectating room ${payload.roomId}`);
        break;
      case "TIMEOUT_WARNING":
        logMatch(`Seat ${payload.seat} timeout (${payload.strikes}/2).`);
        break;
      case "ERROR":
        toast(payload.message);
        logMatch(`Error: ${payload.message}`);
        break;
      default:
        break;
    }
  });
  return gameWsReady;
}

async function joinQueue() {
  await ensureGameWs();
  sendWs("QUEUE_JOIN", {});
  logMatch("Joined queue.");
}

async function leaveQueue() {
  if (!gameWs) return;
  sendWs("QUEUE_LEAVE", {});
  logMatch("Left queue.");
}

async function spectateRoom() {
  await ensureGameWs();
  const roomId = el("spectateRoomId")?.value.trim();
  if (!roomId) throw new Error("Enter a room ID to spectate");
  sendWs("SPECTATE_JOIN", { roomId });
  logMatch(`Spectating room ${roomId}...`);
}

async function requestSync() {
  await ensureGameWs();
  sendWs("SYNC_REQUEST", {});
  logMatch("Sync requested.");
}

async function attemptRejoin() {
  const stored = loadRoomId();
  if (!stored) return;
  if (!currentAddress) return;
  if (gameState.roomId && gameState.roomId === stored) {
    sendWs("SYNC_REQUEST", {});
    return;
  }
  sendWs("REJOIN_REQUEST", { roomId: stored, address: currentAddress });
}

async function bindGame() {
  const gameId = el("bindGameId")?.value.trim();
  if (!gameId) throw new Error("Enter a gameId to bind");
  parseBytes32(gameId, "Game ID");
  sendWs("BIND_GAME", { gameId });
}

async function sendDiscard(tileOverride) {
  if (!gameWs) throw new Error("Not connected");
  const tile = tileOverride;
  if (!tile) throw new Error("Select a tile to discard");
  sendWs("ACTION_DISCARD", { tile });
  const idx = gameState.hand.indexOf(tile);
  if (idx >= 0) {
    gameState.hand.splice(idx, 1);
    renderHand(gameState.hand);
  }
  if (gameState.seat !== null) {
    gameState.discards[gameState.seat].push(tile);
    gameState.lastDiscardSeat = gameState.seat;
    gameState.pendingDiscard = { seat: gameState.seat, tile };
    renderDiscards();
  }
  playTileSound();
  gameState.yourTurn = false;
  updateActionButtons();
}

async function sendWin() {
  if (!gameWs) throw new Error("Not connected");
  const payload = mpState.enabled ? { hand: gameState.hand } : {};
  sendWs("ACTION_WIN", payload);
  gameState.yourTurn = false;
  updateActionButtons();
}

async function toggleReady() {
  await ensureGameWs();
  if (gameState.seat === null || gameState.seat === undefined) {
    throw new Error("Waiting for a seat assignment");
  }
  const current = !!gameState.ready[gameState.seat];
  const next = !current;
  gameState.ready[gameState.seat] = next;
  updateReadyButton();
  sendWs("READY_SET", { ready: next });
  logMatch(next ? "Ready." : "Not ready.");
}

function updateReadyButton() {
  const btn = el("readyBtn");
  if (!btn) return;
  const seated = gameState.seat !== null && gameState.seat !== undefined;
  const canReady = gameState.phase === "READY" || gameState.phase === "COUNTDOWN" || gameState.phase === null;
  btn.disabled = !seated || !gameWs || !canReady;
  if (!seated) {
    btn.textContent = "Ready";
    return;
  }
  const isReady = !!gameState.ready[gameState.seat];
  btn.textContent = isReady ? "Unready" : "Ready";
  btn.classList.toggle("primary", !isReady);
  btn.classList.toggle("ghost", isReady);
}
