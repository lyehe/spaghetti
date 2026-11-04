// Pure grid/collision helpers (no engine dependency) shared by the game, the worm worker and tests.
import { MAP, CELL, WALL_H } from './map.js';

export class Grid {
    constructor(rows = MAP, cell = CELL, wallH = WALL_H) {
        this.CELL = cell;
        this.WALL_H = wallH;
        this.w = rows[0].length;
        this.h = rows.length;
        this.cells = new Uint8Array(this.w * this.h);
        this.marks = {};
        for (let z = 0; z < this.h; z++) {
            for (let x = 0; x < this.w; x++) {
                const ch = rows[z][x];
                this.cells[z * this.w + x] = ch === '#' ? 1 : 0;
                if (ch !== '#' && ch !== '.') this.marks[ch] = [x, z];
            }
        }
        this.buildPillars();
    }

    // Square columns standing against the walls at intervals, like the reference corridors.
    // Each pillar lives inside one open cell: PILLAR_W wide along the wall, PILLAR_D deep into the cell.
    buildPillars() {
        const W = 0.7, D = 0.5, C = this.CELL;
        this.pillars = [];                                   // [minX, minZ, maxX, maxZ]
        this.cellPillar = new Int16Array(this.w * this.h).fill(-1);
        const marked = new Set(Object.values(this.marks).map(([x, z]) => z * this.w + x));
        for (let z = 0; z < this.h; z++) {
            for (let x = 0; x < this.w; x++) {
                if (this.isWall(x, z) || marked.has(z * this.w + x)) continue;
                if ((x * 7 + z * 3) % 5 !== 0) continue;
                const x0 = x * C, z0 = z * C, mx = x0 + C / 2, mz = z0 + C / 2;
                let box = null;
                if (this.isWall(x, z - 1)) box = [mx - W / 2, z0, mx + W / 2, z0 + D];
                else if (this.isWall(x, z + 1)) box = [mx - W / 2, z0 + C - D, mx + W / 2, z0 + C];
                else if (this.isWall(x - 1, z)) box = [x0, mz - W / 2, x0 + D, mz + W / 2];
                else if (this.isWall(x + 1, z)) box = [x0 + C - D, mz - W / 2, x0 + C, mz + W / 2];
                if (!box) continue;
                this.cellPillar[z * this.w + x] = this.pillars.length;
                this.pillars.push(box);
            }
        }
    }

    pillarIn(cx, cz) {
        if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return null;
        const i = this.cellPillar[cz * this.w + cx];
        return i < 0 ? null : this.pillars[i];
    }

    // rebuild from serialized data (worker side)
    static fromData({ w, h, cells, CELL: c, WALL_H: wh, pillars = [], cellPillar = null, heights = null, nav = null, ground = null }) {
        const g = Object.create(Grid.prototype);
        g.w = w; g.h = h; g.cells = cells; g.CELL = c; g.WALL_H = wh; g.marks = {};
        g.heights = heights; g.nav = nav; g.ground = ground;
        g.pillars = pillars;
        g.cellPillar = cellPillar || new Int16Array(w * h).fill(-1);
        return g;
    }

    toData() {
        return { w: this.w, h: this.h, cells: this.cells, CELL: this.CELL, WALL_H: this.WALL_H, pillars: this.pillars, cellPillar: this.cellPillar, heights: this.heights || null, nav: this.nav || null, ground: this.ground || null };
    }

    cellCenter(x, z) { return { x: (x + 0.5) * this.CELL, y: 0, z: (z + 0.5) * this.CELL }; }

    // y (optional): a low obstacle (table, counter) only blocks below its top
    isWall(cx, cz, y) {
        if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return true;
        const i = cz * this.w + cx;
        if (this.cells[i] !== 1) return false;
        return y === undefined || !this.heights || y < this.heights[i];
    }

