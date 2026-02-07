import { buildPoseidon } from "circomlibjs";

const MAX_YAKU = 50;

function toBigInt(value: any, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid number for ${label}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`Unsupported type for ${label}`);
}

function normalizeYakuHan(arr: any): bigint[] {
  if (!Array.isArray(arr)) {
    throw new Error("yakuHan must be an array");
  }
  if (arr.length > MAX_YAKU) {
    throw new Error(`yakuHan length exceeds MAX_YAKU=${MAX_YAKU}`);
  }
  const out = new Array<bigint>(MAX_YAKU).fill(0n);
  for (let i = 0; i < arr.length; i++) {
    const v = toBigInt(arr[i], `yakuHan[${i}]`);
    if (v < 0n) throw new Error(`yakuHan[${i}] must be >= 0`);
    out[i] = v;
  }
  return out;
}

// Poseidon hash binding (must match circuit packing).
export async function hashEngineOutput(o: any): Promise<string> {
  const win = toBigInt(o.win, "win");
  const shanten = toBigInt(o.shanten, "shanten");
  const yakuCount = toBigInt(o.yakuCount, "yakuCount");
  const hanTotal = toBigInt(o.hanTotal, "hanTotal");
  const fuTotal = toBigInt(o.fuTotal, "fuTotal");
  const waitsCount = toBigInt(o.waitsCount, "waitsCount");
  const yakuHan = normalizeYakuHan(o.yakuHan);

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
  const chunk3 = yakuHan.slice(42, 50).concat(new Array<bigint>(8).fill(0n));

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const h0 = poseidon(chunk0);
  const h1 = poseidon(chunk1);
  const h2 = poseidon(chunk2);
  const h3 = poseidon(chunk3);
  const h = poseidon([h0, h1, h2, h3]);

  const hex = F.toString(h, 16).padStart(64, "0");
  return `0x${hex}`;
}
