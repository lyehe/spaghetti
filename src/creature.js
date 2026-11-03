
// Bone layout in Float32Array, stride BONE_STRIDE:
// ax ay az | bx by bz | ux uy uz | vx vy vz | r
export const BONE_STRIDE = 13;

// [jointA, jointB, radius, worm density weight]
const BONES = [
    // weights favor the upper body: worms hang from head/shoulders like a robe over the legs
    ['pelvis', 'chest', 0.2, 2.0],
    ['chest', 'neck', 0.18, 2.6],
    ['neck', 'head', 0.13, 2.4],
    ['chest', 'shL', 0.11, 1.8], ['shL', 'elL', 0.08, 0.8], ['elL', 'haL', 0.065, 0.35],
    ['chest', 'shR', 0.11, 1.8], ['shR', 'elR', 0.08, 0.8], ['elR', 'haR', 0.065, 0.35],
    ['pelvis', 'hiL', 0.12, 0.8], ['hiL', 'knL', 0.1, 0.25], ['knL', 'ftL', 0.075, 0.1],
    ['pelvis', 'hiR', 0.12, 0.8], ['hiR', 'knR', 0.1, 0.25], ['knR', 'ftR', 0.075, 0.1]
];

export const THIGH = 0.48, SHIN = 0.5, UPPER_ARM = 0.38, FOREARM = 0.42;
const HIP_W = 0.14, FOOT_W = 0.16, SHOULDER_W = 0.24;
const FOOT_Y = 0.06;
const MAX_SPEED = 1.7;

const STATE = { WALK: 0, COLLAPSED: 1, REFORM: 2 };

