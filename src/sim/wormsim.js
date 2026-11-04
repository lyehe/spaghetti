// Worm swarm physics. Pure JS (no engine), runs in a Web Worker, inline, or under node tests.
//
// Each worm is a chain of P points integrated with Verlet + position-based constraints:
//   - stretch + soft bend constraints (an elastic rod)
//   - an internal traveling muscle wave in the worm's own frame (momentum conserving -> writhing)
//   - anisotropic ground friction (slides along its length, grips sideways) -> real crawling
//   - worm/worm collisions through a spatial hash on every other point (piles stack)
//   - wall/ceiling adhesion: a worm can glue one point to a surface and hang from it
// Worms are BOUND to the creature's bone capsules, FREE (ballistic), CLING (glued), or RETURN
// (crawling back and climbing up the body, which is rebuilt bottom-up).

export const P = 20;   // points per worm
export const S = 8;    // tube sides
export const BONE_STRIDE = 13;

export const BOUND = 0, FREE = 1, CLING = 2, RETURN = 3, EATEN = 4, SLURP = 5;

const G = 9.8;
const ITER = 4;
const HASH_BITS = 16, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1;
const CELL_H = 0.11;   // collision hash cell (>= max collision diameter)

function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class WormSim {
    // style: 'worm' (maroon worms) or 'pasta' (sauced spaghetti). scale: monster size multiplier.
    // squishy: softer stretch + squash-and-stretch thickness.
    constructor({ count = 900, grid, bones, coreBones = [0, 1], boneWeights = null, seed = 1, bodyCollisions = true,
                  style = 'worm', scale = 1, squishy = false }) {
        this.style = style;
        this.scale = scale;
        this.squishy = squishy;
        this.mouth = new Float32Array([0, -100, 0]);   // where slurped strands are pulled to (set by the game)
        // the fork the hero eats with: tine tip, handle axis (toward the tip), tine plane side, roll (rad)
        this.fork = new Float32Array([0, -100, 0, 0, 1, 0, 1, 0, 0, 0]);
        this.fist = new Float32Array([0, -100, 0]);    // the hero's left palm
        this.bodyCollisions = bodyCollisions;   // body worms push each other apart (costs ~3ms/step)
        this.N = count;
        this.grid = grid;
        this.rand = mulberry32(seed);
        this.bones = new Float32Array(bones);
        this.boneCount = bones.length / BONE_STRIDE;
        this.coreBones = coreBones;
        this.boneWeights = boneWeights || new Array(this.boneCount).fill(1);
        this.creature = { x: 0, z: 0, walking: true, speed: 0 };
        const N = count, NP = N * P;

        this.pos = new Float32Array(NP * 3);
        this.prev = new Float32Array(NP * 3);
        this.prad = new Float32Array(NP);       // per-point tube radius
        this.ao = new Float32Array(NP).fill(1);
        this.nb = new Uint8Array(NP);           // neighbor counts from collisions (for AO)
        this.floorC = new Uint8Array(NP);

        this.state = new Uint8Array(N);
        this.timer = new Float32Array(N);
        this.retTime = new Float32Array(N);
        this.sticky = new Uint8Array(N);
        // adhesion: any point of a sticky worm that hits a wall/ceiling glues there, then peels off
        this.stuckPt = new Uint8Array(NP);       // 0 free, 1 on ceiling, 2 on wall
        this.stuckPos = new Float32Array(NP * 3);
        this.stuckN = new Uint8Array(N);         // number of stuck points per worm
        this.stickMax = new Uint8Array(N).fill(5); // how much of its length a worm glues down
        this.leader = new Uint8Array(N);
        this.ghost = new Float32Array(N);
        this.climb = new Uint8Array(N);
        this.gate = new Float32Array(N);        // per-worm jitter of the height at which its slot unlocks
        this.bindAge = new Float32Array(N).fill(10);   // seconds since (re)binding: tail pull eases in        // climbing worms burrow into the bound mass      // seconds left slipping through the bound mass
        this.bone = new Uint8Array(N);
        this.tA = new Float32Array(N); this.tB = new Float32Array(N);
        this.angA = new Float32Array(N); this.angB = new Float32Array(N);
        this.crawl = new Float32Array(N);
        this.layer = new Float32Array(N);
        this.tail = new Uint8Array(N);
        this.train = new Uint8Array(N);        // hip worms that drag behind on the floor
        this.rad = new Float32Array(N);
        this.seg = new Float32Array(N);
        this.phase = new Float32Array(N);
        this.wfreq = new Float32Array(N);
        this.wk = new Float32Array(N);
        this.curl = new Float32Array(N);       // rest bend per segment (rad): worms hold loose S-curves
        this.ref = new Float32Array(N * 3);     // slowly rotating reference for the wave plane
        this.colA = new Float32Array(N * 3);
        this.coat = new Float32Array(N);       // pasta: how much tomato sauce coats this strand
        this.slurpN = new Uint8Array(N);       // pasta: how many points of the strand are pinned (eaten, or wound on the fork / in the fist)
        this.slurpA = new Uint8Array(N);       // ... to which anchor: 0 mouth, 1 fork tines, 2 left fist
        this.slurpRate = new Float32Array(N);  // how fast the mouth sucks this strand in (m/s)
        this.anchorA = new Float32Array(N * 3);
        this.anchorB = new Float32Array(N * 3);
        this.anchorV = new Float32Array(N * 3);   // anchor displacement per step (body motion at the attachment)

        // collision hash (every other point is a collision sphere)
        this.NC = N * (P >> 1);
        this.hashCount = new Int32Array(HASH_SIZE);
        this.hashStart = new Int32Array(HASH_SIZE + 1);
        this.hashItems = new Int32Array(this.NC);
        this.itemHash = new Int32Array(this.NC);

        this.time = 0;
        this.shedT = 0;
        this.boundCount = N;
        this.teleports = 0;
        this.holding = false;
        this.reforming = false;
        this.buildH = 10;            // only anchors below this height can be (re)bound

        this.profile = new Float32Array(P);
        this.band = new Float32Array(P);
        for (let i = 0; i < P; i++) {
            const u = i / (P - 1);
            let r = u < 0.08 ? 0.5 + u / 0.08 * 0.45 : 1 - Math.pow(Math.max(0, u - 0.45) / 0.55, 1.6) * 0.72;
            if (u > 0.98) r = 0.22;
            const clit = Math.exp(-Math.pow((u - 0.28) / 0.06, 2));
            this.profile[i] = r * (1 + 0.18 * clit);
            this.band[i] = clit;
        }

        this.assignAnchors();
        this.placeAll();
    }

    // ------------------------------------------------------------ setup
    assignAnchors() {
        const bd = this.bones, R = this.rand;
        const weights = [];
        let total = 0;
        const lens = [];
        for (let b = 0; b < this.boneCount; b++) {
            const k = b * BONE_STRIDE;
            const len = Math.hypot(bd[k + 3] - bd[k], bd[k + 4] - bd[k + 1], bd[k + 5] - bd[k + 2]) || 0.3;
            lens.push(len);
            const w = len * (bd[k + 12] + 0.08) * this.boneWeights[b];
            weights.push(w); total += w;
        }
        for (let w = 0; w < this.N; w++) {
            let r = R() * total, b = 0;
            while (r > weights[b] && b < weights.length - 1) { r -= weights[b]; b++; }
            this.bone[w] = b;
            if (this.style === 'pasta') {
                this.rad[w] = (0.011 + R() * 0.004) * Math.sqrt(this.scale);   // fat monster spaghetti
                this.seg[w] = (0.045 + R() * 0.025) * this.scale;
            } else {
                this.rad[w] = 0.016 + R() * 0.009;            // 3.2 - 5 cm thick
                this.seg[w] = 0.05 + R() * 0.03;              // 0.95 - 1.5 m long
            }
            const hipBone = b === 0 || b === 9 || b === 12;
            this.train[w] = hipBone && R() < 0.45 ? 1 : 0;
            if (this.train[w]) this.seg[w] *= 1.25;
            const reach = Math.min(0.9, (0.45 * this.seg[w] * (P - 1)) / lens[b]) * (R() < 0.5 ? -1 : 1);
            this.tA[w] = this.train[w] && b === 0 ? R() * 0.25 : R();
            let tb = this.tA[w] + reach;
            if (tb < 0 || tb > 1) tb = this.tA[w] - reach;
            tb = Math.min(1, Math.max(0, tb));
            this.tB[w] = tb;
            const tooShort = Math.abs(tb - this.tA[w]) < Math.abs(reach) * 0.6;
            // drapery: most worms hang like long hair; a few wrap limbs or curl off the head
            const headish = b === 1 || b === 2;
            this.tail[w] = (!tooShort && !this.train[w] && b !== 2 && R() < (headish ? 0.2 : 0.12)) ? 1 : 0;   // head worms hang like hair, no loops over the top
            this.angA[w] = this.train[w] ? Math.PI / 2 + (R() - 0.5) * 1.4 : R() * Math.PI * 2;   // train hangs off the back
            this.angB[w] = this.angA[w] + (1.5 + R() * 1.5) * (R() < 0.5 ? -1 : 1);
            this.crawl[w] = this.train[w] ? 0.05 : 0.08 + R() * 0.12;      // sway amplitude (rad)
            this.layer[w] = R() * 0.07;
            this.phase[w] = R() * 100;
            this.wfreq[w] = 2.5 + R() * 3.5;                  // rad/s of the muscle wave
            this.wk[w] = 0.32 + R() * 0.22;                   // wave number per point (long smooth bends)
            this.curl[w] = 0.32 + R() * 0.28;
            this.gate[w] = (R() - 0.65) * 0.55;   // mostly early unlocks: uneven front without stalling the tail
            this.sticky[w] = R() < 0.45 ? 1 : 0;
            this.stickMax[w] = 3 + ((R() * 6) | 0);
            let dx = R() - 0.5, dy = R() - 0.5, dz = R() - 0.5;
            const l = Math.hypot(dx, dy, dz) || 1;
            this.ref[w * 3] = dx / l; this.ref[w * 3 + 1] = dy / l; this.ref[w * 3 + 2] = dz / l;
            // wet mauve-maroon (linear); pinker where lit, near-black deep in the mass
            const v = 0.75 + R() * 0.5, pink = R();
            this.colA[w * 3] = (0.075 + 0.035 * R()) * v;
            this.colA[w * 3 + 1] = (0.01 + 0.012 * pink) * v;
            this.colA[w * 3 + 2] = (0.026 + 0.022 * pink) * v;
            if (this.style === 'pasta') {
                // cooked durum pasta (linear), coated in varying amounts of tomato sauce
                const pv = 0.8 + R() * 0.35;
                this.colA[w * 3] = 0.58 * pv; this.colA[w * 3 + 1] = 0.36 * pv; this.colA[w * 3 + 2] = 0.09 * pv;
                this.coat[w] = 0.3 + R() * 0.65;
            }
            for (let i = 0; i < P; i++) this.prad[w * P + i] = this.rad[w] * this.profile[i];
        }
    }

    anchor(w, t, ang, out, o) {
        const bd = this.bones, k = this.bone[w] * BONE_STRIDE, ph = this.phase[w], tm = this.time;
        // sway in place (bounded), never a continuous orbit around the bone
        const a = ang + Math.sin(tm * 0.45 + ph) * this.crawl[w] + Math.sin(tm * 1.1 + ph * 1.7) * 0.06;
        const tt = Math.min(1, Math.max(0, t + Math.sin(tm * 0.5 + ph) * 0.03));
        const ca = Math.cos(a), sa = Math.sin(a);
        const rr = bd[k + 12] + this.layer[w] + this.rad[w];
        out[o] = bd[k] + (bd[k + 3] - bd[k]) * tt + (bd[k + 6] * ca + bd[k + 9] * sa) * rr;
        out[o + 1] = bd[k + 1] + (bd[k + 4] - bd[k + 1]) * tt + (bd[k + 7] * ca + bd[k + 10] * sa) * rr;
        out[o + 2] = bd[k + 2] + (bd[k + 5] - bd[k + 2]) * tt + (bd[k + 8] * ca + bd[k + 11] * sa) * rr;
    }

    placeAll() {
        const A = this.anchorA, B = this.anchorB;
        for (let w = 0; w < this.N; w++) {
            this.state[w] = BOUND;
            this.leader[w] = 0;
            if (this.stuckN[w]) this.unstickAll(w);
            this.anchor(w, this.tA[w], this.angA[w], A, w * 3);
            this.anchor(w, this.tB[w], this.angB[w], B, w * 3);
            let dx = B[w * 3] - A[w * 3], dy = B[w * 3 + 1] - A[w * 3 + 1], dz = B[w * 3 + 2] - A[w * 3 + 2];
            if (!this.tail[w]) { dx = 0; dy = -1; dz = 0; }
            const l = Math.hypot(dx, dy, dz) || 1;
            const base = w * P * 3;
            for (let i = 0; i < P; i++) {
                const o = base + i * 3;
                this.pos[o] = A[w * 3] + dx / l * this.seg[w] * i;
                this.pos[o + 1] = Math.max(this.rad[w], A[w * 3 + 1] + dy / l * this.seg[w] * i);
                this.pos[o + 2] = A[w * 3 + 2] + dz / l * this.seg[w] * i;
                this.prev[o] = this.pos[o]; this.prev[o + 1] = this.pos[o + 1]; this.prev[o + 2] = this.pos[o + 2];
            }
        }
        this.boundCount = this.N;
        this.holding = false;
        this.reforming = false;
        this.buildH = 10;
    }

    get boundFraction() { return this.boundCount / this.N; }

    // lay a worm hanging straight down from its slot, at rest (used when a worm has to be snapped home)
    hangFromSlot(w) {
        const A = this.anchorA, base = w * P * 3;
        for (let i = 0; i < P; i++) {
            const o = base + i * 3;
            this.pos[o] = A[w * 3] + (i & 1 ? 0.01 : -0.01);
            this.pos[o + 1] = Math.max(this.rad[w], A[w * 3 + 1] - this.seg[w] * i);
            this.pos[o + 2] = A[w * 3 + 2];
            this.prev[o] = this.pos[o]; this.prev[o + 1] = this.pos[o + 1]; this.prev[o + 2] = this.pos[o + 2];
        }
    }

    setCreature(bones, x, z, walking, speed) {
        this.bones.set(bones);
        const c = this.creature;
        c.x = x; c.z = z; c.walking = walking; c.speed = speed;
        // bounding sphere per bone for cheap rejection in the body pass
        const bs = this.boneSph || (this.boneSph = new Float32Array(this.boneCount * 4));
        for (let b = 0; b < this.boneCount; b++) {
            const k = b * BONE_STRIDE;
            bs[b * 4] = (bones[k] + bones[k + 3]) * 0.5;
            bs[b * 4 + 1] = (bones[k + 1] + bones[k + 4]) * 0.5;
            bs[b * 4 + 2] = (bones[k + 2] + bones[k + 5]) * 0.5;
            bs[b * 4 + 3] = Math.hypot(bones[k + 3] - bones[k], bones[k + 4] - bones[k + 1], bones[k + 5] - bones[k + 2]) * 0.5 + bones[k + 12] + 0.05;
        }
    }

    // ------------------------------------------------------------ gameplay events
    release(w, vx, vy, vz, timer, spread = 0.4) {
        if (this.state[w] === BOUND) this.boundCount--;
        if (this.stuckN[w]) this.unstickAll(w);
        this.state[w] = FREE;
        this.timer[w] = timer;
        this.leader[w] = 0;
        const base = w * P * 3, R = this.rand, dt = 1 / 60;
        // a little spin along the body so worms tumble instead of translating rigidly
        const sx = (R() - 0.5) * 2.5, sy = (R() - 0.5) * 2.5, sz = (R() - 0.5) * 2.5;
        const f = (1 - spread * 0.5 + R() * spread) * dt;   // one speed for the whole worm: it is knocked as one body
        for (let i = 0; i < P; i++) {
            const o = base + i * 3, u = i / (P - 1) - 0.5;
            this.prev[o] = this.pos[o] - (vx + sx * u) * f;
            this.prev[o + 1] = this.pos[o + 1] - (vy + sy * u) * f;
            this.prev[o + 2] = this.pos[o + 2] - (vz + sz * u) * f;
        }
    }

    // A shot: knocks worms off near the hit point and shoves neighbors (a ripple through the body).
    // anyPoint: a strike knocks off any noodle with any part near the hit (the game's fork), not just
    // ones attached there (the original gun, which only blew away worms at their attachment)
    hit(px, py, pz, dx, dy, dz, radius = 0.5, anyPoint = false) {
        let released = 0;
        const r2 = radius * radius, pushR2 = r2 * 4, R = this.rand;
        for (let w = 0; w < this.N; w++) {
            const base = w * P * 3;
            const st = this.state[w];
            if (st === EATEN || st === SLURP) continue;
            // bound worms come loose where they attach (head); loose worms anywhere along the body
            let best = 1e9;
            for (let i = 0; i < P; i += (st === BOUND && !anyPoint ? P : 3)) {
                const o = base + i * 3;
                const ex = this.pos[o] - px, ey = this.pos[o + 1] - py, ez = this.pos[o + 2] - pz;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < best) best = d2;
            }
            if (best < r2 * (st === BOUND ? 1 : 1.8)) {
                const k = 1 - Math.sqrt(best) / (radius * 1.4);
                const sp = 3 + 7 * k * R();
                if (st === BOUND) { released++; this.ghost[w] = 0.3; }   // slip out of the mass instead of being crushed by it
                this.release(w, dx * sp + (R() - 0.5) * 3.5, dy * sp + R() * 3, dz * sp + (R() - 0.5) * 3.5,
                    this.holding ? 999 : 2 + R() * 3.5);
            } else if (best < pushR2) {
                // shove the surrounding mass
                const k = (1 - Math.sqrt(best / pushR2)) * 1.6 / 60;
                for (let i = 0; i < P; i++) {
                    const o = base + i * 3;
                    this.prev[o] -= dx * k; this.prev[o + 1] -= dy * k; this.prev[o + 2] -= dz * k;
                }
            }
        }
        return released;
    }

    // A fork strike: knock off the n attached noodles nearest the hit point (within maxR), so every
    // landed strike takes a chunk even after that side of the body has been stripped bare.
    chunk(px, py, pz, dx, dy, dz, n, maxR = 1.2) {
        const R = this.rand, cand = [];
        for (let w = 0; w < this.N; w++) {
            if (this.state[w] !== BOUND) continue;
            let best = 1e9;
            for (let i = 0; i < P; i += 3) {
                const o = (w * P + i) * 3;
                const ex = this.pos[o] - px, ey = this.pos[o + 1] - py, ez = this.pos[o + 2] - pz;
                best = Math.min(best, ex * ex + ey * ey + ez * ez);
            }
            if (best < maxR * maxR) cand.push([best, w]);
        }
        cand.sort((a, b) => a[0] - b[0]);
        const k = Math.min(n, cand.length);
        for (let j = 0; j < k; j++) {
            const w = cand[j][1], sp = 2.5 + 4 * R();
            this.release(w, dx * sp + (R() - 0.5) * 3, dy * sp + 1 + R() * 2.5, dz * sp + (R() - 0.5) * 3, this.holding ? 999 : 2.5 + R() * 3.5);
            this.ghost[w] = 0.3;
        }
        return k;
    }

    // The whole body bursts: worms spray outward, many hit walls/ceiling and stick there.
    collapse(dx = 0, dy = 0, dz = 0) {
        this.holding = true;
        this.reforming = false;
        const R = this.rand, cx = this.creature.x, cz = this.creature.z;
        for (let w = 0; w < this.N; w++) {
            if (this.state[w] === EATEN || this.state[w] === SLURP) continue;
            const o = w * P * 3 + (P >> 1) * 3;
            let ox = this.pos[o] - cx, oz = this.pos[o + 2] - cz;
            const ol = Math.hypot(ox, oz) || 1;
            ox /= ol; oz /= ol;
            const h = this.pos[o + 1];
            // most of the mass slumps down and out; a fraction is flung hard (wall/ceiling clingers)
            const violent = R() < 0.22;
            const power = violent ? 3 + R() * 4 : 0.4 + R() * 1.6;
            const up = violent ? 2.5 + R() * 4.5 + h * 0.8 : R() * 0.8;
            if (this.state[w] === BOUND) {
                this.release(w, ox * power + dx * 2, up + dy * 1.5, oz * power + dz * 2, 999, 0.8);
            } else {
                if (this.stuckN[w]) this.unstickAll(w);
                this.state[w] = FREE;
                this.timer[w] = 999;
            }
        }
    }

    reform() {
        this.holding = false;
        this.reforming = true;
        this.buildH = 0.15;
        const R = this.rand, cx = this.creature.x, cz = this.creature.z;
        // the few worms nearest the base rear up first
        const order = [];
        for (let w = 0; w < this.N; w++) {
            if (this.state[w] === BOUND || this.state[w] >= EATEN) continue;
            const o = w * P * 3;
            order.push([Math.hypot(this.pos[o] - cx, this.pos[o + 2] - cz), w]);
            this.state[w] = this.state[w] === CLING ? CLING : FREE;
            this.timer[w] = this.state[w] === CLING ? 0.5 + R() * 2.5 : R() * 0.8;
        }
        order.sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < Math.min(10, order.length); i++) {
            const w = order[i][1];
            this.state[w] = RETURN; this.retTime[w] = 0; this.leader[w] = 1;
        }
    }

    // ------------------------------------------------------------ simulation
    step(dt) {
        this.time += dt;
        const t = this.time, R = this.rand;
        const pos = this.pos, prev = this.prev, prad = this.prad;
        const dt2 = dt * dt;
        const N = this.N;
        const A = this.anchorA, B = this.anchorB;
        const cr = this.creature;

        // walking sheds worms, mostly from the lower body -> trailing carpet
        if (cr.walking && cr.speed > 0.3 && !this.holding && !this.reforming) {
            this.shedT -= dt;
            if (this.shedT <= 0) {
                this.shedT = 0.04 + R() * 0.08;
                for (let tries = 0; tries < 6; tries++) {
                    const w = (R() * N) | 0;
                    const k = this.bone[w] * BONE_STRIDE;
                    if (this.state[w] !== BOUND || this.boundCount < this.N * 0.8) continue;
                    if (this.bones[k + 1] > 1.2 * this.scale && R() > 0.25) continue;
                    const o = w * P * 3 + (P >> 1) * 3;
                    let ox = this.pos[o] - cr.x, oz = this.pos[o + 2] - cr.z;
                    const ol = Math.hypot(ox, oz) || 1;
                    this.release(w, ox / ol * 0.9, -0.5, oz / ol * 0.9, 2.5 + R() * 4.5);
                    this.ghost[w] = 0.8;
                    break;
                }
            }
        }

        // body rebuild height rises once the layer below is mostly filled
        if (this.reforming) {
            // the body fills feet-first at a steady pace; slots above buildH stay locked
            // grows in surges, not like a filling tank
            this.buildH += dt * 0.55 * (0.55 + 0.9 * Math.max(0, Math.sin(t * 2.1)) + 0.3 * Math.sin(t * 5.3));
            if (this.buildH > 2.6) { this.reforming = false; this.buildH = 10; }
        }

        // ---- per-worm state + anchors
        for (let w = 0; w < N; w++) {
            let st = this.state[w];
            if (st === EATEN || st === SLURP) continue;
            if (st === FREE || st === CLING) {
                this.timer[w] -= dt;
                if (this.timer[w] <= 0) {
                    if (st === CLING) { this.unstickAll(w); st = this.state[w] = FREE; this.timer[w] = this.holding ? 999 : 0.5 + R() * 2; }
                    else if (!this.holding) { st = this.state[w] = RETURN; this.retTime[w] = 0; }
                }
            }
            if (st === CLING) {
                this.peelAndSlide(w, dt);
                if (this.stuckN[w] === 0) { st = this.state[w] = FREE; this.timer[w] = this.holding ? 999 : 0.5 + R() * 2; }
            }
            if (st === BOUND || st === RETURN || this.reforming) {
                const ox = A[w * 3], oy = A[w * 3 + 1], oz = A[w * 3 + 2];
                this.anchor(w, this.tA[w], this.angA[w], A, w * 3);
                const AV = this.anchorV;
                AV[w * 3] = A[w * 3] - ox; AV[w * 3 + 1] = A[w * 3 + 1] - oy; AV[w * 3 + 2] = A[w * 3 + 2] - oz;
                if (Math.abs(AV[w * 3]) + Math.abs(AV[w * 3 + 1]) + Math.abs(AV[w * 3 + 2]) > 0.2) { AV[w * 3] = AV[w * 3 + 1] = AV[w * 3 + 2] = 0; }
                if (st === BOUND && this.tail[w]) this.anchor(w, this.tB[w], this.angB[w], B, w * 3);
            }
            if (st === RETURN) this.retTime[w] += dt;
            if (this.ghost[w] > 0) this.ghost[w] -= dt;
            if (st === BOUND && this.bindAge[w] < 10) this.bindAge[w] += dt;
        }

        // ---- integrate with muscle waves
        for (let w = 0; w < N; w++) {
            const st = this.state[w];
            if (st === EATEN) continue;
            const base = w * P * 3;
            const onBody = st === BOUND;
            const damp = onBody ? 0.93 : 0.995;
            // body worms are damped relative to the moving body (internal friction), not the air,
            // so walking doesn't blow them out behind like flags; air drag stays light
            const bvx = onBody ? this.anchorV[w * 3] : 0, bvy = onBody ? this.anchorV[w * 3 + 1] : 0, bvz = onBody ? this.anchorV[w * 3 + 2] : 0;
            const amp = onBody ? 9 : st === RETURN ? 20 : st === CLING ? 24 : 18;
            const ph = this.phase[w], om = this.wfreq[w], kw = this.wk[w];
            // reference vector slowly tumbles so the bending plane keeps changing
            const ra = t * 0.4 + ph;
            let rx = this.ref[w * 3] + Math.sin(ra) * 0.8, ry = this.ref[w * 3 + 1] + Math.cos(ra * 0.7) * 0.8, rz = this.ref[w * 3 + 2] + Math.sin(ra * 1.3) * 0.8;
            const leader = this.leader[w] && st === RETURN;
            // climbing with hysteresis: start within 0.6m of the slot, keep going until 1m away
            const hdA = Math.hypot(pos[base] - A[w * 3], pos[base + 2] - A[w * 3 + 2]);
            const climbing = st === RETURN && hdA < (this.climb[w] ? 1.0 : 0.6);
            this.climb[w] = climbing ? 1 : 0;
            const slotDist = st === RETURN ? Math.hypot(pos[base] - A[w * 3], pos[base + 1] - A[w * 3 + 1], pos[base + 2] - A[w * 3 + 2]) : 1;

            for (let i = 0; i < P; i++) {
                const o = base + i * 3;
                const x = pos[o], y = pos[o + 1], z = pos[o + 2];
                const rel = onBody ? damp + (0.995 - damp) * (i / (P - 1)) : damp;   // tips swing freer
                let vx = bvx + (x - prev[o] - bvx) * rel, vy = bvy + (y - prev[o + 1] - bvy) * rel, vz = bvz + (z - prev[o + 2] - bvz) * rel;
                if (onBody) { vx = vx * 0.998; vz = vz * 0.998; }
                else if (climbing) { vx *= 0.975; vy *= 0.975; vz *= 0.975; }   // gripping climbers barely coast
                if (st === RETURN) {                     // worms crawl and climb at worm speed, not like projectiles
                    const v = Math.hypot(vx, vy, vz), vmax = Math.max(1.2, Math.min(2.2, slotDist * 6)) * dt;   // slow down to settle in
                    if (v > vmax) { const k = vmax / v; vx *= k; vy *= k; vz *= k; }
                }
                prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
                let g = -G;
                if (st === CLING) g = -G;
                else if (leader && i < P * 0.6) g = -G * 0.12;        // stiffened rearing tentacle
                else if (climbing) g = (Math.hypot(x - cr.x, z - cr.z) < 0.45 && y < A[w * 3 + 1]) ? -G * 0.08 : -G;   // grip on the mass below its slot, hang elsewhere
                else if (onBody) g = (this.train[w] || y > A[w * 3 + 1] + 0.05) ? (this.bindAge[w] < 1 ? -G * 2 : -G) : -G * 0.4;   // supported only below the attachment; fresh latchers flop fast
                pos[o] = x + vx;
                pos[o + 1] = y + vy + g * dt2;
                pos[o + 2] = z + vz;
            }

            // internal muscle forces: lateral traveling wave in the worm's own frame.
            // Force on i is balanced by half reactions on i-1 and i+1 (no net momentum).
            for (let i = 1; i < P - 1; i++) {
                const a = base + (i - 1) * 3, o = base + i * 3, b = base + (i + 1) * 3;
                const tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
                let qx = ty * rz - tz * ry, qy = tz * rx - tx * rz, qz = tx * ry - ty * rx;
                const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
                if (ql < 1e-6) continue;
                const f = (Math.sin(kw * i - om * t + ph) + this.curl[w] * 1.5) * amp * dt2 / ql;   // biased wave -> coils (kept below gravity)
                qx *= f; qy *= f; qz *= f;
                pos[o] += qx; pos[o + 1] += qy; pos[o + 2] += qz;
                pos[a] -= qx * 0.5; pos[a + 1] -= qy * 0.5; pos[a + 2] -= qz * 0.5;
                pos[b] -= qx * 0.5; pos[b + 1] -= qy * 0.5; pos[b + 2] -= qz * 0.5;
            }

            // hanging worms: slow S-waves in a slowly turning horizontal plane, ramping up from the
            // attachment (dreadlock-like waves). The balanced muscle wave above only acts through the
            // second difference along the body, which is too weak to shape a long hanging worm.
            if (onBody && !this.train[w]) {
                const pa = ph * 3.1 + t * 0.15, cx = Math.cos(pa), cz = Math.sin(pa);
                const A = 7 * dt2;
                for (let i = 2; i < P; i++) {
                    const o = base + i * 3;
                    const s = Math.sin(0.5 * i - 0.8 * t + ph) * A * (i / P);
                    pos[o] += cx * s; pos[o + 2] += cz * s;
                }
            }

            // peristaltic crawl: grounded segments push the body toward the head in pulses,
            // so the body follows the head's path like a real worm
            if (st === RETURN || (st === FREE && !this.holding)) {
                const thrust = (st === RETURN ? 15 : 1.5) * Math.min(2.5, 1 + this.retTime[w] * 0.3);
                for (let i = 1; i < P; i++) {
                    const o = base + i * 3;
                    // needs ground or worms to push on (climbers grip the mass along their whole body)
                    if (!climbing && pos[o + 1] > 0.35 && this.nb[w * P + i] === 0) continue;
                    const a = o - 3;
                    const dx = pos[a] - pos[o], dz = pos[a + 2] - pos[o + 2];
                    const dy = climbing && pos[o + 1] < A[w * 3 + 1] && Math.hypot(pos[o] - cr.x, pos[o + 2] - cr.z) < 0.45 ? pos[a + 1] - pos[o + 1] : 0;   // only segments on the mass, below the slot, climb
                    const dl = Math.hypot(dx, dy, dz);
                    if (dl < 1e-6) continue;
                    const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(om * 1.6 * t - i * 0.8 + ph));
                    const k = thrust * pulse * dt2 / dl;
                    pos[o] += dx * k; pos[o + 1] += dy * k; pos[o + 2] += dz * k;
                }
            }

            // steering: returning heads pull toward the base / up the column / to their anchor
            if (st === RETURN) {
                const h = base, ax = A[w * 3], ay = A[w * 3 + 1], az = A[w * 3 + 2];
                const hx = pos[h], hy = pos[h + 1], hz = pos[h + 2];
                const boost = 1 + this.retTime[w] * 0.5;
                let tx, ty, tz, acc;
                if (leader) {
                    tx = cr.x + Math.sin(t * 0.9 + ph) * 0.25; ty = 1.0 + (ph % 1) * 0.9; tz = cr.z + Math.cos(t * 0.8 + ph) * 0.25;
                    acc = 26;
                } else if (!climbing) {
                    tx = ax; ty = this.grid.ground ? this.grid.groundAt(ax, az) : 0; tz = az; acc = 12 * boost;             // crawl in along the floor
                } else if (ay <= this.buildH + 0.15 + this.gate[w]) {
                    tx = ax; ty = ay; tz = az; acc = 30;                    // grab its slot
                } else {
                    // climb the growing column below its slot
                    tx = ax + (cr.x - ax) * 0.5; ty = this.buildH; tz = az + (cr.z - az) * 0.5; acc = 22;
                }
                // heads probe and snake toward the target instead of homing in a straight line
                if (!leader) {
                    const wander = climbing ? 0.08 : 0.18;
                    tx += Math.sin(t * 3.1 + ph) * wander; tz += Math.cos(t * 2.7 + ph * 1.3) * wander;
                    acc *= 0.5 + 0.9 * Math.max(0, Math.sin(om * 1.3 * t + ph));   // peristaltic surges
                }
                let ex = tx - hx, ey = ty - hy, ez = tz - hz;
                const el = Math.hypot(ex, ey, ez) || 1;
                const up = leader ? G : 0;                 // rearing heads hold themselves up
                pos[h] += ex / el * acc * dt2;
                pos[h + 1] += (ey / el * acc + up) * dt2;
                pos[h + 2] += ez / el * acc * dt2;
                if (climbing && !leader && ay <= this.buildH + 0.15 + this.gate[w] && Math.hypot(hx - ax, hy - ay, hz - az) < 0.1) {   // latch only when actually at the slot
                    this.state[w] = BOUND; this.boundCount++; this.bindAge[w] = 0;
                    // latch on without momentum: no flinging the body up past the head
                    for (let i = 0; i < P; i++) { const q = base + i * 3; prev[q] = pos[q]; prev[q + 1] = Math.max(pos[q + 1], prev[q + 1]); prev[q + 2] = pos[q + 2]; }
                }
                if (leader && this.buildH > 1.1) this.leader[w] = 0;
                if (this.retTime[w] > 12) {          // hopelessly stuck (e.g. behind a wall): snap home
                    this.state[w] = BOUND; this.boundCount++; this.teleports++; this.bindAge[w] = 0;
                    this.hangFromSlot(w);   // move the WHOLE worm, or the pinned head drags it into a rope
                }
            }
        }

        // ---- constraints
        for (let it = 0; it < ITER; it++) {
            for (let w = 0; w < N; w++) {
                const st = this.state[w], base = w * P * 3, seg = this.seg[w];
                if (st === EATEN) continue;
                const pinHead = st === BOUND;
                const cl = st === CLING, sp0 = w * P, stuck = this.stuckPt;
                // stretch
                for (let i = 0; i < P - 1; i++) {
                    const o = base + i * 3, q = o + 3;
                    const dx = pos[q] - pos[o], dy = pos[q + 1] - pos[o + 1], dz = pos[q + 2] - pos[o + 2];
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                    const diff = (d - seg) / d * (this.squishy ? 0.5 : 1);   // squishy noodles give a little
                    let wa = 0.5, wb = 0.5;
                    if (i === 0 && pinHead) { wa = 0; wb = 1; }
                    else if (st === SLURP && i < this.slurpK(w)) { if (i + 1 < this.slurpK(w)) continue; wa = 0; wb = 1; }
                    else if (cl) {
                        const sa = stuck[sp0 + i] !== 0, sb = stuck[sp0 + i + 1] !== 0;
                        if (sa && sb) continue;
                        if (sa) { wa = 0; wb = 1; } else if (sb) { wa = 1; wb = 0; }
                    }
                    pos[o] += dx * diff * wa; pos[o + 1] += dy * diff * wa; pos[o + 2] += dz * diff * wa;
                    pos[q] -= dx * diff * wb; pos[q + 1] -= dy * diff * wb; pos[q + 2] -= dz * diff * wb;
                }
                // soft bending (i, i+2)
                if (it < 3) {
                    // two-sided: resists folding AND straightening, so gravity can't pull worms into rods.
                    // The rest bend drifts slowly along the body, so curls travel and change shape.
                    const c0 = this.curl[w], ph = this.phase[w], tm = this.time;
                    const k2 = st === BOUND ? 0.4 * Math.min(1, this.bindAge[w] / 1.5) : 0.12;   // freshly re-attached worms are limp and flop down
                    const K = st === SLURP ? this.slurpK(w) : 0;      // driven points (held / being drawn in) don't bend back
                    for (let i = 0; i < P - 2; i++) {
                        if (i + 2 < K) continue;
                        const o = base + i * 3, q = o + 6;
                        const th = c0 * (0.55 + 0.45 * Math.sin(i * 0.55 - tm * 0.7 + ph));
                        const rest = seg * 2 * Math.cos(th);
                        const dx = pos[q] - pos[o], dy = pos[q + 1] - pos[o + 1], dz = pos[q + 2] - pos[o + 2];
                        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                        const diff = (d - rest) / d * (d < rest ? 0.22 : k2);
                        const wo = i < K ? 0 : 1, wq = i < K ? 2 : 1;
                        pos[o] += dx * diff * wo; pos[o + 1] += dy * diff * wo; pos[o + 2] += dz * diff * wo;
                        pos[q] -= dx * diff * wq; pos[q + 1] -= dy * diff * wq; pos[q + 2] -= dz * diff * wq;
                    }
                }
                if (st === BOUND) {
                    const pin = 0.6 * Math.min(1, 0.12 + this.bindAge[w] / 0.8);   // grip tightens over ~0.8s after latching
                    pos[base] += (A[w * 3] - pos[base]) * pin;
                    pos[base + 1] += (A[w * 3 + 1] - pos[base + 1]) * pin;
                    pos[base + 2] += (A[w * 3 + 2] - pos[base + 2]) * pin;
                    if (this.tail[w]) {
                        const o = base + (P - 1) * 3, k = 0.2 * Math.min(1, this.bindAge[w] * this.bindAge[w]);
                        pos[o] += (B[w * 3] - pos[o]) * k;
                        pos[o + 1] += (B[w * 3 + 1] - pos[o + 1]) * k;
                        pos[o + 2] += (B[w * 3 + 2] - pos[o + 2]) * k;
                    }
                } else if (cl) {
                    const sp3 = this.stuckPos;
                    for (let i = 0; i < P; i++) {
                        if (!stuck[sp0 + i]) continue;
                        const o = base + i * 3, q = (sp0 + i) * 3;
                        pos[o] = sp3[q]; pos[o + 1] = sp3[q + 1]; pos[o + 2] = sp3[q + 2];
                    }
                }
            }
        }

        // ---- worm vs worm
        this.collideWorms();
        this.stepCount = (this.stepCount || 0) + 1;
        if (this.bodyCollisions && this.stepCount % 4 === 0) this.collideBody();

        // ---- worm collisions push points individually; restore worm length so nothing is left stretched
        this.relaxLengths();

        // ---- body capsules (bound) + environment (all): last, so nothing ends up inside walls
        this.collideBodyAndWorld();

        this.stepSlurp(dt);
    }

    // ------------------------------------------------------------ eating
    get eatenCount() { let n = 0; for (let w = 0; w < this.N; w++) if (this.state[w] === EATEN) n++; return n; }

    setMouth(x, y, z) { this.mouth[0] = x; this.mouth[1] = y; this.mouth[2] = z; }
    setFork(a) { if (a) this.fork.set(a); }
    setFist(a) { if (a) { this.fist[0] = a[0]; this.fist[1] = a[1]; this.fist[2] = a[2]; } }

    // where pinned point i of a strand held by anchor A sits
    slot(w, i, A, out) {
        if (A === 0) { out[0] = this.mouth[0]; out[1] = this.mouth[1]; out[2] = this.mouth[2]; return; }
        if (A === 1) {
            // wound around the tines in a coil that turns with the fork's roll
            const F = this.fork, t = 0.045 + Math.min(0.13, 0.011 * i), ang = F[9] + i * 1.25 + this.phase[w] * 3;
            const ax = F[3], ay = F[4], az = F[5], sx = F[6], sy = F[7], sz = F[8];
            const zx = ay * sz - az * sy, zy = az * sx - ax * sz, zz = ax * sy - ay * sx;
            const r = 0.03 + 0.006 * ((i + w) % 3), c = Math.cos(ang) * r, sn = Math.sin(ang) * r * 0.75;
            out[0] = F[0] - ax * t + sx * c + zx * sn; out[1] = F[1] - ay * t + sy * c + zy * sn; out[2] = F[2] - az * t + sz * c + zz * sn;
            return;
        }
        // a fistful: bunched in the palm, bulging out between the fingers
        const h = (w * 7 + i * 13) % 17 / 17, g = (w * 11 + i * 5) % 13 / 13, r = 0.025 + 0.02 * ((i + w) % 4) / 3;
        const th = h * Math.PI * 2, ph = (g - 0.5) * Math.PI;
        out[0] = this.fist[0] + Math.cos(ph) * Math.cos(th) * r; out[1] = this.fist[1] + Math.sin(ph) * r; out[2] = this.fist[2] + Math.cos(ph) * Math.sin(th) * r;
    }

    // how many leading points of a slurping strand are driven (pinned + the one being drawn in)
    slurpK(w) { const n = this.slurpN[w], A = this.slurpA[w]; return n < (A === 1 ? 9 : A === 2 ? 7 : P) ? n + 1 : n; }

    // hand strands over from the fork / fist to the mouth (the bite): they are sucked in from the held end
    feed(A) { for (let w = 0; w < this.N; w++) if (this.state[w] === SLURP && this.slurpA[w] === A) { this.slurpA[w] = 0; this.slurpN[w] = 0; } }
    // let go of whatever an anchor holds (the eating was interrupted)
    drop(A) { for (let w = 0; w < this.N; w++) if (this.state[w] === SLURP && this.slurpA[w] === A) { this.state[w] = FREE; this.timer[w] = this.holding ? 999 : 1 + this.rand() * 2; } }

    // loose strands (knocked off or from a destroyed monster) with any point near p
    findEdible(px, py, pz, radius, max = 6) {
        const out = [], r2 = radius * radius;
        for (let w = 0; w < this.N && out.length < max; w++) {
            const st = this.state[w];
            if (st !== FREE && st !== CLING && st !== RETURN) continue;
            for (let i = 0; i < P; i += 2) {
                const o = (w * P + i) * 3;
                const dx = this.pos[o] - px, dy = this.pos[o + 1] - py, dz = this.pos[o + 2] - pz;
                if (dx * dx + dy * dy + dz * dz < r2) { out.push(w); break; }
            }
        }
        return out;
    }

    // start slurping a strand: it is pulled into the mouth from its nearest end
    // anchor: 0 straight into the mouth, 1 onto the fork, 2 into the fist
    slurp(w, A = 0) {
        const st = this.state[w];
        if (st === BOUND) this.boundCount--;
        if (this.stuckN[w]) this.unstickAll(w);
        // pick it up by the end nearest the anchor: flip the strand so that end is point 0
        const tmp = [0, 0, 0];
        this.slot(w, 0, A, tmp);
        const base = w * P * 3, e = base + (P - 1) * 3, pos = this.pos;
        const d0 = Math.hypot(pos[base] - tmp[0], pos[base + 1] - tmp[1], pos[base + 2] - tmp[2]);
        const d1 = Math.hypot(pos[e] - tmp[0], pos[e + 1] - tmp[1], pos[e + 2] - tmp[2]);
        if (d1 < d0) {
            for (let i = 0; i < P >> 1; i++) {
                const a = base + i * 3, b = base + (P - 1 - i) * 3;
                for (let k = 0; k < 3; k++) {
                    let t = pos[a + k]; pos[a + k] = pos[b + k]; pos[b + k] = t;
                    t = this.prev[a + k]; this.prev[a + k] = this.prev[b + k]; this.prev[b + k] = t;
                }
                const pa = w * P + i, pb = w * P + P - 1 - i, t = this.prad[pa]; this.prad[pa] = this.prad[pb]; this.prad[pb] = t;
            }
        }
        this.state[w] = SLURP;
        this.slurpA[w] = A;
        this.slurpN[w] = 0;
        this.slurpRate[w] = 1.5 + this.rand() * 1.4;
    }

    stepSlurp(dt) {
        const pos = this.pos, prev = this.prev, q = this._slotTmp || (this._slotTmp = [0, 0, 0]);
        for (let w = 0; w < this.N; w++) {
            if (this.state[w] !== SLURP) continue;
            const base = w * P * 3, A = this.slurpA[w];
            let n = this.slurpN[w];
            for (let i = 0; i < n; i++) {                 // pinned: in the mouth / wound on the tines / in the fist
                this.slot(w, i, A, q);
                const o = base + i * 3;
                pos[o] = q[0]; pos[o + 1] = q[1]; pos[o + 2] = q[2];
                prev[o] = q[0]; prev[o + 1] = q[1]; prev[o + 2] = q[2];
            }
            const cap = A === 1 ? 9 : A === 2 ? 7 : P;    // the rest of the strand dangles
            if (n < cap) {
                this.slot(w, n, A, q);
                const o = base + n * 3;                    // the next point is drawn in
                const dx = q[0] - pos[o], dy = q[1] - pos[o + 1], dz = q[2] - pos[o + 2];
                const d = Math.hypot(dx, dy, dz);
                const step = (A === 0 ? this.slurpRate[w] : Math.max(3.2, d * 7)) * dt;
                if (d <= step + 0.03) {
                    this.slurpN[w] = ++n;
                    if (A === 0 && n >= P) { this.state[w] = EATEN; continue; }
                } else {
                    const k = step / d;
                    pos[o] += dx * k; pos[o + 1] += dy * k; pos[o + 2] += dz * k;
                    prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
                }
            }
            // follow the leader: the hanging rest is lifted link by link and can't stretch into a rubber band
            const L = this.seg[w] * 1.04;
            for (let i = Math.max(1, this.slurpK(w)); i < P; i++) {
                const a = base + (i - 1) * 3, o = base + i * 3;
                const dx = pos[o] - pos[a], dy = pos[o + 1] - pos[a + 1], dz = pos[o + 2] - pos[a + 2];
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d <= L) continue;
                const k = L / d;
                const nx = pos[a] + dx * k, ny = pos[a + 1] + dy * k, nz = pos[a + 2] + dz * k;
                prev[o] += nx - pos[o]; prev[o + 1] += ny - pos[o + 1]; prev[o + 2] += nz - pos[o + 2];   // dragged, not flung
                pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
            }
        }
    }

    relaxLengths() {
        const pos = this.pos;
        for (let w = 0; w < this.N; w++) {
            const st = this.state[w];
            if (st === BOUND || st === EATEN) continue;
            const base = w * P * 3, seg = this.seg[w], sp0 = w * P, stuck = this.stuckPt, cl = st === CLING;
            for (let it = 0; it < 2; it++) {
                for (let i = 0; i < P - 1; i++) {
                    const o = base + i * 3, q = o + 3;
                    const dx = pos[q] - pos[o], dy = pos[q + 1] - pos[o + 1], dz = pos[q + 2] - pos[o + 2];
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                    if (d <= seg * (this.squishy ? 1.25 : 1.02)) continue;   // only fix (excess) stretching
                    let wa = 0.5, wb = 0.5;
                    if (st === SLURP && i < this.slurpK(w)) { if (i + 1 < this.slurpK(w)) continue; wa = 0; wb = 1; }
                    else if (cl) {
                        const sa = stuck[sp0 + i] !== 0, sb = stuck[sp0 + i + 1] !== 0;
                        if (sa && sb) continue;
                        if (sa) { wa = 0; wb = 1; } else if (sb) { wa = 1; wb = 0; }
                    }
                    const diff = (d - seg) / d;
                    pos[o] += dx * diff * wa; pos[o + 1] += dy * diff * wa; pos[o + 2] += dz * diff * wa;
                    pos[q] -= dx * diff * wb; pos[q + 1] -= dy * diff * wb; pos[q + 2] -= dz * diff * wb;
                }
            }
        }
    }

    collideWorms() {
        const pos = this.pos, prev = this.prev, prad = this.prad, state = this.state;
        const NC = this.NC, hc = this.hashCount, hs = this.hashStart, items = this.hashItems, ih = this.itemHash;
        const nb = this.nb;
        nb.fill(0);
        hc.fill(0);
        const inv = 1 / CELL_H;
        const half = P >> 1;
        // collision spheres = every other point
        for (let c = 0; c < NC; c++) {
            const w = (c / half) | 0, i = (c % half) * 2, o = (w * P + i) * 3;
            const h = (Math.imul(Math.floor(pos[o] * inv), 73856093) ^ Math.imul(Math.floor(pos[o + 1] * inv), 19349663) ^ Math.imul(Math.floor(pos[o + 2] * inv), 83492791)) & HASH_MASK;
            ih[c] = h; hc[h]++;
        }
        let acc = 0;
        for (let h = 0; h < HASH_SIZE; h++) { hs[h] = acc; acc += hc[h]; hc[h] = 0; }
        hs[HASH_SIZE] = acc;
        for (let c = 0; c < NC; c++) { const h = ih[c]; items[hs[h] + hc[h]++] = c; }

        for (let c = 0; c < NC; c++) {
            const w = (c / half) | 0, i = (c % half) * 2;
            const sw = state[w];
            if (sw === 4 || sw === 5) continue;                   // eaten / being slurped
            if (sw === 0) continue;                           // bound points never initiate here (see collideBody)
            const pa = w * P + i, o = pa * 3;
            const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
            const ra = prad[pa] * 1.25;
            const cx = Math.floor(ax * inv), cy = Math.floor(ay * inv), cz = Math.floor(az * inv);
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const h = (Math.imul(cx + dx, 73856093) ^ Math.imul(cy + dy, 19349663) ^ Math.imul(cz + dz, 83492791)) & HASH_MASK;
                const end = hs[h + 1];
                for (let k = hs[h]; k < end; k++) {
                    const c2 = items[k];
                    if (c2 === c) continue;
                    const w2 = (c2 / half) | 0;
                    const sw2 = state[w2];
                    if (sw2 === 4 || sw2 === 5) continue;
                    if (sw2 !== 0 && c2 < c) continue;            // free/free pairs handled once
                    if (sw2 === 0 && (this.ghost[w] > 0 || this.climb[w])) continue; // shed / burrowing worms pass through the body
                    const i2 = (c2 % half) * 2;
                    if (w2 === w && Math.abs(i2 - i) <= 2) continue;
                    const pb = w2 * P + i2, q = pb * 3;
                    const ex = pos[q] - ax, ey = pos[q + 1] - ay, ez = pos[q + 2] - az;
                    const rr = ra + prad[pb] * 1.25;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 >= rr * rr || d2 < 1e-12) continue;
                    if (nb[pa] < 255) nb[pa]++;
                    if (nb[pb] < 255) nb[pb]++;
                    const d = Math.sqrt(d2);
                    // bound worms are heavy (pinned to the body), free ones get pushed
                    let wa = sw === 0 ? 0.1 : 0.5, wb = sw2 === 0 ? 0.1 : 0.5;
                    const s = wa + wb; wa /= s; wb /= s;
                    const pen = (rr - d) / d * ((sw === 0 || sw2 === 0) ? 0.5 : 1);
                    pos[o] -= ex * pen * wa; pos[o + 1] -= ey * pen * wa; pos[o + 2] -= ez * pen * wa;
                    pos[q] += ex * pen * wb; pos[q + 1] += ey * pen * wb; pos[q + 2] += ez * pen * wb;
                    // friction: damp relative tangential motion so piles hold their shape
                    const nx = ex / d, ny = ey / d, nz = ez / d;
                    let vx = (pos[q] - prev[q]) - (pos[o] - prev[o]);
                    let vy = (pos[q + 1] - prev[q + 1]) - (pos[o + 1] - prev[o + 1]);
                    let vz = (pos[q + 2] - prev[q + 2]) - (pos[o + 2] - prev[o + 2]);
                    const vn = vx * nx + vy * ny + vz * nz;
                    vx -= nx * vn; vy -= ny * vn; vz -= nz * vn;
                    const mu = (sw === 3 || sw2 === 3) ? 0.04 : 0.25;   // crawlers slither over the pile
                    pos[o] += vx * mu * wa; pos[o + 1] += vy * mu * wa; pos[o + 2] += vz * mu * wa;
                    pos[q] -= vx * mu * wb; pos[q + 1] -= vy * mu * wb; pos[q + 2] -= vz * mu * wb;
                }
            }
        }
    }

    // Body worms push each other apart so the mass reads as volume, not interpenetrating tubes.
    // Uses a separate sparse hash (every 4th point of bound worms) and runs every 3rd step.
    collideBody() {
        const pos = this.pos, prad = this.prad, state = this.state, N = this.N;
        const Q = P >> 2;                                   // spheres per worm
        if (!this.bItems) {
            this.bCount = new Int32Array(HASH_SIZE); this.bStart = new Int32Array(HASH_SIZE + 1);
            this.bItems = new Int32Array(N * Q); this.bHash = new Int32Array(N * Q); this.bIdx = new Int32Array(N * Q);
        }
        const hc = this.bCount, hs = this.bStart, items = this.bItems, ih = this.bHash, idx = this.bIdx;
        const H = 0.15, inv = 1 / H;                       // big enough to see neighbours within cohesion range
        let n = 0;
        hc.fill(0);
        for (let w = 0; w < N; w++) {
            if (state[w] !== 0 || this.train[w]) continue;      // the train drags on the floor, not in the mass
            for (let i = 4; i < P; i += 4) {          // not the head: it is pinned to its slot
                const pi = w * P + i, o = pi * 3;
                const h = (Math.imul(Math.floor(pos[o] * inv), 73856093) ^ Math.imul(Math.floor(pos[o + 1] * inv), 19349663) ^ Math.imul(Math.floor(pos[o + 2] * inv), 83492791)) & HASH_MASK;
                idx[n] = pi; ih[n] = h; hc[h]++; n++;
            }
        }
        let acc = 0;
        for (let h = 0; h < HASH_SIZE; h++) { hs[h] = acc; acc += hc[h]; hc[h] = 0; }
        hs[HASH_SIZE] = acc;
        for (let c = 0; c < n; c++) { const h = ih[c]; items[hs[h] + hc[h]++] = c; }
        for (let c = 0; c < n; c++) {
            const pa = idx[c], o = pa * 3, wa = (pa / P) | 0;
            const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
            const ra = prad[pa] * 1.4;
            const cx = Math.floor(ax * inv), cy = Math.floor(ay * inv), cz = Math.floor(az * inv);
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const h = (Math.imul(cx + dx, 73856093) ^ Math.imul(cy + dy, 19349663) ^ Math.imul(cz + dz, 83492791)) & HASH_MASK;
                const end = hs[h + 1];
                for (let k = hs[h]; k < end; k++) {
                    const c2 = items[k];
                    if (c2 <= c) continue;
                    const pb = idx[c2];
                    if (((pb / P) | 0) === wa) continue;
                    const q = pb * 3;
                    const ex = pos[q] - ax, ey = pos[q + 1] - ay, ez = pos[q + 2] - az;
                    const rr = ra + prad[pb] * 1.4, d2 = ex * ex + ey * ey + ez * ez;
                    const rest = rr * 1.12, rc = rest + 0.06;    // cohesion: settle just apart (no interpenetration), cling within range
                    if (d2 >= rc * rc || d2 < 1e-12) continue;
                    const d = Math.sqrt(d2);
                    // too close: push apart. Clearly separated (loose outer worms): pull them onto the mass.
                    // Nearly touching: leave alone, so the packed core is not squeezed into itself.
                    const gap = d - rest;
                    const pen = d < rest ? (rest - d) / d * 0.6
                        : gap > 0.015 ? -(gap - 0.015) / d * 0.12 * (1 - (gap - 0.015) / 0.045) : 0;
                    pos[o] -= ex * pen; pos[o + 1] -= ey * pen; pos[o + 2] -= ez * pen;
                    pos[q] += ex * pen; pos[q + 1] += ey * pen; pos[q + 2] += ez * pen;
                }
            }
        }
    }

    collideBodyAndWorld() {
        const pos = this.pos, prev = this.prev, prad = this.prad, ao = this.ao, nb = this.nb;
        const grid = this.grid, C = grid.CELL, WH = grid.WALL_H, R = this.rand;
        const bd = this.bones, terrain = !!grid.ground;
        for (let w = 0; w < this.N; w++) {
            const st = this.state[w], base = w * P * 3, rad = this.rad[w];
            if (st === EATEN) continue;
            for (let i = 0; i < P; i++) {
                const o = base + i * 3, pi = w * P + i, r = prad[pi];
                let occ = 1;
                if (st === BOUND) {
                    const cling = this.tail[w] ? 0.22 : (i < P * 0.22 ? 0.2 : 0);
                    // the head is held by its pin; pushing it around here fights the pin and makes it jump
                    occ = i === 0 ? ao[pi] : this.bodyPass(bd, o, this.bone[w], rad, this.layer[w], cling, !this.train[w] && !this.tail[w] && i > 2, false);
                }
                // floor (or terrain) + anisotropic friction (slides along the worm, grips sideways)
                const gy = terrain ? grid.groundAt(pos[o], pos[o + 2]) : 0, fr = gy + r;
                if (pos[o + 1] < fr) {
                    pos[o + 1] = fr;
                    const a = base + Math.max(0, i - 1) * 3, b = base + Math.min(P - 1, i + 1) * 3;
                    let tx = pos[b] - pos[a], tz = pos[b + 2] - pos[a + 2];
                    const tl = Math.hypot(tx, tz) || 1;
                    tx /= tl; tz /= tl;
                    const vx = pos[o] - prev[o], vz = pos[o + 2] - prev[o + 2];
                    const vt = vx * tx + vz * tz;
                    const nx = vx - tx * vt, nz = vz - tz * vt;
                    const kt = 0.96, kn = 0.3;                  // retained fraction per step
                    prev[o] = pos[o] - (tx * vt * kt + nx * kn);
                    prev[o + 2] = pos[o + 2] - (tz * vt * kt + nz * kn);
                    if (prev[o + 1] < fr) prev[o + 1] = fr;
                }
                let surf = 0;
                if (pos[o + 1] > WH - r) { pos[o + 1] = WH - r; surf = 1; }
                if (st !== BOUND) {
                    if (!(st === RETURN && this.retTime[w] > 5) && this.collideWalls(o, r)) surf = surf || 2;
                    // glue to a wall/ceiling: a fast impact starts it, then every touching point sticks
                    if (surf && this.sticky[w] && !this.stuckPt[pi] && this.stuckN[w] < this.stickMax[w] && this.canStick(w, i, o)) {
                        const sp = Math.hypot(pos[o] - prev[o], pos[o + 1] - prev[o + 1], pos[o + 2] - prev[o + 2]) * 60;
                        if (this.state[w] === CLING || (st === FREE && sp > 1.2)) {
                            if (this.state[w] !== CLING) { this.state[w] = CLING; this.timer[w] = 3 + R() * 9; }
                            this.stuckPt[pi] = surf;
                            this.stuckPos[pi * 3] = pos[o]; this.stuckPos[pi * 3 + 1] = pos[o + 1]; this.stuckPos[pi * 3 + 2] = pos[o + 2];
                            this.stuckN[w]++;
                            prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
                        }
                    }
                    // AO from local crowding and ground proximity
                    const crowd = nb[pi] * 0.08;
                    occ = Math.max(0.5, Math.min(1, 0.95 + (pos[o + 1] - fr) * 1.5) - crowd);
                }
                ao[pi] += (occ - ao[pi]) * 0.25;
            }
        }
    }

    // a new glued point must be within reach of the worm's other glued points along its body
    canStick(w, i, o) {
        if (this.stuckN[w] === 0) return true;
        const pos = this.pos, sp = this.stuckPos, st = this.stuckPt, seg = this.seg[w];
        for (let j = 0; j < P; j++) {
            if (!st[w * P + j]) continue;
            const q = (w * P + j) * 3;
            const d = Math.hypot(pos[o] - sp[q], pos[o + 1] - sp[q + 1], pos[o + 2] - sp[q + 2]);
            if (d > Math.abs(i - j) * seg * 1.1 + 0.02) return false;
        }
        return true;
    }

    unstickAll(w) {
        for (let i = 0; i < P; i++) this.stuckPt[w * P + i] = 0;
        this.stuckN[w] = 0;
    }

    // stuck runs peel from their ends (fast on the ceiling, slow on walls); wall-stuck points creep down
    peelAndSlide(w, dt) {
        const st = this.stuckPt, sp = this.stuckPos, R = this.rand, base = w * P;
        const crawl = Math.sin(this.time * 2 + this.phase[w]) > 0 ? 1 : 0.2;      // inching, not gliding
        for (let i = 0; i < P; i++) {
            const pi = base + i, s = st[pi];
            if (!s) continue;
            const endOfRun = i === 0 || i === P - 1 || !st[pi - 1] || !st[pi + 1];
            const hanging = (i > 0 && !st[pi - 1]) || (i < P - 1 && !st[pi + 1]);
            // a free part hanging off pulls the edge of the stuck run loose
            const rate = s === 1 ? (hanging ? 0.9 : 0.25) : (hanging ? 0.35 : 0.08);
            if (endOfRun && R() < rate * dt) { st[pi] = 0; this.stuckN[w]--; continue; }
            let over = false;
            for (let j = i + 1; j < P && !over; j++) {
                if (!st[base + j]) continue;
                const a = pi * 3, b = (base + j) * 3;
                if (Math.hypot(sp[a] - sp[b], sp[a + 1] - sp[b + 1], sp[a + 2] - sp[b + 2]) > (j - i) * this.seg[w] * 1.2) over = true;
            }
            if (over) { st[pi] = 0; this.stuckN[w]--; continue; }
            if (s === 2) {
                sp[pi * 3 + 1] -= dt * (0.04 + 0.06 * this.rad[w] / 0.036) * crawl;
                if (sp[pi * 3 + 1] < this.prad[pi]) { st[pi] = 0; this.stuckN[w]--; }
            }
        }
    }

    collideWalls(o, r) {
        const pos = this.pos, prev = this.prev, grid = this.grid, C = grid.CELL;
        const x = pos[o], z = pos[o + 2], y = pos[o + 1];
        const cx = Math.floor(x / C), cz = Math.floor(z / C);
        if (grid.isWall(cx, cz, y)) {
            // came down onto a low obstacle (table, counter): rest on its top
            const top = grid.heights ? grid.heightAt(cx, cz) : Infinity;
            if (prev[o + 1] >= top - 0.02) { pos[o + 1] = top + r * 0.5; if (prev[o + 1] < pos[o + 1]) prev[o + 1] = pos[o + 1]; return true; }
            pos[o] = prev[o]; pos[o + 2] = prev[o + 2];
            return true;
        }
        let hit = false;
        const fx = x - cx * C, fz = z - cz * C;
        if (fx < r && grid.isWall(cx - 1, cz, y)) { pos[o] = cx * C + r; hit = true; }
        else if (fx > C - r && grid.isWall(cx + 1, cz, y)) { pos[o] = (cx + 1) * C - r; hit = true; }
        if (fz < r && grid.isWall(cx, cz - 1, y)) { pos[o + 2] = cz * C + r; hit = true; }
        else if (fz > C - r && grid.isWall(cx, cz + 1, y)) { pos[o + 2] = (cz + 1) * C - r; hit = true; }
        // pillar in this cell: push the point out through the nearest face
        const pl = grid.pillarIn ? grid.pillarIn(cx, cz) : null;
        if (pl) {
            const px = pos[o], pz = pos[o + 2];
            if (px > pl[0] - r && px < pl[2] + r && pz > pl[1] - r && pz < pl[3] + r) {
                // faces flush against a wall are not exits (that would push the point into the wall)
                const x0w = pl[0] === cx * C && grid.isWall(cx - 1, cz), x1w = pl[2] === (cx + 1) * C && grid.isWall(cx + 1, cz);
                const z0w = pl[1] === cz * C && grid.isWall(cx, cz - 1), z1w = pl[3] === (cz + 1) * C && grid.isWall(cx, cz + 1);
                const dl = x0w ? Infinity : px - (pl[0] - r), dr = x1w ? Infinity : (pl[2] + r) - px;
                const dn = z0w ? Infinity : pz - (pl[1] - r), ds = z1w ? Infinity : (pl[3] + r) - pz;
                const m = Math.min(dl, dr, dn, ds);
                if (m === dl) pos[o] = pl[0] - r; else if (m === dr) pos[o] = pl[2] + r;
                else if (m === dn) pos[o + 2] = pl[1] - r; else pos[o + 2] = pl[3] + r;
                hit = true;
            }
        }
        if (hit) prev[o + 1] = pos[o + 1] - (pos[o + 1] - prev[o + 1]) * 0.5;
        return hit;
    }

    // keep a bound point outside its own bone, pull it snug, return an occlusion factor
    bodyPass(bd, o, ownBone, rad, layer, cling, envelope, isHead = false) {
        const pos = this.pos;
        let occ = 1;
        // hanging worms collide with every limb, so striding legs and swinging arms push the drape
        const bs = this.boneSph;
        const px0 = pos[o], py0 = pos[o + 1], pz0 = pos[o + 2];
        // (the attached head sits on its own bone; shoving it off neighbours would make it jump)
        for (let b = 0; b < this.boneCount && !isHead; b++) {
            if (b === ownBone) continue;
            if (bs) {
                const sx = px0 - bs[b * 4], sy = py0 - bs[b * 4 + 1], sz = pz0 - bs[b * 4 + 2], sr = bs[b * 4 + 3];
                if (sx * sx + sy * sy + sz * sz > sr * sr) continue;
            }
            const k = b * BONE_STRIDE;
            const ax = bd[k], ay = bd[k + 1], az = bd[k + 2];
            const ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az;
            const uu = ux * ux + uy * uy + uz * uz || 1;
            let s = ((pos[o] - ax) * ux + (pos[o + 1] - ay) * uy + (pos[o + 2] - az) * uz) / uu;
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            const dx = pos[o] - ax - ux * s, dy = pos[o + 1] - ay - uy * s, dz = pos[o + 2] - az - uz * s;
            const d2 = dx * dx + dy * dy + dz * dz, rr = bd[k + 12] + rad;
            if (d2 < rr * rr && d2 > 1e-10) {
                const d = Math.sqrt(d2), m = rr / d;
                pos[o] = ax + ux * s + dx * m; pos[o + 1] = ay + uy * s + dy * m; pos[o + 2] = az + uz * s + dz * m;
            }
        }
        // robe envelope: a narrow column around the torso that flares toward the floor
        if (envelope) {
            const y = pos[o + 1];
            const t = Math.min(1, Math.max(0, (y - bd[1]) / ((bd[4] - bd[1]) || 1)));
            const cx = bd[0] + (bd[3] - bd[0]) * t, cz = bd[2] + (bd[5] - bd[2]) * t;
            const ex = pos[o] - cx, ez = pos[o + 2] - cz, ed = Math.hypot(ex, ez);
            const env = 0.34 + Math.max(0, bd[1] - y) * 0.12;   // a slight flare at the floor, not a splayed skirt
            if (ed > env) { const m = 1 - (ed - env) / ed * 0.1; pos[o] = cx + ex * m; pos[o + 2] = cz + ez * m; }
        }
        const cb = this.coreBones;
        for (let j = -1; j < cb.length; j++) {
            const b = j < 0 ? ownBone : cb[j];
            if (j >= 0 && b === ownBone) continue;
            const k = b * BONE_STRIDE;
            const ax = bd[k], ay = bd[k + 1], az = bd[k + 2];
            const ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az;
            const uu = ux * ux + uy * uy + uz * uz || 1;
            let s = ((pos[o] - ax) * ux + (pos[o + 1] - ay) * uy + (pos[o + 2] - az) * uz) / uu;
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            const cx = ax + ux * s, cy = ay + uy * s, cz = az + uz * s;
            const dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const r = bd[k + 12];
            if (j < 0 && d > 1e-5) {
                if (d < r + rad * 0.9) {
                    const m = (r + rad * 0.9) / d;
                    pos[o] = cx + dx * m; pos[o + 1] = cy + dy * m; pos[o + 2] = cz + dz * m;
                } else if (cling > 0) {
                    const rt = r + layer + rad;
                    if (d > rt) {
                        const m = 1 - (d - rt) / d * cling;
                        pos[o] = cx + dx * m; pos[o + 1] = cy + dy * m; pos[o + 2] = cz + dz * m;
                    }
                }
            }
            const e = (d - r) / 0.16;
            const f = e < 0 ? 0.62 : e > 1 ? 1 : 0.62 + 0.38 * e;
            if (f < occ) occ = f;
        }
        return occ;
    }

    // ------------------------------------------------------------ mesh
    static vertexCount(N) { return N * P * S; }

    static buildIndices(N) {
        const indices = new Uint32Array(N * (P - 1) * S * 6);
        let k = 0;
        for (let w = 0; w < N; w++) {
            const vb = w * P * S;
            for (let i = 0; i < P - 1; i++) {
                for (let s = 0; s < S; s++) {
                    const a = vb + i * S + s, b = vb + i * S + (s + 1) % S;
                    const c = a + S, d = b + S;
                    // ring runs N -> B with B = T x N, so (a, b, c) winds counter-clockwise seen from outside
                    indices[k++] = a; indices[k++] = b; indices[k++] = c;
                    indices[k++] = b; indices[k++] = d; indices[k++] = c;
                }
            }
        }
        return indices;
    }

    // interleaved: pos(3 f32) normal(3 f32) color(rgba8) -> stride 7 words
    buildMesh(f, u) {
        const pos = this.pos, ao = this.ao, prad = this.prad;
        if (!this.cosT) {
            this.cosT = new Float32Array(S); this.sinT = new Float32Array(S);
            for (let s = 0; s < S; s++) { this.cosT[s] = Math.cos(s / S * Math.PI * 2); this.sinT[s] = Math.sin(s / S * Math.PI * 2); }
        }
        const cosT = this.cosT, sinT = this.sinT;
        let v = 0;
        for (let w = 0; w < this.N; w++) {
            const base = w * P * 3, abase = w * P;
            const cr = this.colA[w * 3], cg = this.colA[w * 3 + 1], cb = this.colA[w * 3 + 2];
            const wst = this.state[w];
            if (wst === EATEN) {                           // gone: collapse to a hidden point
                for (let k = v * 7, e = (v + P * S) * 7; k < e; k += 7) { f[k] = 0; f[k + 1] = -50; f[k + 2] = 0; f[k + 3] = 0; f[k + 4] = 1; f[k + 5] = 0; u[k + 6] = 0; }
                v += P * S;
                continue;
            }
            const eatenPts = wst === SLURP && this.slurpA[w] === 0 ? this.slurpN[w] : 0;
            const pasta = this.style === 'pasta', coat = this.coat[w], ph = this.phase[w];
            let nx = 0, ny = 1, nz = 0;
            for (let i = 0; i < P; i++) {
                const o = base + i * 3;
                const a = base + Math.max(0, i - 1) * 3, b = base + Math.min(P - 1, i + 1) * 3;
                let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
                const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
                tx /= tl; ty /= tl; tz /= tl;
                const dp = nx * tx + ny * ty + nz * tz;
                nx -= tx * dp; ny -= ty * dp; nz -= tz * dp;
                let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nl < 1e-3) {
                    if (Math.abs(tx) < 0.9) { nx = 0; ny = -tz; nz = ty; } else { nx = -tz; ny = 0; nz = tx; }
                    nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
                }
                nx /= nl; ny /= nl; nz /= nl;
                const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
                let r = i < eatenPts ? 0 : prad[abase + i];
                if (this.squishy && r > 0) {               // squash & stretch: thinner when pulled, fatter when squashed
                    const l = tl / (this.seg[w] * (i > 0 && i < P - 1 ? 2 : 1));
                    r *= Math.min(1.35, Math.max(0.7, 1 / Math.sqrt(l || 1)));
                }
                const occ = ao[abase + i];
                let kr, kg, kb;
                if (pasta) {
                    // patches of tomato sauce along the strand
                    const sauce = Math.min(1, Math.max(0, coat + 0.4 * Math.sin(i * 1.3 + ph * 5) + 0.2 * Math.sin(i * 3.1 + ph)));
                    kr = Math.min(255, (cr + (0.42 - cr) * sauce) * occ * 255);
                    kg = Math.min(255, (cg + (0.025 - cg) * sauce) * occ * 255);
                    kb = Math.min(255, (cb + (0.01 - cb) * sauce) * occ * 255);
                } else {
                    const ring = (i & 1) ? 0.9 : 1;
                    const cl = this.band[i];
                    kr = Math.min(255, cr * ring * (1 + cl * 0.5) * occ * 255);
                    kg = Math.min(255, cg * ring * (1 + cl * 0.8) * occ * 255);
                    kb = Math.min(255, cb * ring * (1 + cl * 0.7) * occ * 255);
                }
                const c = (kr | 0) | ((kg | 0) << 8) | ((kb | 0) << 16) | (255 << 24);
                const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
                for (let s = 0; s < S; s++) {
                    const dx = nx * cosT[s] + bx * sinT[s];
                    const dy = ny * cosT[s] + by * sinT[s];
                    const dz = nz * cosT[s] + bz * sinT[s];
                    const k = v * 7;
                    f[k] = px + dx * r; f[k + 1] = py + dy * r; f[k + 2] = pz + dz * r;
                    f[k + 3] = dx; f[k + 4] = dy; f[k + 5] = dz;
                    u[k + 6] = c;
                    v++;
                }
            }
        }
    }
}
