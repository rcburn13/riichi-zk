import path from "path";
import { fileURLToPath } from "url";
import { groth16 } from "snarkjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "../..");
const BUILD_DIR = path.join(ROOT, "circuits", "build");
const WASM = path.join(BUILD_DIR, "EngineOutputInvariant_main_js", "EngineOutputInvariant_main.wasm");
const ZKEY = path.join(BUILD_DIR, "EngineOutputInvariant_main_final.zkey");

export async function generateProof(input) {
  const { proof, publicSignals } = await groth16.fullProve(input, WASM, ZKEY);
  return { proof, publicSignals };
}