    // walkable ground height (outdoor terrain), bilinear between cell centres; 0 on flat floors
    groundAt(x, z) {
        const G = this.ground;
        if (!G) return 0;
        const C = this.CELL, fx = x / C - 0.5, fz = z / C - 0.5;
        const x0 = Math.max(0, Math.min(this.w - 1, Math.floor(fx))), z0 = Math.max(0, Math.min(this.h - 1, Math.floor(fz)));
        const x1 = Math.min(this.w - 1, x0 + 1), z1 = Math.min(this.h - 1, z0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0)), tz = Math.max(0, Math.min(1, fz - z0));
        const a = G[z0 * this.w + x0], b = G[z0 * this.w + x1], c = G[z1 * this.w + x0], d = G[z1 * this.w + x1];
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    }

    // top of the obstacle in a cell (0 for open floor, WALL_H for full walls / outside)
    heightAt(cx, cz) {
        if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return this.WALL_H;
        const i = cz * this.w + cx;
        return this.cells[i] !== 1 ? (this.ground ? this.ground[i] : 0) : this.heights ? this.heights[i] : this.WALL_H;
    }

    // walkable for path finding: nav is the wall mask grown by a body radius (spaces), else walls
    isBlocked(cx, cz) {
        if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return true;
        return this.nav ? this.nav[cz * this.w + cx] === 1 : this.cells[cz * this.w + cx] === 1;
    }

    isWallAt(x, z, y) {
        const cx = Math.floor(x / this.CELL), cz = Math.floor(z / this.CELL);
        if (this.isWall(cx, cz, y)) return true;
        const p = this.pillarIn(cx, cz);
        return !!p && x > p[0] && x < p[2] && z > p[1] && z < p[3];
    }

    // push a circle out of an axis-aligned box; returns true if it overlapped
    static pushBox(pos, r, minX, minZ, maxX, maxZ) {
        const qx = Math.max(minX, Math.min(pos.x, maxX));
        const qz = Math.max(minZ, Math.min(pos.z, maxZ));
        const ddx = pos.x - qx, ddz = pos.z - qz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= r * r) return false;
        if (d2 > 1e-8) {
            const d = Math.sqrt(d2), push = (r - d) / d;
            pos.x += ddx * push; pos.z += ddz * push;
        } else {
            const opts = [[minX - r - pos.x, 0], [maxX + r - pos.x, 0], [0, minZ - r - pos.z], [0, maxZ + r - pos.z]];
            opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
            pos.x += opts[0][0]; pos.z += opts[0][1];
        }
        return true;
    }

    // Push a circle (XZ) out of walls. Mutates pos {x,z}. Returns true if hit.
    collideCircle(pos, r) {
        const C = this.CELL;
        let cx = Math.floor(pos.x / C), cz = Math.floor(pos.z / C);
        let hit = false;
        // centre inside a solid cell (fine grids, deep penetration): jump just inside the nearest open cell
        if (this.isWall(cx, cz)) {
            let best = null, bd = Infinity;
            for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
                const gx = cx + dx, gz = cz + dz;
                if (this.isWall(gx, gz)) continue;
                const e = 1e-3;
                const qx = Math.max(gx * C + e, Math.min(pos.x, gx * C + C - e)), qz = Math.max(gz * C + e, Math.min(pos.z, gz * C + C - e));
                const d = (qx - pos.x) ** 2 + (qz - pos.z) ** 2;
                if (d < bd) { bd = d; best = [qx, qz]; }
            }
            if (best) { pos.x = best[0]; pos.z = best[1]; hit = true; }
        }
        // push away from the nearest solid point until clear (handles circles larger than a cell)
        const R = Math.max(1, Math.ceil(r / C));
        for (let iter = 0; iter < 4; iter++) {
            cx = Math.floor(pos.x / C); cz = Math.floor(pos.z / C);
            let bd = r * r, bq = null;
            for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
                const gx = cx + dx, gz = cz + dz;
                let box = null;
                if (this.isWall(gx, gz)) box = [gx * C, gz * C, gx * C + C, gz * C + C];
                else { const p = this.pillarIn(gx, gz); if (p) box = p; }
                if (!box) continue;
                const qx = Math.max(box[0], Math.min(pos.x, box[2])), qz = Math.max(box[1], Math.min(pos.z, box[3]));
                const d = (pos.x - qx) ** 2 + (pos.z - qz) ** 2;
                if (d < bd) { bd = d; bq = [qx, qz, box]; }
            }
            if (!bq) break;
            hit = true;
            const d = Math.sqrt(bd);
            if (d > 1e-6) { const k = (r - d) / d; pos.x += (pos.x - bq[0]) * k; pos.z += (pos.z - bq[1]) * k; }
            else Grid.pushBox(pos, r, ...bq[2]);
        }
        return hit;
    }

    // distance along a ray until it hits wall/floor/ceiling (simple march)
    raycast(o, d, maxDist = 60) {
        let t = 0;
        const step = 0.04;
        while (t < maxDist) {
            const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
            if (y <= this.groundAt(x, z) || y >= this.WALL_H || this.isWallAt(x, z, y)) return t;
            t += step;
        }
        return maxDist;
    }

    // BFS distance field from a world position (creature pathing)
    distanceField(fromPos) {
        const w = this.w, h = this.h;
        let sx = Math.floor(fromPos.x / this.CELL), sz = Math.floor(fromPos.z / this.CELL);
        // standing right against an obstacle: start from the nearest walkable cell
        if (this.isBlocked(sx, sz)) {
            let best = null, bd = 1e9;
            for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (!this.isBlocked(sx + dx, sz + dz) && dx * dx + dz * dz < bd) { bd = dx * dx + dz * dz; best = [sx + dx, sz + dz]; }
            if (best) [sx, sz] = best;
        }
        const key = sz * w + sx;
        this._dcache ||= new Map();
        const hit = this._dcache.get(key);
        if (hit) { this._dcache.delete(key); this._dcache.set(key, hit); return hit; }
        const dist = new Int32Array(w * h);
        dist.fill(-1);
        if (this._dcache.size > 96) this._dcache.delete(this._dcache.keys().next().value);
        this._dcache.set(key, dist);
        if (this.isBlocked(sx, sz)) return dist;
        const q = this._q && this._q.length === w * h ? this._q : (this._q = new Int32Array(w * h));
        let head = 0, tail = 0;
        q[tail++] = sz * w + sx;
        dist[sz * w + sx] = 0;
        while (head < tail) {
            const c = q[head++], x = c % w, z = (c / w) | 0;
            for (let k = 0; k < 4; k++) {
                const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
                if (this.isBlocked(nx, nz)) continue;
                const ni = nz * w + nx;
                if (dist[ni] !== -1) continue;
                dist[ni] = dist[c] + 1;
                q[tail++] = ni;
            }
        }
        return dist;
    }
}
