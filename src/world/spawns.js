// Spawn points: open, reachable cells far from `from` (path distance) and from each other,
// away from the ragged edge of the capture.
export function farCells(level, from, minDist, count, avoid = []) {
    const dist = level.distanceField(from);
    const C = level.CELL, out = [], cells = [];
    for (let z = 0; z < level.h; z++) for (let x = 0; x < level.w; x++) {
        const d = dist[z * level.w + x];
        const inner = x * C > 2.5 && z * C > 2.5 && x * C < level.w * C - 2.5 && z * C < level.h * C - 2.5;
        if (inner && d * C >= minDist && !level.isBlocked(x, z)) cells.push({ x: (x + 0.5) * C, y: 0, z: (z + 0.5) * C, d });
    }
    cells.sort((a, b) => b.d - a.d);
    for (const c of cells) {
        if (out.length >= count) break;
        if ([...out, ...avoid].every(o => Math.hypot(o.x - c.x, o.z - c.z) > 2.2)) out.push(c);
    }
    return out;
}
