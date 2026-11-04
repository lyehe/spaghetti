// Game rules and tuning in one place.
export const RULES = {
    lives: 3,
    powerTime: 60,            // seconds of meatball strength
    powerWarn: 8,             // the power bar starts flashing
    meatballLife: 30,         // seconds a meatball waits on the ground
    meatballEvery: [9, 17],   // seconds between meatball spawns
    reformAfter: 10,          // a crushed heap left alone (without power) gets back up
    invulnAfterHit: 2.5,
    score: { stun: 10, crush: 200, meatball: 50, strand: 5, monster: 500, bossWin: 2000 }
};
