pragma circom 2.1.0;

include "./lib/circomlib/poseidon.circom";

template Num2BitsStrict(N) {
    signal input in;
    signal output out[N];
    var acc = 0;
    for (var i = 0; i < N; i++) {
        // Witness assignment to initialize bits.
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;
        acc += out[i] * (1 << i);
    }
    in === acc;
}

template IsZero() {
    signal input in;
    signal output out;
    signal inv;
    inv <-- in != 0 ? 1 / in : 0;
    out <== 1 - in * inv;
    in * out === 0;
}

template IsEqual() {
    signal input in[2];
    signal output out;
    component z = IsZero();
    z.in <== in[0] - in[1];
    out <== z.out;
}

template LessThan(N) {
    signal input in[2];
    signal output out;
    component n2b = Num2BitsStrict(N + 1);
    n2b.in <== in[0] + (1 << N) - in[1];
    out <== 1 - n2b.out[N];
}

template EngineOutputInvariant(MAX_YAKU) {
    // Public signals (bound on-chain).
    signal input pubEngineVersionHash;
    signal input pubGameId;
    signal input pubEngineOutputHash;
    signal input pubWinner;
    signal input pubWin;

    signal input win;
    signal input shanten;      // -1 encoded as 9
    signal input yakuCount;
    signal input yakuHan[MAX_YAKU];
    signal input hanTotal;
    signal input fuTotal;
    signal input waitsCount;

    // Range/boolean constraints.
    component winBits = Num2BitsStrict(1);
    winBits.in <== win;
    // Bind public win to internal win flag.
    pubWin === win;

    // Winner should fit in 160 bits (address).
    component winnerBits = Num2BitsStrict(160);
    winnerBits.in <== pubWinner;

    component shantenBits = Num2BitsStrict(4); // 0..15
    shantenBits.in <== shanten;
    component shLt = LessThan(4);
    shLt.in[0] <== shanten;
    shLt.in[1] <== 10; // shanten <= 9
    shLt.out === 1;

    component yakuCountBits = Num2BitsStrict(8); // 0..255
    yakuCountBits.in <== yakuCount;
    component ycLt = LessThan(8);
    ycLt.in[0] <== yakuCount;
    ycLt.in[1] <== MAX_YAKU + 1; // yakuCount <= MAX_YAKU
    ycLt.out === 1;

    component yakuHanBits[MAX_YAKU];
    for (var i = 0; i < MAX_YAKU; i++) {
        yakuHanBits[i] = Num2BitsStrict(8); // 0..255
        yakuHanBits[i].in <== yakuHan[i];
    }

    component hanTotalBits = Num2BitsStrict(16);
    hanTotalBits.in <== hanTotal;
    component fuTotalBits = Num2BitsStrict(16);
    fuTotalBits.in <== fuTotal;
    component waitsBits = Num2BitsStrict(8);
    waitsBits.in <== waitsCount;

    // win=0 => yakuCount=0; win=1 => yakuCount != 0
    (1 - win) * yakuCount === 0;
    component ycIsZero = IsZero();
    ycIsZero.in <== yakuCount;
    win * ycIsZero.out === 0;

    signal sum;
    var acc = 0;
    for (var i = 0; i < MAX_YAKU; i++) {
        acc += yakuHan[i];
    }
    sum <== acc;
    hanTotal === sum;

    (1 - win) * fuTotal === 0;

    // win <=> shanten == 9
    component shEq = IsEqual();
    shEq.in[0] <== shanten;
    shEq.in[1] <== 9;
    shEq.out === win;

    // waitsCount only non-zero when shanten == 0
    shanten * waitsCount === 0;

    // Poseidon hash binding for engine output.
    // NOTE: This packing assumes MAX_YAKU == 50. If you change MAX_YAKU,
    // update the packing (and the JS helper) to match.
    component h0 = Poseidon(16);
    component h1 = Poseidon(16);
    component h2 = Poseidon(16);
    component h3 = Poseidon(16);
    component hFinal = Poseidon(4);

    // Chunk 0: win, shanten, yakuCount, hanTotal, fuTotal, waitsCount, yakuHan[0..9]
    h0.inputs[0] <== win;
    h0.inputs[1] <== shanten;
    h0.inputs[2] <== yakuCount;
    h0.inputs[3] <== hanTotal;
    h0.inputs[4] <== fuTotal;
    h0.inputs[5] <== waitsCount;
    for (var i = 0; i < 10; i++) {
        h0.inputs[6 + i] <== yakuHan[i];
    }

    // Chunk 1: yakuHan[10..25]
    for (var i = 0; i < 16; i++) {
        h1.inputs[i] <== yakuHan[10 + i];
    }

    // Chunk 2: yakuHan[26..41]
    for (var i = 0; i < 16; i++) {
        h2.inputs[i] <== yakuHan[26 + i];
    }

    // Chunk 3: yakuHan[42..49] + padding
    for (var i = 0; i < 8; i++) {
        h3.inputs[i] <== yakuHan[42 + i];
    }
    for (var i = 8; i < 16; i++) {
        h3.inputs[i] <== 0;
    }

    hFinal.inputs[0] <== h0.out;
    hFinal.inputs[1] <== h1.out;
    hFinal.inputs[2] <== h2.out;
    hFinal.inputs[3] <== h3.out;
    pubEngineOutputHash === hFinal.out;
}
