// The Flying Spaghetti Monster: two meatballs with eyes on stalks and a tangle of noodly appendages.
// Pure logic (no engine) so it can be tested; the game renders it and feeds its bones to a noodle sim.
//
//   fly     hovers out of fork reach, keeps its distance, lobs meatballs at the player
//   swoop   every few seconds dives low toward the player: the window to hit its meatballs
//   downed  out of hit points: crashes to the floor; now its meatballs and noodles can be eaten


export const BOSS_STRIDE = 13;
// [jointA, jointB, radius, noodle weight]: noodles hang off the meatballs
const BONES = [
    ['mA0', 'mA1', 0.42, 1.6],
    ['mB0', 'mB1', 0.36, 1.4],
    ['sL0', 'eyeL', 0.035, 0.12],
    ['sR0', 'eyeR', 0.035, 0.12]
];

export class FlyingSpaghettiMonster {
    constructor(level, start) {
        this.level = level;
        this.x = start.x; this.z = start.z;
        this.y = 2.1;
        this.yaw = 0;
        this.vx = 0; this.vz = 0;
        this.maxHp = 14;
        this.hp = this.maxHp;
        this.state = 'fly';           // fly | swoop | downed | eaten
        this.time = 0;
        this.swoopT = 5;              // time until next swoop
        this.throwT = 2.5;            // time until next meatball throw
        this.flinch = 0;
        this.eatProgress = 0;         // 0..1, meatballs being eaten once downed
        this.boneCount = BONES.length;
        this.boneData = new Float32Array(this.boneCount * BOSS_STRIDE);
        this.boneWeight = BONES.map(b => b[3]);
        this.coreBones = [0, 1];
        this.joints = {};
        this.pose();
    }

    get walking() { return false; }       // never sheds noodles like the walkers do
    get speed() { return Math.hypot(this.vx, this.vz); }
    get downed() { return this.state === 'downed'; }
    get alive() { return this.state === 'fly' || this.state === 'swoop'; }

    meatballs() {
        const s = 1 - this.eatProgress * 0.85;
        return [
            { c: this.joints.mA, r: 0.42 * s },
            { c: this.joints.mB, r: 0.36 * s }
        ];
    }

