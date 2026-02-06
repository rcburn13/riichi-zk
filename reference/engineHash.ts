import { keccak256, toUtf8Bytes } from "ethers";

function canonicalSerialize(obj: any): string {
  if (obj === null) return "null";
  if (typeof obj === "bigint") {
    return `{\"$bigint\":\"${obj.toString()}\"}`;
  }
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) {
      throw new Error("Non-finite number in engine output");
    }
    return JSON.stringify(obj);
  }
  if (typeof obj === "string" || typeof obj === "boolean") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "undefined") {
    throw new Error("Undefined value in engine output");
  }
  if (typeof obj === "function" || typeof obj === "symbol") {
    throw new Error("Unsupported type in engine output");
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalSerialize).join(",")}]`;
  }
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `"${k}":${canonicalSerialize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(obj);
}

export function hashEngineOutput(o: any): string {
  return keccak256(toUtf8Bytes(canonicalSerialize(o)));
}
