pragma circom 2.1.0;

include "EngineOutputInvariant.circom";

// MAX_YAKU chosen for safety; adjust if your engine outputs a different length.
component main { public [pubEngineVersionHash, pubGameId, pubEngineOutputHash, pubWinner, pubWin] } = EngineOutputInvariant(50);
