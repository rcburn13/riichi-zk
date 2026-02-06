import { keccak256, toUtf8Bytes } from "ethers";

function canonicalSerialize(obj: any): string {
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
