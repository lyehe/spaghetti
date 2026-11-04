// Collision meshes for the splat spaces (pure, no engine dependency: used by the game, workers and tests).
//
// A space's collision is an ordinary triangle mesh (floor, walls, counters, tables...), y-up, metres,
// laid out in the +x/+z quadrant. The mesh is authoritative:
//   - camera / projectile rays are cast against the triangles themselves
//   - characters and worms use a fine occupancy grid rasterized from the mesh (fast circle tests,
//     path finding), where each blocked cell also remembers how tall its obstacle is
import { Grid } from './grid.js';

export class CollisionMesh {
    constructor(positions, indices) {
        this.pos = positions instanceof Float32Array ? positions : new Float32Array(positions);
        this.idx = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
        const p = this.pos;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
        this.min = min; this.max = max;
        this.buildBins();
    }

    get triCount() { return this.idx.length / 3; }

    // uniform XZ bins of triangle ids, so a ray only tests triangles near its path
    buildBins(B = 1) {
        this.B = B;
        this.bw = Math.max(1, Math.ceil((this.max[0] - this.min[0]) / B) + 1);
        this.bh = Math.max(1, Math.ceil((this.max[2] - this.min[2]) / B) + 1);
        const bins = Array.from({ length: this.bw * this.bh }, () => []);
        const p = this.pos, I = this.idx;
        for (let t = 0; t < I.length; t += 3) {
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let k = 0; k < 3; k++) { const o = I[t + k] * 3; x0 = Math.min(x0, p[o]); x1 = Math.max(x1, p[o]); z0 = Math.min(z0, p[o + 2]); z1 = Math.max(z1, p[o + 2]); }
            const bx0 = this.binX(x0), bx1 = this.binX(x1), bz0 = this.binZ(z0), bz1 = this.binZ(z1);
            for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) bins[bz * this.bw + bx].push(t);
        }
        this.bins = bins.map(b => Int32Array.from(b));
        this.stamp = new Uint32Array(I.length / 3);
        this.ray = 0;
    }
    binX(x) { return Math.max(0, Math.min(this.bw - 1, Math.floor((x - this.min[0]) / this.B))); }
    binZ(z) { return Math.max(0, Math.min(this.bh - 1, Math.floor((z - this.min[2]) / this.B))); }

    // Möller–Trumbore; returns t or Infinity
    rayTri(t, o, d) {
        const p = this.pos, I = this.idx;
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
        const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) return Infinity;
        const inv = 1 / det;
        const tx = o.x - p[a], ty = o.y - p[a + 1], tz = o.z - p[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) return Infinity;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
        if (v < 0 || u + v > 1) return Infinity;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        return tt > 1e-5 ? tt : Infinity;
    }

    // distance along a (unit) ray to the first triangle, or maxDist
    raycast(o, d, maxDist = 60) {
        this.ray = (this.ray + 1) >>> 0;
        if (this.ray === 0) { this.stamp.fill(0); this.ray = 1; }
        let best = maxDist;
        // walk the bins the segment passes through (sampled at half a bin)
        const steps = Math.ceil(maxDist / (this.B * 0.5)) + 1;
        let lastBin = -1;
        for (let s = 0; s <= steps; s++) {
            const t = Math.min(maxDist, s * this.B * 0.5);
            if (t > best + this.B) break;
            const bi = this.binZ(o.z + d.z * t) * this.bw + this.binX(o.x + d.x * t);
            const visit = (bin) => {
                const L = this.bins[bin];
                for (let i = 0; i < L.length; i++) {
                    const tri = L[i], id = tri / 3;
                    if (this.stamp[id] === this.ray) continue;
                    this.stamp[id] = this.ray;
                    const h = this.rayTri(tri, o, d);
                    if (h < best) best = h;
                }
            };
            if (bi !== lastBin) {
                // include the 3x3 neighbourhood so diagonal crossings are not missed
                const bx = bi % this.bw, bz = (bi / this.bw) | 0;
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                    const x = bx + dx, z = bz + dz;
                    if (x >= 0 && z >= 0 && x < this.bw && z < this.bh) visit(z * this.bw + x);
                }
                lastBin = bi;
            }
        }
        return best;
    }

    // Rasterize into an occupancy grid. A cell is blocked when mesh surface passes through the
    // body band [walkLo, walkHi] above the local ground; its height is the top of what blocks it.
    // terrain: the ground is not flat (outdoor captures). The walkable ground of each cell is the
    // lowest roughly-horizontal surface in it; raised beds / curbs higher than maxStep above their
    // neighbours become obstacles. Without terrain the floor is the plane y = 0.
    toGrid({ cell = 0.25, walkLo = 0.3, walkHi = 1.8, wallH = 2.6, navRadius = 0.3, start = null, terrain = false, maxStep = 0.35 } = {}) {
        const w = Math.max(1, Math.ceil(this.max[0] / cell)), h = Math.max(1, Math.ceil(this.max[2] / cell));
        const cells = new Uint8Array(w * h), heights = new Float32Array(w * h).fill(-Infinity);
        const ground = new Float32Array(w * h);
        const p = this.pos, I = this.idx, step = cell / 3;
        const sample = (fn) => {
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
                const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
                const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
                const flat = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1) > 0.8;
                const nu = Math.max(1, Math.ceil(Math.hypot(...e1) / step)), nv = Math.max(1, Math.ceil(Math.hypot(...e2) / step));
                for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
                    const u = i / nu, v = j / nv;
                    if (u + v > 1 + 1e-6) continue;
                    const x = p[a] + e1[0] * u + e2[0] * v, z = p[a + 2] + e1[2] * u + e2[2] * v;
                    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
                    if (cx < 0 || cz < 0 || cx >= w || cz >= h) continue;
                    fn(cz * w + cx, p[a + 1] + e1[1] * u + e2[1] * v, flat);
                }
            }
        };
        const raised = new Uint8Array(w * h);
        if (terrain) {
            ground.fill(Infinity);
            sample((i, y, flat) => { if (flat && y < ground[i]) ground[i] = y; });
            // cells without any floor (under dense bushes / canopy): borrow from neighbours
            for (let pass = 0; pass < 64; pass++) {
                let missing = 0;
                const g2 = ground.slice();
                for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
                    const i = z * w + x;
                    if (ground[i] !== Infinity) continue;
                    let sum = 0, n = 0;
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const X = x + dx, Z = z + dz;
                        if (X < 0 || Z < 0 || X >= w || Z >= h || ground[Z * w + X] === Infinity) continue;
                        sum += ground[Z * w + X]; n++;
                    }
                    if (n) g2[i] = sum / n; else missing++;
                }
                ground.set(g2);
                if (!missing) break;
            }
            for (let i = 0; i < w * h; i++) if (ground[i] === Infinity) ground[i] = 0;
            // a step up of more than maxStep (planter edges, benches, curbs) is an obstacle
            for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
                const i = z * w + x;
                let lo = ground[i];
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                    const X = x + dx, Z = z + dz;
                    if (X >= 0 && Z >= 0 && X < w && Z < h) lo = Math.min(lo, ground[Z * w + X]);
                }
                if (ground[i] - lo > maxStep) raised[i] = 1;
            }
        }
        sample((i, y) => {
            const rel = y - ground[i];
            if (rel >= walkLo && rel <= walkHi) cells[i] = 1;
            if (rel < wallH - 0.1 && y > heights[i]) heights[i] = y;
        });
        for (let i = 0; i < w * h; i++) {
            if (raised[i]) cells[i] = 1;
            if (!cells[i]) { heights[i] = ground[i]; continue; }
            const rel = heights[i] - ground[i];
            if (terrain) heights[i] = raised[i] ? Math.max(heights[i], ground[i]) : ground[i] + Math.max(walkLo, rel);
            else heights[i] = rel >= walkHi ? wallH : Math.max(walkLo, rel);
        }
        const g = Grid.fromData({ w, h, cells, CELL: cell, WALL_H: wallH, heights, ground: terrain ? ground : null });
        // anything the player cannot walk to (behind walls, inside furniture) becomes solid
        if (start) {
            const seen = new Uint8Array(w * h), q = [];
            const sx = Math.floor(start.x / cell), sz = Math.floor(start.z / cell);
            if (sx >= 0 && sz >= 0 && sx < w && sz < h && !cells[sz * w + sx]) { seen[sz * w + sx] = 1; q.push(sz * w + sx); }
            while (q.length) {
                const c = q.pop(), x = c % w, z = (c / w) | 0;
                for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
                    if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                    const n = nz * w + nx;
                    if (seen[n] || cells[n]) continue;
                    seen[n] = 1; q.push(n);
                }
            }
            for (let i = 0; i < w * h; i++) if (!cells[i] && !seen[i]) { cells[i] = 1; heights[i] = terrain ? ground[i] + walkLo : wallH; }
        }
        // path-finding mask: obstacles grown by a body radius so monsters don't plan through gaps they can't fit
        const R = Math.max(1, Math.round(navRadius / cell)), nav = new Uint8Array(w * h);
        for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
            if (!cells[z * w + x]) continue;
            for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
                if (dx * dx + dz * dz > R * R + R) continue;     // R = 1: include diagonals (corner clearance)
                const nx = x + dx, nz = z + dz;
                if (nx >= 0 && nz >= 0 && nx < w && nz < h) nav[nz * w + nx] = 1;
            }
        }
        // Growing obstacles can seal off a squeeze between furniture that a body can still get
        // through. Reconnect every walkable pocket to the main area along the open (ungrown) cells.
        const N4 = (c) => { const x = c % w, z = (c / w) | 0, o = []; if (x > 0) o.push(c - 1); if (x < w - 1) o.push(c + 1); if (z > 0) o.push(c - w); if (z < h - 1) o.push(c + w); return o; };
        const label = () => {
            const lab = new Int32Array(w * h).fill(-1), sizes = [];
            for (let i = 0; i < w * h; i++) {
                if (nav[i] || lab[i] >= 0) continue;
                const id = sizes.length, q = [i]; lab[i] = id; let n = 0;
                while (q.length) { const c = q.pop(); n++; for (const nb of N4(c)) if (!nav[nb] && lab[nb] < 0) { lab[nb] = id; q.push(nb); } }
                sizes.push(n);
            }
            return { lab, sizes };
        };
        for (let iter = 0; iter < 32; iter++) {
            const { lab, sizes } = label();
            if (sizes.length < 2) break;
            const si = start ? Math.floor(start.z / cell) * w + Math.floor(start.x / cell) : -1;
            const main = si >= 0 && lab[si] >= 0 ? lab[si] : sizes.indexOf(Math.max(...sizes));
            const pocket = sizes.findIndex((n, id) => id !== main && n >= 6);
            if (pocket < 0) break;
            // BFS from the pocket through open cells until the main area is reached, then open that path
            const prev = new Int32Array(w * h).fill(-2), q = [];
            for (let i = 0; i < w * h; i++) if (lab[i] === pocket) { prev[i] = -1; q.push(i); }
            let hit = -1;
            for (let qi = 0; qi < q.length && hit < 0; qi++) {
                for (const nb of N4(q[qi])) {
                    if (prev[nb] !== -2 || cells[nb]) continue;
                    prev[nb] = q[qi];
                    if (lab[nb] === main) { hit = nb; break; }
                    q.push(nb);
                }
            }
            if (hit < 0) { for (let i = 0; i < w * h; i++) if (lab[i] === pocket) nav[i] = 1; continue; }   // truly sealed: drop it
            // open the squeeze: the path itself plus any furniture right beside it (splat noise
            // usually), so a body really fits through — full-height walls are kept
            for (let c = hit; c >= 0; c = prev[c]) {
                nav[c] = 0;
                const x = c % w, z = (c / w) | 0;
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, nz = z + dz;
                    if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                    const n = nz * w + nx;
                    if (cells[n] && !raised[n] && heights[n] - ground[n] < (terrain ? walkHi : wallH - 1e-3)) { cells[n] = 0; heights[n] = ground[n]; }
                }
            }
        }
        g.nav = nav;
        return g;
    }

    // the walkable cells (nav-free) as world positions, for spawning
    static openCells(grid) {
        const out = [];
        for (let z = 0; z < grid.h; z++) for (let x = 0; x < grid.w; x++) if (!grid.isBlocked(x, z)) out.push([x, z]);
        return out;
    }
}