    // returns a list of events: { type: 'throw', from, vel } for meatball projectiles
    update(dt, player) {
        this.time += dt;
        const events = [];
        const dx = player.x - this.x, dz = player.z - this.z;
        const dist = Math.hypot(dx, dz);
        this.flinch = Math.max(0, this.flinch - dt * 2);

        if (this.state === 'downed' || this.state === 'eaten') {
            this.y = Math.max(0.45, this.y - dt * 4);
            this.vx *= 0.9; this.vz *= 0.9;
            this.pose();
            return events;
        }

        let wantX = 0, wantZ = 0, wantY = 2.15 + Math.sin(this.time * 1.7) * 0.18, top = 2.6;
        if (this.state === 'swoop') {
            this.swoopLeft -= dt;
            wantX = dx; wantZ = dz;                        // dive at the player
            wantY = 1.25;
            top = 3.2;
            if (this.swoopLeft <= 0 || dist < 1.4) { this.state = 'fly'; this.swoopT = 5 + Math.random() * 3; }
        } else {
            this.swoopT -= dt;
            if (this.swoopT <= 0 && dist < 11) { this.state = 'swoop'; this.swoopLeft = 1.8; }
            // keep 6-9 m away: back off along the walkable distance field, close in if too far
            if (dist < 6) {
                const away = this.fleeDir(player);
                wantX = away.x; wantZ = away.z;
            } else if (dist > 9) { wantX = dx; wantZ = dz; }
            else { wantX = -dz; wantZ = dx; }              // circle at range
            this.throwT -= dt;
            if (this.throwT <= 0 && dist < 13 && this.lineOfSight(player)) {
                this.throwT = 2.2 + Math.random() * 1.2;
                // lob: aim at where the player is, flight time ~ distance-based
                const T = 0.55 + dist * 0.07;
                const from = [this.x, this.y - 0.2, this.z];
                events.push({ type: 'throw', from, vel: [(player.x - from[0]) / T, (1.1 - from[1]) / T + 4.9 * T, (player.z - from[2]) / T] });
            }
        }
        const wl = Math.hypot(wantX, wantZ);
        const tvx = wl > 1e-3 ? wantX / wl * top * (1 - 0.7 * this.flinch) : 0;
        const tvz = wl > 1e-3 ? wantZ / wl * top * (1 - 0.7 * this.flinch) : 0;
        const k = Math.min(1, dt * 2.5);
        this.vx += (tvx - this.vx) * k; this.vz += (tvz - this.vz) * k;
        this.x += this.vx * dt; this.z += this.vz * dt;
        const p = { x: this.x, z: this.z };
        this.level.collideCircle(p, 0.75);
        this.x = p.x; this.z = p.z;
        this.y += (wantY - this.y) * Math.min(1, dt * 2.2);
        const wantYaw = Math.atan2(dx, dz);               // always eyes on the player
        let dy = wantYaw - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 3);
        this.pose();
        return events;
    }

    fleeDir(player) {
        if (!this.distField || (this.distT = (this.distT || 0) - 1) <= 0) { this.distField = this.level.distanceField(player); this.distT = 15; }
        const w = this.level.w;
        const CELL = this.level.CELL, cx = Math.floor(this.x / CELL), cz = Math.floor(this.z / CELL);
        let best = null, bestD = this.distField[cz * w + cx];
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + ox, nz = cz + oz;
            if (this.level.isBlocked(nx, nz)) continue;
            const d = this.distField[nz * w + nx];
            if (d > bestD) { bestD = d; best = [nx, nz]; }
        }
        if (!best) return { x: this.x - player.x, z: this.z - player.z };
        return { x: (best[0] + 0.5) * CELL - this.x, z: (best[1] + 0.5) * CELL - this.z };
    }

    lineOfSight(p) {
        const dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz), n = Math.ceil(d / 0.3);
        for (let i = 1; i < n; i++) if (this.level.isWallAt(this.x + dx * i / n, this.z + dz * i / n)) return false;
        return true;
    }

    // a fork strike at point p: did it hit a meatball?
    takeHit(p) {
        if (!this.alive) return false;
        for (const m of this.meatballs()) {
            if (Math.hypot(p[0] - m.c[0], p[1] - m.c[1], p[2] - m.c[2]) < m.r + 0.3) {
                this.hp -= 1;
                this.flinch = 1;
                // knocked back and up a little
                this.vx -= Math.sin(this.yaw) * 3; this.vz -= Math.cos(this.yaw) * 3;
                if (this.hp <= 0) { this.state = 'downed'; }
                return true;
            }
        }
        return false;
    }

    // one bite of the downed boss's meatballs
    eatBite() {
        if (!this.downed) return false;
        this.eatProgress = Math.min(1, this.eatProgress + 0.2);
        if (this.eatProgress >= 1) this.state = 'eaten';
        return true;
    }

    pose() {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        const right = [c, 0, -s], fwd = [s, 0, c];
        const wob = Math.sin(this.time * 3.1) * 0.05;
        const at = (rx, ry, rz) => [this.x + right[0] * rx + fwd[0] * rz, this.y + ry, this.z + right[2] * rx + fwd[2] * rz];
        const J = this.joints;
        const shrink = 1 - this.eatProgress * 0.85;
        J.mA = at(-0.3 * shrink, wob, 0.05);
        J.mB = at(0.32 * shrink, -wob, -0.05);
        J.mA0 = [J.mA[0], J.mA[1] - 0.06, J.mA[2]]; J.mA1 = [J.mA[0], J.mA[1] + 0.06, J.mA[2]];
        J.mB0 = [J.mB[0], J.mB[1] - 0.06, J.mB[2]]; J.mB1 = [J.mB[0], J.mB[1] + 0.06, J.mB[2]];
        // eye stalks curve up and forward, wobbling
        const sway = Math.sin(this.time * 2.3) * 0.08;
        J.sL0 = at(-0.25, 0.3, 0.12); J.eyeL = at(-0.32 + sway, 0.78, 0.3);
        J.sR0 = at(0.25, 0.28, 0.1); J.eyeR = at(0.34 - sway, 0.74, 0.28);
        const fx = fwd[0], fz = fwd[2];
        for (let i = 0; i < this.boneCount; i++) {
            const [na, nb, r] = BONES[i];
            const a = J[na], b = J[nb];
            let ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
            const al = Math.hypot(ax, ay, az) || 1;
            ax /= al; ay /= al; az /= al;
            let ux = ay * fz, uy = az * fx - ax * fz, uz = -ay * fx;
            let ul = Math.hypot(ux, uy, uz);
            if (ul < 0.2) { ux = -az; uy = 0; uz = ax; ul = Math.hypot(ux, uz) || 1; }
            ux /= ul; uy /= ul; uz /= ul;
            const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
            const o = i * BOSS_STRIDE, bd = this.boneData;
            bd[o] = a[0]; bd[o + 1] = a[1]; bd[o + 2] = a[2];
            bd[o + 3] = b[0]; bd[o + 4] = b[1]; bd[o + 5] = b[2];
            bd[o + 6] = ux; bd[o + 7] = uy; bd[o + 8] = uz;
            bd[o + 9] = vx; bd[o + 10] = vy; bd[o + 11] = vz;
            bd[o + 12] = r * (i < 2 ? shrink : 1);
        }
    }
}
