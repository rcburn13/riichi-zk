import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "circuits", "build");
const MAX_YAKU = 50;

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid number for ${label}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "boolean") return value ? 1n : 0n;
  throw new Error(`Unsupported type for ${label}`);
}

function normalizeYakuHan(arr) {
  if (!Array.isArray(arr)) throw new Error("yakuHan must be an array");
  if (arr.length > MAX_YAKU) throw new Error("yakuHan too long");
  const out = new Array(MAX_YAKU).fill(0n);
  for (let i = 0; i < arr.length; i++) {
    const v = toBigInt(arr[i], `yakuHan[${i}]`);
    if (v < 0n) throw new Error("yakuHan must be >= 0");
    out[i] = v;
  }
  return out;
}

async function main() {
  const engine = {
    win: 1,
    shanten: 9,
    yakuCount: 1,
    yakuHan: [1],
    hanTotal: 1,
    fuTotal: 30,
    waitsCount: 0,
  };

  const win = toBigInt(engine.win, "win");
  const shanten = toBigInt(engine.shanten, "shanten");
  const yakuCount = toBigInt(engine.yakuCount, "yakuCount");
  const hanTotal = toBigInt(engine.hanTotal, "hanTotal");
  const fuTotal = toBigInt(engine.fuTotal, "fuTotal");
  const waitsCount = toBigInt(engine.waitsCount, "waitsCount");
  const yakuHan = normalizeYakuHan(engine.yakuHan);

  const chunk0 = [
    win,
    shanten,
    yakuCount,
    hanTotal,
    fuTotal,
    waitsCount,
    ...yakuHan.slice(0, 10),
  ];
  const chunk1 = yakuHan.slice(10, 26);
  const chunk2 = yakuHan.slice(26, 42);
  const chunk3 = yakuHan.slice(42, 50).concat(new Array(8).fill(0n));

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const h0 = poseidon(chunk0);
  const h1 = poseidon(chunk1);
  const h2 = poseidon(chunk2);
  const h3 = poseidon(chunk3);
  const h = poseidon([h0, h1, h2, h3]);

  const hashDec = F.toString(h);
  const hashHex = "0x" + F.toString(h, 16).padStart(64, "0");

  const pubEngineVersionHash = 123n;
  const pubGameId = 1n;
  const pubWinner = BigInt("0x1111111111111111111111111111111111111111");
  const pubWin = win;

  const input = {
    pubEngineVersionHash: pubEngineVersionHash.toString(),
    pubGameId: pubGameId.toString(),
    pubEngineOutputHash: hashDec,
    pubWinner: pubWinner.toString(),
    pubWin: pubWin.toString(),
    win: win.toString(),
    shanten: shanten.toString(),
    yakuCount: yakuCount.toString(),
    yakuHan: yakuHan.map(v => v.toString()),
    hanTotal: hanTotal.toString(),
    fuTotal: fuTotal.toString(),
    waitsCount: waitsCount.toString(),
  };

  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(path.join(BUILD, "input.json"), JSON.stringify(input, null, 2));

  console.log("engineOutputHash (dec):", hashDec);
  console.log("engineOutputHash (hex):", hashHex);
  console.log("public signals order:");
  console.log(
    JSON.stringify([
      pubEngineVersionHash.toString(),
      pubGameId.toString(),
      hashDec,
      pubWinner.toString(),
      pubWin.toString(),
    ])
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
