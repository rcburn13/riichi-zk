pragma circom 2.1.0;

template EngineOutputInvariant(MAX_YAKU) {
    signal input win;
    signal input shanten;      // -1 encoded as 9
    signal input yakuCount;
    signal input yakuHan[MAX_YAKU];
    signal input hanTotal;
    signal input fuTotal;
    signal input waitsCount;

    win * (yakuCount == 0) === 0;

    signal sum;
    sum <== 0;
    for (var i = 0; i < MAX_YAKU; i++) {
        sum <== sum + yakuHan[i];
    }
    hanTotal === sum;

    (1 - win) * fuTotal === 0;
    win === (shanten == 9);
    (shanten > 0) * waitsCount === 0;
}