// --- a tiny mesh builder for procedural spaces (used by the fallback kitchen and tests)
export class MeshBuilder {
    constructor() { this.p = []; this.i = []; }
    quad(a, b, c, d) {
        const n = this.p.length / 3;
        this.p.push(...a, ...b, ...c, ...d);
        this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    // axis-aligned box [x0,y0,z0]-[x1,y1,z1], faces outward
    box(x0, y0, z0, x1, y1, z1) {
        this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);   // top
        this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);   // bottom
        this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);   // +z
        this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);   // -z
        this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);   // +x
        this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);   // -x
    }
    mesh() { return new CollisionMesh(this.p, this.i); }
    toJSON() { return { positions: this.p, indices: this.i }; }
}

// OBJ text -> CollisionMesh (so a collision mesh can be authored / fixed up in Blender)
export function parseOBJ(text) {
    const p = [], idx = [];
    for (const line of text.split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t[0] === 'v') p.push(+t[1], +t[2], +t[3]);
        else if (t[0] === 'f') {
            const f = t.slice(1).map(s => { const k = parseInt(s, 10); return k < 0 ? p.length / 3 + k : k - 1; });
            for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
        }
    }
    return new CollisionMesh(p, idx);
}

// --- a procedural fallback room (also the test fixture): Nonna Rosa's kitchen, 12 x 10 m
export function proceduralKitchen() {
    const b = new MeshBuilder(), W = 12, D = 10, H = 2.8, t = 0.2;
    b.quad([0, 0, 0], [0, 0, D], [W, 0, D], [W, 0, 0]);                  // floor
    b.box(0, 0, 0, W, H, t); b.box(0, 0, D - t, W, H, D);                // walls
    b.box(0, 0, 0, t, H, D); b.box(W - t, 0, 0, W, H, D);
    b.box(t, 0, t, 5.5, 0.92, 0.85);                                     // counter along the back wall
    b.box(W - 0.85, 0, 2.5, W - t, 0.92, 7.5);                           // counter on the right
    b.box(4.6, 0, 4.2, 7.2, 0.76, 5.6);                                  // the big dining table
    b.box(1.6, 0, 6.6, 2.4, 1.0, 7.4);                                   // a stove island
    b.box(8.4, 0, 8.4, 9.0, 2.1, 9.8 - t);                               // a tall fridge
    b.box(2.6, 0, 2.6, 3.0, H, 3.0);                                     // a column
    return b.mesh();
}
