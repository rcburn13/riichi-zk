pragma circom 2.1.0;

template Num2BitsStrict(N) {
    signal input in;
    signal output out[N];
    var acc = 0;
    for (var i = 0; i < N; i++) {
        out[i] * (out[i] - 1) === 0;
        acc += out[i] * (1 << i);
    }
    in === acc;
}

template EngineOutputInvariant(MAX_YAKU) {
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

    component shantenBits = Num2BitsStrict(4); // 0..15
    shantenBits.in <== shanten;
    var shProd = 1;
    for (var s = 0; s <= 9; s++) {
        shProd *= (shanten - s);
    }
    shProd === 0;

    component yakuCountBits = Num2BitsStrict(8); // 0..255
    yakuCountBits.in <== yakuCount;
    var ycProd = 1;
    for (var s = 0; s <= MAX_YAKU; s++) {
        ycProd *= (yakuCount - s);
    }
    ycProd === 0;

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

    // win=0 => yakuCount=0; win=1 => yakuCount in 1..MAX_YAKU
    (1 - win) * yakuCount === 0;
    var ycNonZeroProd = 1;
    for (var s = 1; s <= MAX_YAKU; s++) {
        ycNonZeroProd *= (yakuCount - s);
    }
    win * ycNonZeroProd === 0;

    signal sum;
    var acc = 0;
    for (var i = 0; i < MAX_YAKU; i++) {
        acc += yakuHan[i];
    }
    sum <== acc;
    hanTotal === sum;

    (1 - win) * fuTotal === 0;

    // win <=> shanten == 9
    win * (shanten - 9) === 0;
    var shNot9Prod = 1;
    for (var s = 0; s <= 8; s++) {
        shNot9Prod *= (shanten - s);
    }
    (1 - win) * shNot9Prod === 0;

    // waitsCount only non-zero when shanten == 0
    shanten * waitsCount === 0;
}
