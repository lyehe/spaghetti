// Fork combat geometry, shared by the game and the tests.

// distance from point p to a bone capsule's surface (bone k in a stride-13 bone array)
export function capsuleDist(bd, k, p) {
    const ax = bd[k], ay = bd[k + 1], az = bd[k + 2], ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az;
    let s = ((p[0] - ax) * ux + (p[1] - ay) * uy + (p[2] - az) * uz) / (ux * ux + uy * uy + uz * uz || 1);
    s = Math.max(0, Math.min(1, s));
    return Math.hypot(p[0] - ax - ux * s, p[1] - ay - uy * s, p[2] - az - uz * s) - bd[k + 12];
}

// Does the swinging fork touch a body? Tests the fork shaft (hand -> tip) and the arc the tip swept
// since the previous frame, so the result does not depend on the frame rate.
// Returns { hit, at, best } where `at` is the contact point.
export function forkHit(hand, tip, prevTip, bones, scale = 1) {
    const samples = [];
    for (let j = 0; j <= 6; j++) samples.push([hand[0] + (tip[0] - hand[0]) * j / 6, hand[1] + (tip[1] - hand[1]) * j / 6, hand[2] + (tip[2] - hand[2]) * j / 6]);
    if (prevTip) for (let j = 1; j < 4; j++) samples.push([prevTip[0] + (tip[0] - prevTip[0]) * j / 4, prevTip[1] + (tip[1] - prevTip[1]) * j / 4, prevTip[2] + (tip[2] - prevTip[2]) * j / 4]);
    let best = 9, at = tip;
    for (const q of samples) for (let k = 0; k < bones.length; k += 13) { const d = capsuleDist(bones, k, q); if (d < best) { best = d; at = q; } }
    return { hit: best <= 0.3 + 0.15 * scale, at, best };
}
