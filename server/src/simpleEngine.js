import crypto from "crypto";
import { typeToName } from "./tiles.js";

export function buildDeck() {
  const deck = [];
  for (let type = 0; type < 34; type++) {
    for (let i = 0; i < 4; i++) deck.push(type);
  }
  return deck;
}

export function shuffleDeck(deck, seedHex) {
  const seed = seedToUint32(seedHex);
  const rng = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function seedCommit(seedHex) {
  return `0x${crypto.createHash("sha256").update(Buffer.from(seedHex.slice(2), "hex")).digest("hex")}`;
}

export function combineSeeds(seeds) {
  const joined = Buffer.concat(seeds.map((s) => Buffer.from(s.slice(2), "hex")));
  return `0x${crypto.createHash("sha256").update(joined).digest("hex")}`;
}

export function dealInitial(deck, players) {
  const hands = players.map(() => []);
  for (let round = 0; round < 13; round++) {
    for (let p = 0; p < players.length; p++) {
      hands[p].push(deck.pop());
    }
  }
  return hands;
}

export function drawTile(deck) {
  return deck.pop();
}

export function formatHand(hand) {
  return hand.map(typeToName);
}

export function canWin(hand) {
  if (hand.length !== 14) return false;
  const counts = new Array(34).fill(0);
  for (const t of hand) counts[t]++;

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
    if (counts[i] === 2) pairs++;
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

function seedToUint32(seedHex) {
  const buf = Buffer.from(seedHex.slice(2), "hex");
  return buf.readUInt32LE(0);
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