// small vector helpers on [x,y,z] arrays
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export class Creature {
    constructor(level, { scale = 1, behavior = 'chase', start = null } = {}) {
        this.level = level;
        this.s = scale;                 // every length, radius, stride and height scales with this
        this.behavior = behavior;
        this.startPos = start;
        this.bones = BONES;
        this.boneCount = BONES.length;
        this.boneData = new Float32Array(this.boneCount * BONE_STRIDE);
        this.boneWeight = BONES.map(b => b[3]);
        this.coreBones = [0, 1];   // torso segments used for the fake AO term
        this.joints = {};
        this.reset();
    }

    reset() {
        const s = this.startPos || this.level.creatureStart;
        this.x = s.x; this.z = s.z;
        this.yaw = Math.PI;              // facing -z
        this.time = 0;
        this.gait = 0;
        this.slump = 0;
        this.state = STATE.WALK;
        this.stateTimer = 0;
        this.pathTimer = 0;
        this.dist = null;
        this.speed = 0;
        this.vx = 0; this.vz = 0;
        this.stepEvent = false;
        this.awake = false;
        this.kx = 0; this.kz = 0; this.flinch = 0;
        this.crouch = 0;                  // 0 standing .. 1 hunched low (re-forming)
        this.mode = this.behavior === 'flee' ? 'flee' : 'chase';
        this.stunT = 0;                   // > 0: dazed by a fork hit, can't move
        this.chaseSpeed = MAX_SPEED;
        this.rig = null;                  // built lazily at the current root
        this.computePose(0, 0);
    }

    get collapsed() { return this.state === STATE.COLLAPSED; }
    get reforming() { return this.state === STATE.REFORM; }
    get walking() { return this.state === STATE.WALK; }

    // a shot shoves the body back: knockback, a backwards lurch of the torso, stagger steps
    impact(dx, dz) {
        this.kx += dx * 0.9; this.kz += dz * 0.9;
        if (this.rig) { this.rig.leanV[0] += dx * 2.2; this.rig.leanV[1] += dz * 2.2; }
        this.flinch = 1;
    }

    // a fork hit without meatball power: knocked silly for a few seconds
    stun(t = 2.5) { this.stunT = Math.max(this.stunT, t); this.flinch = 1; }
    get stunned() { return this.stunT > 0; }

    collapse() {
        this.state = STATE.COLLAPSED;
        this.stateTimer = 5.5;
    }

    // teleport (debug / respawn): rebuild the rig in place
    place(x, z, yaw) {
        this.x = x; this.z = z; this.yaw = yaw;
        this.rig = null;
        this.computePose(this.time, 0);
    }

    update(dt, player, boundFrac, t) {
        this.stepEvent = false;
        const dx = player.pos.x - this.x, dz = player.pos.z - this.z;
        const distToPlayer = Math.hypot(dx, dz);
        if (!this.awake && !this.dormant && distToPlayer < 22) this.awake = true;

        // re-form from a clean stance: the old feet were left wherever the body burst
        if (this.state === STATE.REFORM && this.prevState !== STATE.REFORM) this.rig = null;
        this.prevState = this.state;

        if (this.state === STATE.COLLAPSED) {
            this.stateTimer -= dt;
            this.slump = Math.min(1, this.slump + dt * 3);
            this.crouch = 1;
            if (this.stateTimer <= 0) { this.state = STATE.REFORM; }
        } else if (this.state === STATE.REFORM) {
            // the heap pulls together, then the body rises as it gathers its worms
            this.slump = Math.max(0, this.slump - dt * 1.2);
            this.crouch += (Math.min(1, Math.max(0, 1.15 - boundFrac * 1.2)) - this.crouch) * Math.min(1, dt * 1.5);
            if (this.rig) { this.rig.leanV[0] += (Math.random() - 0.5) * dt * 6 * this.crouch; this.rig.leanV[1] += (Math.random() - 0.5) * dt * 6 * this.crouch; }
            if (boundFrac > 0.85) { this.state = STATE.WALK; }
        } else {
            this.slump = Math.max(0, this.slump - dt * 1.5);
            this.crouch = Math.max(0, this.crouch - dt * 1.5);
        }

        // locomotion
        let targetSpeed = 0;
        if (this.stunT > 0) {
            // dazed: stand swaying, head lolling
            this.stunT = Math.max(0, this.stunT - dt);
            if (this.rig) { this.rig.leanV[0] += Math.sin(this.time * 7) * dt * 5; this.rig.leanV[1] += Math.cos(this.time * 5.3) * dt * 5; }
            this.crouch += (0.35 - this.crouch) * Math.min(1, dt * 4);
        } else if (this.mode === 'flee' && this.state === STATE.WALK) {
            targetSpeed = this.fleeUpdate(dt, player, distToPlayer, boundFrac);
        } else if (this.state === STATE.WALK && this.awake) {
            targetSpeed = this.chaseSpeed * (0.35 + 0.65 * boundFrac) * (1 - 0.75 * this.flinch);
            this.pathTimer -= dt;
            if (this.pathTimer <= 0 || !this.dist) {
                this.dist = this.level.distanceField(player.pos);
                this.pathTimer = 0.3;
            }
            const dir = this.steer(player.pos, distToPlayer);
            if (dir) {
                const want = Math.atan2(dir.x, dir.z);
                let dy = want - this.yaw;
                while (dy > Math.PI) dy -= Math.PI * 2;
                while (dy < -Math.PI) dy += Math.PI * 2;
                this.yaw += dy * Math.min(1, dt * 3);
            }
            if (distToPlayer < 0.6) targetSpeed *= 0.3;
        }
        this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 2.5);
        const px = this.x, pz = this.z;
        this.x += Math.sin(this.yaw) * this.speed * dt + this.kx * dt;
        this.z += Math.cos(this.yaw) * this.speed * dt + this.kz * dt;
        const kd = Math.exp(-dt * 6);
        this.kx *= kd; this.kz *= kd;
        this.flinch = Math.max(0, this.flinch - dt * 2.2);
        const p = { x: this.x, z: this.z };
        this.level.collideCircle(p, this.radius ?? 0.35 * this.s);
        this.x = p.x; this.z = p.z;
        if (dt > 0) {
            // smoothed root velocity (includes knockback) drives foot placement and lean
            const k = Math.min(1, dt * 12);
            this.vx += ((this.x - px) / dt - this.vx) * k;
            this.vz += ((this.z - pz) / dt - this.vz) * k;
        }
        this.gait += ((this.speed > 0.1 ? 1 : 0) - this.gait) * Math.min(1, dt * 3);

        this.computePose(t, dt);
        return distToPlayer;
    }

    // Prey behaviour: wander until the player gets close, then run toward whichever neighbouring
    // cell is farthest (by walking distance) from the player. Cornered -> cower and shake.
    // Small monsters are quicker but tire; stamina recovers while wandering.
    fleeUpdate(dt, player, distToPlayer, boundFrac) {
        if (this.stamina === undefined) { this.stamina = 1; this.wanderT = 0; this.wanderYaw = this.yaw; this.cowering = false; }
        const panic = player.panic || distToPlayer < 9;
        let target = 0;
        const turnTo = (want, rate) => {
            let dy = want - this.yaw;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            this.yaw += dy * Math.min(1, dt * rate);
        };
        this.cowering = false;
        if (panic) {
            this.pathTimer -= dt;
            let best;
            if (this.level.CELL < 1) {
                // fine grids (splat spaces): run for a safe spot — far from the player, and reachable
                // without running past them — instead of climbing into the nearest dead end
                if (this.pathTimer <= 0 || !this.dist) { this.pathTimer = 0.8; this.fleeGoal = this.pickFleeGoal(player.pos); this.dist = this.fleeGoal ? this.level.distanceField(this.fleeGoal) : this.level.distanceField(player.pos); }
                best = this.fleeGoal ? this.fieldStep(false) : this.fieldStep(true);
                if (this.fleeGoal && !best && Math.hypot(this.fleeGoal.x - this.x, this.fleeGoal.z - this.z) < 0.4) best = null;
            } else {
                if (this.pathTimer <= 0 || !this.dist) { this.dist = this.level.distanceField(player.pos); this.pathTimer = 0.25; }
                best = this.fieldStep(true);
            }
            if (best) {
                turnTo(Math.atan2(best[0] - this.x, best[1] - this.z), 5);
                const top = Math.min(3.0, 1.7 + 0.65 / this.s);
                target = top * (0.45 + 0.55 * this.stamina) * (0.5 + 0.5 * boundFrac) * (1 - 0.6 * this.flinch);
                this.stamina = Math.max(0, this.stamina - dt * 0.09 / this.s);
            } else {
                // dead end: cower, facing away from the player
                this.cowering = true;
                turnTo(Math.atan2(this.x - player.pos.x, this.z - player.pos.z), 4);
                if (this.rig) { this.rig.leanV[0] += (Math.random() - 0.5) * dt * 10; this.rig.leanV[1] += (Math.random() - 0.5) * dt * 10; }
            }
        } else {
            this.stamina = Math.min(1, this.stamina + dt * 0.12);
            this.wanderT -= dt;
            if (this.wanderT <= 0) { this.wanderT = 2 + Math.random() * 3; this.wanderYaw = this.yaw + (Math.random() - 0.5) * 2.5; }
            const ahead = { x: this.x + Math.sin(this.wanderYaw) * 1.2, z: this.z + Math.cos(this.wanderYaw) * 1.2 };
            if (this.level.isWallAt(ahead.x, ahead.z)) this.wanderYaw += Math.PI * (0.5 + Math.random() * 0.5);
            turnTo(this.wanderYaw, 2);
            target = 0.55 * this.s;
        }
        this.crouch += ((this.cowering ? 0.6 : 0) - this.crouch) * Math.min(1, dt * 3);
        return target;
    }

    pickFleeGoal(playerPos) {
        const lv = this.level, w = lv.w, C = lv.CELL;
        const fromP = lv.distanceField(playerPos), fromMe = lv.distanceField({ x: this.x, z: this.z });
        let best = null, bs = -Infinity;
        for (let i = 0; i < w * lv.h; i += 2) {
            const dp = fromP[i], dm = fromMe[i];
            if (dp < 0 || dm < 0) continue;
            // far from the player, not too far for me, and I get there well before they do
            const sc = dp - 0.45 * dm - Math.max(0, dm - dp) * 1.5 + Math.random() * 3;
            if (sc > bs) { bs = sc; best = i; }
        }
        return best === null ? null : { x: (best % w + 0.5) * C, z: (((best / w) | 0) + 0.5) * C };
    }

    // pick a direction: straight at player if in line of sight, else follow BFS field
    steer(target, distToPlayer) {
        if (distToPlayer < 1.5 || this.lineOfSight(target)) {
            return { x: target.x - this.x, z: target.z - this.z };
        }
        const best = this.fieldStep(false);
        if (!best) return { x: target.x - this.x, z: target.z - this.z };
        return { x: best[0] - this.x, z: best[1] - this.z };
    }

    // Follow the distance field downhill (chase) or uphill (flee) as a chain of grid cells
    // (8-neighbours), then aim at the farthest cell of the chain that is in clear view, so paths are
    // smooth in the open and exact in tight squeezes. Returns a world point to head for, or null.
    fieldStep(away) {
        const lv = this.level, C = lv.CELL, w = lv.w, D = this.dist;
        const val = (cx, cz) => lv.isBlocked(cx, cz) ? -1 : D[cz * w + cx];
        let cx = Math.floor(this.x / C), cz = Math.floor(this.z / C);
        let cur = val(cx, cz);
        if (cur < 0) {
            // squeezed into the margin around furniture: start from the best free cell nearby
            let best = null, bd = away ? -1 : 1e9;
            for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
                const d = val(cx + dx, cz + dz);
                if (d < 0 || lv.isWall(cx + dx, cz + dz)) continue;
                if (away ? d > bd : d < bd) { bd = d; best = [cx + dx, cz + dz]; }
            }
            if (!best) return null;
            return [(best[0] + 0.5) * C, (best[1] + 0.5) * C];
        }
        const chain = [];
        const steps = Math.max(1, Math.round(1.5 / C));
        for (let k = 0; k < steps; k++) {
            let best = null, bd = cur;
            for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dz) continue;
                const d = val(cx + dx, cz + dz);
                if (d < 0) continue;
                // no corner cutting
                if (dx && dz && (val(cx + dx, cz) < 0 || val(cx, cz + dz) < 0)) continue;
                if (away ? d > bd : d < bd) { bd = d; best = [cx + dx, cz + dz]; }
            }
            if (!best) break;
            [cx, cz] = best; cur = bd;
            chain.push([(cx + 0.5) * C, (cz + 0.5) * C]);
        }
        if (!chain.length) return null;
        // farthest chain point reachable in a straight line over free cells
        for (let k = chain.length - 1; k > 0; k--) {
            const [tx, tz] = chain[k], dl = Math.hypot(tx - this.x, tz - this.z), n = Math.ceil(dl / (C * 0.5));
            // the whole body width must clear the furniture, not just the centre line
            const r = (this.radius ?? 0.35 * this.s) * 1.05, px = -(tz - this.z) / (dl || 1) * r, pz = (tx - this.x) / (dl || 1) * r;
            let ok = true;
            for (let i = 1; i <= n && ok; i++) {
                const f = i / n, x = this.x + (tx - this.x) * f, z = this.z + (tz - this.z) * f;
                if (val(Math.floor(x / C), Math.floor(z / C)) < 0 || lv.isWall(Math.floor((x + px) / C), Math.floor((z + pz) / C)) || lv.isWall(Math.floor((x - px) / C), Math.floor((z - pz) / C))) ok = false;
            }
            if (ok) return chain[k];
        }
        return chain[0];
    }

    lineOfSight(target) {
        const dx = target.x - this.x, dz = target.z - this.z;
        const d = Math.hypot(dx, dz);
        const steps = Math.ceil(d / 0.25);
        for (let i = 1; i < steps; i++) {
            const f = i / steps;
            const x = this.x + dx * f, z = this.z + dz * f;
            const nx = -dz / d * 0.3, nz = dx / d * 0.3;
            if (this.level.isWallAt(x, z) || this.level.isWallAt(x + nx, z + nz) || this.level.isWallAt(x - nx, z - nz)) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ rig
    frame() {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        return { fwd: [s, 0, c], right: [c, 0, -s] };
    }

    footHome(side) {
        const { right } = this.frame();
        const k = this.s;
        return [this.x + right[0] * side * FOOT_W * k, FOOT_Y * k, this.z + right[2] * side * FOOT_W * k];
    }

    buildRig() {
        const { fwd, right } = this.frame();
        const mkFoot = (side) => ({ side, pos: this.footHome(side), planted: true, from: null, t: 0, dur: 0.4 });
        const k = this.s;
        const sh = (side) => [this.x + right[0] * side * SHOULDER_W * k, 1.62 * k, this.z + right[2] * side * SHOULDER_W * k];
        const mkArm = (side) => {
            const s0 = sh(side);
            const el = [s0[0] + fwd[0] * 0.1 * k, s0[1] - UPPER_ARM * k, s0[2] + fwd[2] * 0.1 * k];
            const ha = [el[0] + fwd[0] * 0.25 * k, el[1] - FOREARM * 0.9 * k, el[2] + fwd[2] * 0.25 * k];
            return { side, el, elP: el.slice(), ha, haP: ha.slice() };
        };
        this.rig = {
            feet: [mkFoot(-1), mkFoot(1)],
            arms: [mkArm(-1), mkArm(1)],
            lean: [0, 0], leanV: [0, 0],        // torso lean (world xz offset of chest over pelvis)
            shift: [0, 0],                       // pelvis weight shift
            head: null, headV: [0, 0, 0],
            lastLand: -1, pelvisY: 1.0
        };
    }

    // planted-foot stepping: a foot stays locked in the world until the body gets too far from it
    stepFeet(dt) {
        const R = this.rig;
        const v = [this.vx, 0, this.vz];
        const spd = Math.hypot(this.vx, this.vz);
        const lead = 0.2;
        for (const f of R.feet) {
            const other = R.feet[f.side < 0 ? 1 : 0];
            const home = this.footHome(f.side);
            const limp = f.side > 0;                                  // the right leg drags
            if (f.planted) {
                const dx = f.pos[0] - home[0], dz = f.pos[2] - home[2];
                const off = Math.hypot(dx, dz);
                const thresh = (0.12 + 0.07 * Math.min(1, spd / this.s)) * this.s;
                // the foot most out of place goes first; never both at once
                const otherOff = Math.hypot(other.pos[0] - this.footHome(other.side)[0], other.pos[2] - this.footHome(other.side)[2]);
                if (dt > 0 && off > thresh && other.planted && this.time - R.lastLand > 0.06 && (off >= otherOff || otherOff < thresh)) {
                    f.planted = false;
                    f.from = f.pos.slice();
                    f.t = 0;
                    f.dur = Math.max(0.16, (0.4 - spd / this.s * 0.11) * Math.sqrt(this.s)) * (limp ? 1.15 : 1);
                }
            } else {
                f.t = Math.min(1, f.t + dt / f.dur);
                const to = [home[0] + v[0] * lead, FOOT_Y * this.s, home[2] + v[2] * lead];
                const c = { x: to[0], z: to[2] };
                this.level.collideCircle(c, 0.1);
                to[0] = c.x; to[2] = c.z;
                const e = f.t * f.t * (3 - 2 * f.t);                  // smoothstep
                const lift = (limp ? 0.07 : 0.16) * this.s * Math.min(1, 0.4 + spd / this.s);
                f.pos[0] = f.from[0] + (to[0] - f.from[0]) * e;
                f.pos[2] = f.from[2] + (to[2] - f.from[2]) * e;
                f.pos[1] = FOOT_Y * this.s + Math.sin(Math.PI * f.t) * lift;
                if (f.t >= 1) {
                    f.planted = true;
                    f.pos[1] = FOOT_Y * this.s;
                    R.lastLand = this.time;
                    this.stepEvent = true;
                    R.landKick = limp ? 0.05 : 0.035;                 // heavy footfall dips the body
                }
            }
        }
    }

    // 2-bone IK: knee between hip and foot, bending toward `pole`
    ik(hip, foot, l1, l2, pole) {
        let d = sub(foot, hip);
        let dl = len(d) || 1e-6;
        const maxR = (l1 + l2) * 0.999;
        if (dl > maxR) { for (let k = 0; k < 3; k++) d[k] *= maxR / dl; dl = maxR; foot = [hip[0] + d[0], hip[1] + d[1], hip[2] + d[2]]; }
        const dir = [d[0] / dl, d[1] / dl, d[2] / dl];
        const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
        const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
        const pd = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
        let pn = [pole[0] - dir[0] * pd, pole[1] - dir[1] * pd, pole[2] - dir[2] * pd];
        const pl = len(pn) || 1;
        pn = [pn[0] / pl, pn[1] / pl, pn[2] / pl];
        return { knee: [hip[0] + dir[0] * a + pn[0] * h, hip[1] + dir[1] * a + pn[1] * h, hip[2] + dir[2] * a + pn[2] * h], foot };
    }

    computePose(t, dt = 0) {
        this.time = t;
        if (!this.rig) this.buildRig();
        const R = this.rig;
        const { fwd, right } = this.frame();
        const sl = this.slump;
        const spd = Math.hypot(this.vx, this.vz);

        this.stepFeet(dt);

        // ---- torso lean: damped spring toward speed lean + reacting to acceleration
        if (dt > 0) {
            const ax = (this.vx - (R.pvx ?? this.vx)) / dt, az = (this.vz - (R.pvz ?? this.vz)) / dt;
            R.pvx = this.vx; R.pvz = this.vz;
            const tx = fwd[0] * 0.1 * Math.min(1, spd) + ax * 0.025, tz = fwd[2] * 0.1 * Math.min(1, spd) + az * 0.025;
            for (const [k, tgt] of [[0, tx], [1, tz]]) {
                R.leanV[k] += ((tgt - R.lean[k]) * 55 - R.leanV[k] * 9) * dt;
                R.lean[k] += R.leanV[k] * dt;
                R.lean[k] = Math.max(-0.45, Math.min(0.45, R.lean[k]));
            }
        }

        // ---- pelvis: weight over the planted foot, dips on landing, low enough to reach both feet
        const swinging = R.feet.find(f => !f.planted);
        const stance = swinging ? R.feet.find(f => f.planted) : null;
        let sx = 0, sz = 0;
        if (stance) { sx = (stance.pos[0] - this.x) * 0.35; sz = (stance.pos[2] - this.z) * 0.35; }
        const sl0 = Math.hypot(sx, sz);
        if (sl0 > 0.12) { sx *= 0.12 / sl0; sz *= 0.12 / sl0; }        // weight shift is a few cm, never a lurch across the room
        if (dt > 0) { const k = Math.min(1, dt * 8); R.shift[0] += (sx - R.shift[0]) * k; R.shift[1] += (sz - R.shift[1]) * k; }
        R.landKick = Math.max(0, (R.landKick || 0) - dt * 0.25);
        const rise = swinging ? Math.sin(Math.PI * swinging.t) * 0.03 : 0;
        const k = this.s;
        let pelvisY = (1.03 + rise - (R.landKick || 0) - 0.04 * this.flinch - 0.5 * (this.crouch || 0)) * k;
        const pelvisXZ = [this.x + R.shift[0], this.z + R.shift[1]];
        for (const f of R.feet) {
            const hip = [pelvisXZ[0] + right[0] * f.side * HIP_W * k, pelvisXZ[1] + right[2] * f.side * HIP_W * k];
            const hd = Math.hypot(f.pos[0] - hip[0], f.pos[2] - hip[1]);
            const L = (THIGH + SHIN) * k * 0.985;
            const maxY = f.pos[1] + Math.sqrt(Math.max(0, L * L - hd * hd)) + 0.05 * k;
            if (maxY < pelvisY) pelvisY = maxY;
        }
        if (dt > 0) R.pelvisY += (pelvisY - R.pelvisY) * Math.min(1, dt * 20); else R.pelvisY = pelvisY;

        const J = {};
        J.pelvis = [pelvisXZ[0], R.pelvisY, pelvisXZ[1]];
        const hunch = (0.12 + 0.04 * Math.sin(t * 0.7) + 0.28 * (this.crouch || 0)) * k;
        const lx = R.lean[0] * k, lz = R.lean[1] * k;
        J.chest = [J.pelvis[0] + lx + fwd[0] * hunch, J.pelvis[1] + (0.5 - (Math.abs(R.lean[0]) + Math.abs(R.lean[1])) * 0.3) * k, J.pelvis[2] + lz + fwd[2] * hunch];
        J.neck = [J.chest[0] + lx * 0.4 + fwd[0] * 0.1 * k, J.chest[1] + 0.22 * k, J.chest[2] + lz * 0.4 + fwd[2] * 0.1 * k];

        // head: lags behind on a spring, plus nervous twitches
        const tw = Math.sin(t * 11) * Math.sin(t * 2.3) * 0.05;
        const headT = [J.neck[0] + (fwd[0] * 0.1 + right[0] * tw) * k, J.neck[1] + 0.25 * k, J.neck[2] + (fwd[2] * 0.1 + right[2] * tw) * k];
        if (!R.head || dt === 0) { R.head = headT.slice(); R.headV = [0, 0, 0]; }
        else for (let k = 0; k < 3; k++) {
            R.headV[k] += ((headT[k] - R.head[k]) * 160 - R.headV[k] * 14) * dt;
            R.head[k] += R.headV[k] * dt;
        }
        J.head = R.head.slice();

        // ---- legs
        for (const f of R.feet) {
            const sd = f.side < 0 ? 'L' : 'R';
            const hip = [J.pelvis[0] + right[0] * f.side * HIP_W * k, J.pelvis[1] - 0.05 * k, J.pelvis[2] + right[2] * f.side * HIP_W * k];
            const pole = [fwd[0] + right[0] * f.side * 0.25, 0.1, fwd[2] + right[2] * f.side * 0.25];
            const { knee, foot } = this.ik(hip, f.pos, THIGH * k, SHIN * k, pole);
            // copy: the collapse transform below edits joints in place and must not move the planted foot
            J['hi' + sd] = hip; J['kn' + sd] = knee; J['ft' + sd] = foot.slice();
        }

        // ---- arms: two-link pendulums hanging from the shoulders, reaching forward a little
        for (const a of R.arms) {
            const sd = a.side < 0 ? 'L' : 'R';
            const sh = [J.chest[0] + right[0] * a.side * SHOULDER_W * k, J.chest[1] + 0.08 * k, J.chest[2] + right[2] * a.side * SHOULDER_W * k];
            if (dt > 0) {
                const foot = R.feet[a.side < 0 ? 1 : 0];            // swing with the opposite leg
                const swing = foot.planted ? 0 : Math.sin(Math.PI * foot.t) * 6;
                const reach = 5 + 2 * this.gait;
                for (const [p, pp, gk] of [[a.el, a.elP, 0.6], [a.ha, a.haP, 1]]) {
                    const vx = (p[0] - pp[0]) * 0.9, vy = (p[1] - pp[1]) * 0.9, vz = (p[2] - pp[2]) * 0.9;
                    pp[0] = p[0]; pp[1] = p[1]; pp[2] = p[2];
                    const out = 1.2 * a.side * gk;            // arms hang close, hidden in the drape
                    const acc = [fwd[0] * (reach + swing) * gk + right[0] * out, -9.8 * gk, fwd[2] * (reach + swing) * gk + right[2] * out];
                    p[0] += vx + acc[0] * dt * dt; p[1] += vy + acc[1] * dt * dt; p[2] += vz + acc[2] * dt * dt;
                }
            }
            for (let it = 0; it < 4; it++) {
                for (const [p, q, L, fixed] of [[sh, a.el, UPPER_ARM * k, true], [a.el, a.ha, FOREARM * k, false]]) {
                    const d = sub(q, p), dl = len(d) || 1e-6, k = (dl - L) / dl;
                    if (fixed) { q[0] -= d[0] * k; q[1] -= d[1] * k; q[2] -= d[2] * k; }
                    else { p[0] += d[0] * k * 0.5; p[1] += d[1] * k * 0.5; p[2] += d[2] * k * 0.5; q[0] -= d[0] * k * 0.5; q[1] -= d[1] * k * 0.5; q[2] -= d[2] * k * 0.5; }
                }
                // keep hands/elbows out of the torso and off the floor
                for (const p of [a.el, a.ha]) {
                    const tx = p[0] - J.pelvis[0], tz = p[2] - J.pelvis[2];
                    const along = tx * right[0] + tz * right[2];
                    if (Math.abs(along) < 0.3 * k && p[1] < J.chest[1] + 0.1 * k && p[1] > J.pelvis[1] - 0.2 * k) {
                        const push = (0.3 * k - Math.abs(along)) * Math.sign(along || a.side);
                        p[0] += right[0] * push; p[2] += right[2] * push;
                    }
                    if (p[1] < 0.1) p[1] = 0.1;
                }
            }
            J['sh' + sd] = sh; J['el' + sd] = a.el.slice(); J['ha' + sd] = a.ha.slice();
        }

        // ---- collapse: sink everything toward a heap around the root
        if (sl > 0) {
            for (const name in J) {               // (not 'k': that is the size scale here)
                const j = J[name];
                j[0] = this.x + (j[0] - this.x) * (1 + sl * 1.2);
                j[2] = this.z + (j[2] - this.z) * (1 + sl * 1.2);
                j[1] = Math.max(0.12 * k, j[1] * (1 - sl * 0.85));
            }
        }
        // outdoor terrain: the rig works on a flat local floor; lift the whole body onto the ground here
        if (this.level.ground) {
            const gy = this.level.groundAt(this.x, this.z);
            this.gy = this.gy === undefined || dt === 0 ? gy : this.gy + (gy - this.gy) * Math.min(1, dt * 10);
            for (const name in J) J[name] = [J[name][0], J[name][1] + this.gy, J[name][2]];
        } else this.gy = 0;
        this.joints = J;
        this.writeBones(J, fwd, sl);
    }

    writeBones(J, fwd, sl) {
        const fx = fwd[0], fz = fwd[2];
        const bd = this.boneData;
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
            const o = i * BONE_STRIDE;
            bd[o] = a[0]; bd[o + 1] = a[1]; bd[o + 2] = a[2];
            bd[o + 3] = b[0]; bd[o + 4] = b[1]; bd[o + 5] = b[2];
            bd[o + 6] = ux; bd[o + 7] = uy; bd[o + 8] = uz;
            bd[o + 9] = vx; bd[o + 10] = vy; bd[o + 11] = vz;
            bd[o + 12] = r * this.s * (1 + sl * 0.8);
        }
    }

    // Ray vs bone capsules. Returns distance or -1.
    raycast(o, d, maxT) {
        let best = -1;
        const bd = this.boneData;
        for (let i = 0; i < this.boneCount; i++) {
            const k = i * BONE_STRIDE;
            const r = bd[k + 12] + 0.05;
            const t = raySegmentT(o, d, bd[k], bd[k + 1], bd[k + 2], bd[k + 3], bd[k + 4], bd[k + 5]);
            if (t.dist < r && t.t > 0 && t.t < maxT) {
                const hitT = t.t - Math.sqrt(Math.max(0, r * r - t.dist * t.dist));
                if (best < 0 || hitT < best) best = hitT;
            }
        }
        return best;
    }
}

// closest distance between ray and a segment, returns {t along ray, dist}
function raySegmentT(o, d, ax, ay, az, bx, by, bz) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = o.x - ax, wy = o.y - ay, wz = o.z - az;
    const a = d.x * d.x + d.y * d.y + d.z * d.z;
    const b = d.x * ux + d.y * uy + d.z * uz;
    const c = ux * ux + uy * uy + uz * uz;
    const dd = d.x * wx + d.y * wy + d.z * wz;
    const e = ux * wx + uy * wy + uz * wz;
    const den = a * c - b * b;
    let s = den > 1e-8 ? (a * e - b * dd) / den : 0;
    s = Math.max(0, Math.min(1, s));
    const t = Math.max(0, (b * s - dd) / a);
    const px = o.x + d.x * t - (ax + ux * s);
    const py = o.y + d.y * t - (ay + uy * s);
    const pz = o.z + d.z * t - (az + uz * s);
    return { t, dist: Math.hypot(px, py, pz) };
}
