import * as pc from 'playcanvas';

// The player: a hungry diner with a giant fork, built from primitives on a procedural rig.
//   legs:  planted-foot stepping + 2-bone IK (feet never slide)
//   arms:  2-bone IK toward animated hand targets (keyframed in body space)
//   head:  spring-lagged, tilts toward what he is eating, jaw chews
//   fork:  held in the right hand, its direction/roll keyframed with the strike / eat moves
// Left click = strike, right click = eat (twirl + slurp toward the mouth).

export const FORK_REACH = 1.28;    // palm -> tine tips (the Great Fork is 1.45 m long)
const THIGH = 0.46, SHIN = 0.47, UPPER = 0.31, FORE = 0.3;
const HIP_W = 0.12, FOOT_W = 0.14, SHOULDER_W = 0.23;

const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (t) => t * t * (3 - 2 * t);

// keyframes for the right hand (body space: x right, y up, z forward) and the fork direction
const POSE = {
    ready:   { hand: v3(0.24, 0.98, 0.26), dir: v3(-0.32, 0.8, 0.55) },   // two-handed, slanted across the body like a pitchfork
    windup:  { hand: v3(0.3, 1.25, -0.12), dir: v3(-0.1, 0.55, 1) },    // pulled back at the hip, tines forward
    strike:  { hand: v3(0.1, 1.0, 0.55), dir: v3(-0.05, -0.35, 1) },    // driven forward, both hands on the shaft
    reach:   { hand: v3(0.2, 0.62, 0.62), dir: v3(0, -1, 0.35) },
    mouth:   { hand: v3(0.16, 1.42, 0.32), dir: v3(-0.35, 0.35, -0.6) },
};

export class Hero {
    // visual: false builds only the rig (for tests / headless logic)
    constructor(app, level, start, { visual = true } = {}) {
        this.visual = visual;
        this.app = app;
        this.level = level;
        this.x = start.x; this.z = start.z;
        this.yaw = 0;                 // body facing (radians, 0 = +z)
        this.vx = 0; this.vz = 0;
        this.speed = 0;
        this.time = 0;
        this.health = 100;
        this.action = null;           // { type: 'strike' | 'eat', t, dur, ... }
        this.strikeActive = false;    // true during the frames a strike can hit
        this.events = [];             // 'step', 'swing', 'bite' for audio
        this.buildRig();
        if (visual) this.buildVisual();
        this.update(0, { x: 0, z: 0, sprint: false, camYaw: 0 });
    }

    // ------------------------------------------------------------------ rig
    frame() {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        return { fwd: [s, 0, c], right: [c, 0, -s] };
    }

    toWorld(p) {   // body space -> world
        const { fwd, right } = this.frame();
        return [this.x + right[0] * p[0] + fwd[0] * p[2], p[1], this.z + right[2] * p[0] + fwd[2] * p[2]];
    }

    footHome(side) {
        const { right } = this.frame();
        return [this.x + right[0] * side * FOOT_W, 0.05, this.z + right[2] * side * FOOT_W];
    }

    buildRig() {
        this.feet = [-1, 1].map(side => ({ side, pos: this.footHome(side), planted: true, from: null, t: 0, dur: 0.3 }));
        this.lastLand = -1;
        this.pelvisY = 0.98;
        this.lean = [0, 0]; this.leanV = [0, 0];
        this.head = null; this.headV = [0, 0, 0];
        this.handR = this.toWorld(POSE.ready.hand);
        this.handTarget = this.handR.slice();     // smoothed keyframe target (a skinned body IKs to it)
        this.leftTarget = null;
        this.power = 0;                           // 0..1: meatball strength (faster, harder)
        this.forkDir = norm(POSE.ready.dir);
        this.forkRoll = 0;
        this.gripSlide = 0;                 // how far the hand has slid up the shaft (eating: choke up near the tines)
        this.jaw = 0;
        this.leftSwing = 0;
    }

    stepFeet(dt) {
        const spd = Math.hypot(this.vx, this.vz);
        for (const f of this.feet) {
            const other = this.feet[f.side < 0 ? 1 : 0];
            const home = this.footHome(f.side);
            if (f.planted) {
                const off = Math.hypot(f.pos[0] - home[0], f.pos[2] - home[2]);
                const oh = this.footHome(other.side);
                const otherOff = Math.hypot(other.pos[0] - oh[0], other.pos[2] - oh[2]);
                const thresh = 0.1 + 0.06 * Math.min(1, spd / 3);
                if (dt > 0 && off > thresh && other.planted && this.time - this.lastLand > 0.05 && (off >= otherOff || otherOff < thresh)) {
                    f.planted = false; f.from = f.pos.slice(); f.t = 0;
                    f.dur = Math.max(0.15, 0.32 - spd * 0.035);
                }
            } else {
                f.t = Math.min(1, f.t + dt / f.dur);
                const lead = 0.17;
                const to = [home[0] + this.vx * lead, 0.05, home[2] + this.vz * lead];
                const c = { x: to[0], z: to[2] };
                this.level.collideCircle(c, 0.08);
                to[0] = c.x; to[2] = c.z;
                const e = smooth(f.t);
                f.pos[0] = f.from[0] + (to[0] - f.from[0]) * e;
                f.pos[2] = f.from[2] + (to[2] - f.from[2]) * e;
                f.pos[1] = 0.05 + Math.sin(Math.PI * f.t) * 0.13 * Math.min(1, 0.4 + spd / 3);
                if (f.t >= 1) { f.planted = true; f.pos[1] = 0.05; this.lastLand = this.time; this.events.push('step'); }
            }
        }
    }

    ik(root, target, l1, l2, pole) {
        let d = sub(target, root);
        let dl = len(d) || 1e-6;
        const maxR = (l1 + l2) * 0.999;
        if (dl > maxR) { d = mul(d, maxR / dl); dl = maxR; }
        const dir = mul(d, 1 / dl);
        const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
        const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
        const pd = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
        const pn = norm([pole[0] - dir[0] * pd, pole[1] - dir[1] * pd, pole[2] - dir[2] * pd]);
        return { mid: add(add(root, mul(dir, a)), mul(pn, h)), end: add(root, d) };
    }

    // ------------------------------------------------------------------ actions
    strike() {
        if (this.action) return false;
        this.action = { type: 'strike', t: 0, dur: 0.55 };
        this.events.push('swing');
        return true;
    }

    // target: world point to eat from (the game picks the nearest noodles)
    eat(target) {
        if (this.action) return false;
        this.action = { type: 'eat', t: 0, dur: 1.5, target, bites: 0 };
        return true;
    }

    // right-hand pose for the current action: returns { hand (body space), dir, roll, jaw, headDown, left }
    actionPose() {
        const a = this.action;
        const P = POSE;
        const lerpPose = (A, B, t) => ({ hand: lerp(A.hand, B.hand, t), dir: norm(lerp(A.dir, B.dir, t)) });
        if (!a) return { ...P.ready, roll: 0, jaw: 0, headDown: 0, left: null };
        const t = a.t;
        if (a.type === 'strike') {
            // windup 0-0.18, thrust 0.18-0.3 (hits), recover 0.3-0.55
            this.strikeActive = t > 0.18 && t < 0.32;
            let p;
            if (t < 0.18) p = lerpPose(P.ready, P.windup, smooth(t / 0.18));
            else if (t < 0.3) p = lerpPose(P.windup, P.strike, (t - 0.18) / 0.12);
            else p = lerpPose(P.strike, P.ready, smooth((t - 0.3) / 0.25));
            return { ...p, roll: 0, jaw: t > 0.18 && t < 0.4 ? 0.6 : 0.1, headDown: 0.15, left: null };
        }
        // eat: reach 0-0.3, twirl 0.3-0.65, lift 0.65-0.9, chew 0.9-1.5
        this.strikeActive = false;
        let p, roll = 0, jaw = 0, headDown = 0, left = null;
        if (t < 0.3) { p = lerpPose(P.ready, P.reach, smooth(t / 0.3)); headDown = 0.5 * t / 0.3; }
        else if (t < 0.65) { p = { ...P.reach }; roll = (t - 0.3) * 30; headDown = 0.5; left = v3(-0.12, 0.65, 0.55); }
        else if (t < 0.9) { p = lerpPose(P.reach, P.mouth, smooth((t - 0.65) / 0.25)); headDown = 0.5 - (t - 0.65) * 1.2; jaw = 0.8; left = v3(-0.1, 1.25, 0.35); }
        else { p = { ...P.mouth }; jaw = 0.35 + 0.35 * Math.sin((t - 0.9) * 28); headDown = -0.1; left = v3(-0.14, 1.35, 0.3); }
        // a 1.45 m fork can only reach the mouth if the hand slides up the shaft toward the tines
        const slide = t < 0.3 ? 0.55 * t / 0.3 : t < 0.65 ? 0.55 : t < 0.9 ? 0.55 + 0.3 * (t - 0.65) / 0.25 : 0.85;
        return { ...p, roll, jaw, headDown, left, slide };
    }

    // world position of the fork tines (hit point) and of the mouth (slurp target)
    get forkTip() { return add(this.handR, mul(this.forkDir, FORK_REACH - this.gripSlide)); }
    get mouth() {
        const { fwd } = this.frame();
        return [this.headPos[0] + fwd[0] * 0.13, this.headPos[1] - 0.06, this.headPos[2] + fwd[2] * 0.13];
    }
    get eating() { return this.action && this.action.type === 'eat'; }
    get slurping() { return this.eating && this.action.t > 0.6 && this.action.t < 1.2; }

    // ------------------------------------------------------------------ update
    // input: { x, z } move axes in camera space, sprint, camYaw (radians, view heading)
    update(dt, input) {
        this.time += dt;
        this.events.length = 0;
        if (this.action) {
            this.action.t += dt;
            if (this.action.t >= this.action.dur) { this.action = null; this.strikeActive = false; }
        }

        // movement relative to the camera; slower while busy
        const busy = !!this.action;
        const cs = Math.sin(input.camYaw), cc = Math.cos(input.camYaw);
        let mx = input.x * cc + input.z * cs, mz = -input.x * cs + input.z * cc;
        const ml = Math.hypot(mx, mz);
        if (ml > 1) { mx /= ml; mz /= ml; }
        const top = (input.sprint && !busy ? 4.6 : 2.9) * (busy ? 0.5 : 1) * (1 + 0.15 * this.power);
        const k = Math.min(1, dt * 9);
        this.vx += (mx * top - this.vx) * k;
        this.vz += (mz * top - this.vz) * k;
        this.x += this.vx * dt; this.z += this.vz * dt;
        const p = { x: this.x, z: this.z };
        this.level.collideCircle(p, 0.26);
        if (dt > 0) { this.vx = (p.x - (this.x - this.vx * dt)) / dt; this.vz = (p.z - (this.z - this.vz * dt)) / dt; }
        this.x = p.x; this.z = p.z;
        this.speed = Math.hypot(this.vx, this.vz);

        // face the move direction; face the view while attacking / eating
        let want = this.yaw;
        if (busy) want = input.camYaw;
        else if (this.speed > 0.3) want = Math.atan2(this.vx, this.vz);
        let dy = want - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * (busy ? 14 : 9));

        this.pose(dt);
    }

    pose(dt) {
        const { fwd, right } = this.frame();
        this.stepFeet(dt);
        const ap = this.actionPose();

        // pelvis: bob with the steps, lower while reaching down to eat
        const swing = this.feet.find(f => !f.planted);
        const bob = swing ? Math.sin(Math.PI * swing.t) * 0.035 : 0;
        const crouch = ap.headDown > 0.3 ? 0.18 : 0;
        let py = 0.98 + bob - crouch;
        for (const f of this.feet) {
            const hip = [this.x + right[0] * f.side * HIP_W, this.z + right[2] * f.side * HIP_W];
            const hd = Math.hypot(f.pos[0] - hip[0], f.pos[2] - hip[1]);
            const L = (THIGH + SHIN) * 0.985;
            py = Math.min(py, f.pos[1] + Math.sqrt(Math.max(0, L * L - hd * hd)) + 0.04);
        }
        this.pelvisY += (py - this.pelvisY) * (dt > 0 ? Math.min(1, dt * 18) : 1);

        // torso lean into acceleration / the strike
        if (dt > 0) {
            const strikeLean = this.action && this.action.type === 'strike' ? (this.strikeActive ? 0.18 : -0.06) : 0;
            const tl = [fwd[0] * (0.05 * Math.min(1, this.speed / 3) + strikeLean + ap.headDown * 0.25), fwd[2] * (0.05 * Math.min(1, this.speed / 3) + strikeLean + ap.headDown * 0.25)];
            for (let i = 0; i < 2; i++) { this.leanV[i] += ((tl[i] - this.lean[i]) * 90 - this.leanV[i] * 12) * dt; this.lean[i] += this.leanV[i] * dt; }
        }

        const J = {};
        J.pelvis = [this.x, this.pelvisY, this.z];
        J.chest = [this.x + this.lean[0], this.pelvisY + 0.46, this.z + this.lean[1]];
        J.neck = [J.chest[0] + this.lean[0] * 0.3, J.chest[1] + 0.2, J.chest[2] + this.lean[1] * 0.3];
        const headT = [J.neck[0] + fwd[0] * (0.03 + ap.headDown * 0.12), J.neck[1] + 0.17 - ap.headDown * 0.05, J.neck[2] + fwd[2] * (0.03 + ap.headDown * 0.12)];
        if (!this.head || dt === 0) { this.head = headT; this.headV = [0, 0, 0]; }
        else for (let i = 0; i < 3; i++) { this.headV[i] += ((headT[i] - this.head[i]) * 220 - this.headV[i] * 18) * dt; this.head[i] += this.headV[i] * dt; }
        J.head = this.head.slice();
        this.headPos = J.head;
        this.headDown = ap.headDown;

        // legs
        for (const f of this.feet) {
            const sd = f.side < 0 ? 'L' : 'R';
            const hip = [J.pelvis[0] + right[0] * f.side * HIP_W, J.pelvis[1] - 0.04, J.pelvis[2] + right[2] * f.side * HIP_W];
            const pole = [fwd[0] + right[0] * f.side * 0.15, 0.05, fwd[2] + right[2] * f.side * 0.15];
            const { mid, end } = this.ik(hip, f.pos, THIGH, SHIN, pole);
            J['hip' + sd] = hip; J['knee' + sd] = mid; J['foot' + sd] = end;
        }

        // right arm follows the action keyframes (smoothed so poses blend)
        const handT = this.toWorldRel(ap.hand, J);
        const kH = dt > 0 ? Math.min(1, dt * 22) : 1;
        this.handTarget = lerp(this.handTarget, handT, kH);
        this.handR = this.handTarget.slice();
        const dirW = norm(this.dirToWorld(ap.dir));
        this.forkDir = norm(lerp(this.forkDir, dirW, kH));
        this.forkRoll = ap.roll;
        this.gripSlide += ((ap.slide || 0) - this.gripSlide) * (dt > 0 ? Math.min(1, dt * 10) : 1);
        this.jaw += (ap.jaw - this.jaw) * (dt > 0 ? Math.min(1, dt * 25) : 1);

        const shR = [J.chest[0] + right[0] * SHOULDER_W, J.chest[1] + 0.1, J.chest[2] + right[2] * SHOULDER_W];
        const armR = this.ik(shR, this.handR, UPPER, FORE, [right[0] * 0.6, -0.8, right[2] * 0.6]);
        J.shR = shR; J.elR = armR.mid; J.haR = armR.end;

        // left arm: swings with the walk, or helps shovel food while eating
        this.leftSwing += dt * this.speed * 3.2;
        const sw = Math.sin(this.leftSwing) * Math.min(1, this.speed / 3);
        const leftT = ap.left ? this.toWorldRel(ap.left, J) : this.toWorldRel(v3(-0.24, 0.8, 0.04 + sw * 0.22), J);
        const shL = [J.chest[0] - right[0] * SHOULDER_W, J.chest[1] + 0.1, J.chest[2] - right[2] * SHOULDER_W];
        const armL = this.ik(shL, leftT, UPPER, FORE, [-right[0] * 0.6, -0.8, -right[2] * 0.6]);
        J.shL = shL; J.elL = armL.mid; J.haL = armL.end;
        this.leftTarget = leftT;                  // always driven: hangs and swings with the walk, shovels while eating
        // outdoor terrain: the rig runs on a flat local floor; lift every world-facing point onto the ground
        const gyT = this.level.ground ? this.level.groundAt(this.x, this.z) : 0;
        this.gy = this.gy === undefined || dt === 0 ? gyT : this.gy + (gyT - this.gy) * Math.min(1, dt * 12);
        if (this.gy) {
            const up = (v) => [v[0], v[1] + this.gy, v[2]];
            for (const k in J) J[k] = up(J[k]);
            this.headPos = J.head;
            this.handR = up(this.handTarget);
            this.leftTarget = up(leftT);
        }
        this.handTargetW = this.handR.slice();
        this.lastPose = ap;
        this.J = J;
        if (this.visual) this.place(J);
    }

    // body-space offset relative to the pelvis column (follows the body's height)
    toWorldRel(p, J) {
        const w = this.toWorld(p);
        w[1] = p[1] + (J.pelvis[1] - 0.98);
        return w;
    }

    dirToWorld(d) {
        const { fwd, right } = this.frame();
        return [right[0] * d[0] + fwd[0] * d[2], d[1], right[2] * d[0] + fwd[2] * d[2]];
    }

    // ------------------------------------------------------------------ visuals
    buildVisual() {
        const app = this.app;
        const mat = (c, gloss = 0.3, metal = 0) => {
            const m = new pc.StandardMaterial();
            m.diffuse = new pc.Color(c[0], c[1], c[2]);
            m.useMetalness = true; m.metalness = metal; m.gloss = gloss;
            m.update();
            return m;
        };
        const sweater = mat([0.42, 0.6, 0.86], 0.15), pants = mat([0.16, 0.17, 0.22], 0.2);
        const skin = mat([0.55, 0.36, 0.25], 0.35), hair = mat([0.06, 0.05, 0.05], 0.2);
        const shoe = mat([0.1, 0.08, 0.07], 0.4), napkin = mat([0.95, 0.94, 0.9], 0.2);
        const sauce = mat([0.55, 0.06, 0.03], 0.6), steel = mat([0.78, 0.79, 0.82], 0.9, 0.15);   // (fully metallic renders black without an env map)
        const dark = mat([0.05, 0.02, 0.02], 0.3);
        this.root = new pc.Entity('hero');
        app.root.addChild(this.root);
        const part = (type, m) => {
            const e = new pc.Entity();
            e.addComponent('render', { type, material: m, castShadows: true });
            e.prim = type;
            this.root.addChild(e);
            return e;
        };
        this.vis = {
            torso: part('capsule', sweater), belly: part('sphere', sweater), bib: part('box', napkin), stain: part('sphere', sauce),
            neck: part('cylinder', skin), head: part('sphere', skin), hair: part('sphere', hair), jaw: part('box', skin), mouth: part('box', dark),
            eyeL: part('sphere', dark), eyeR: part('sphere', dark), nose: part('sphere', skin), earL: part('sphere', skin), earR: part('sphere', skin),
            upperL: part('capsule', sweater), upperR: part('capsule', sweater), foreL: part('capsule', sweater), foreR: part('capsule', sweater),
            handL: part('sphere', skin), handR: part('sphere', skin),
            thighL: part('capsule', pants), thighR: part('capsule', pants), shinL: part('capsule', pants), shinR: part('capsule', pants),
            footL: part('box', shoe), footR: part('box', shoe), hips: part('capsule', pants)
        };
        // the giant fork
        this.fork = new pc.Entity('fork');
        this.root.addChild(this.fork);
        const fp = (type, m, pos, scale) => {
            const e = new pc.Entity();
            e.addComponent('render', { type, material: m, castShadows: true });
            e.setLocalPosition(...pos); e.setLocalScale(...scale);
            this.fork.addChild(e);
            return e;
        };
        // fork local space: +Y along the handle toward the tines, handle starts at the grip
        fp('cylinder', steel, [0, 0.3, 0], [0.045, 0.85, 0.045]);          // handle
        fp('sphere', steel, [0, -0.13, 0], [0.07, 0.07, 0.07]);            // pommel
        fp('box', steel, [0, 0.78, 0], [0.16, 0.12, 0.035]);               // neck / shoulder
        for (let i = 0; i < 4; i++) fp('box', steel, [-0.06 + i * 0.04, 0.96, 0], [0.018, 0.3, 0.022]);   // tines
        this.forkTwirl = [];
    }

    // put a primitive between two joints
    static setLimb(e, a, b, r) {
        const d = sub(b, a), l = len(d) || 1e-4;
        e.setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        const q = Hero.quatFromY(mul(d, 1 / l));
        e.setRotation(q);
        // PlayCanvas primitives: capsule is 2 units tall (incl. caps), cylinder 1 unit
        if (e.prim === 'cylinder') e.setLocalScale(r * 2, l, r * 2);
        else e.setLocalScale(r * 2, (l + r * 2) / 2, r * 2);
    }

    static quatFromY(dir) {
        const up = new pc.Vec3(0, 1, 0), v = new pc.Vec3(dir[0], dir[1], dir[2]);
        const dot = Math.max(-1, Math.min(1, up.dot(v)));
        const axis = new pc.Vec3().cross(up, v);
        const q = new pc.Quat();
        if (axis.length() < 1e-5) { if (dot < 0) q.setFromAxisAngle(pc.Vec3.RIGHT, 180); return q; }
        axis.normalize();
        q.setFromAxisAngle(axis, Math.acos(dot) * pc.math.RAD_TO_DEG);
        return q;
    }

    place(J) {
        const V = this.vis, L = Hero.setLimb;
        const { fwd, right } = this.frame();
        const yawDeg = this.yaw * pc.math.RAD_TO_DEG;
        L(V.torso, J.pelvis, J.chest, 0.21);
        V.belly.setPosition(J.pelvis[0] + fwd[0] * 0.08 + this.lean[0] * 0.4, J.pelvis[1] + 0.2, J.pelvis[2] + fwd[2] * 0.08 + this.lean[1] * 0.4);
        V.belly.setLocalScale(0.46, 0.42, 0.4);
        // napkin bib tucked in at the collar, sauce stain on it
        const bibC = [J.chest[0] + fwd[0] * 0.17, J.chest[1] - 0.12, J.chest[2] + fwd[2] * 0.17];
        V.bib.setPosition(...bibC); V.bib.setEulerAngles(8, yawDeg, 0); V.bib.setLocalScale(0.26, 0.32, 0.02);
        V.stain.setPosition(bibC[0] + fwd[0] * 0.012 + right[0] * 0.04, bibC[1] - 0.06, bibC[2] + fwd[2] * 0.012 + right[2] * 0.04);
        V.stain.setLocalScale(0.09, 0.07, 0.02); V.stain.setEulerAngles(8, yawDeg, 0);
        L(V.hips, [J.hipL[0], J.hipL[1] + 0.05, J.hipL[2]], [J.hipR[0], J.hipR[1] + 0.05, J.hipR[2]], 0.16);
        L(V.neck, J.chest, J.head, 0.07);
        const h = J.head;
        V.head.setPosition(...h); V.head.setLocalScale(0.25, 0.28, 0.26); V.head.setEulerAngles(-this.headDown * 30, yawDeg, 0);
        V.hair.setPosition(h[0] - fwd[0] * 0.02, h[1] + 0.07, h[2] - fwd[2] * 0.02); V.hair.setLocalScale(0.26, 0.17, 0.27); V.hair.setEulerAngles(-this.headDown * 30, yawDeg, 0);
        const face = (dx, dy, dz) => [h[0] + right[0] * dx + fwd[0] * dz, h[1] + dy, h[2] + right[2] * dx + fwd[2] * dz];
        V.eyeL.setPosition(...face(-0.05, 0.03, 0.12)); V.eyeL.setLocalScale(0.03, 0.035, 0.02);
        V.eyeR.setPosition(...face(0.05, 0.03, 0.12)); V.eyeR.setLocalScale(0.03, 0.035, 0.02);
        V.nose.setPosition(...face(0, -0.01, 0.135)); V.nose.setLocalScale(0.05, 0.05, 0.05);
        V.earL.setPosition(...face(-0.13, 0, 0)); V.earL.setLocalScale(0.04, 0.07, 0.05);
        V.earR.setPosition(...face(0.13, 0, 0)); V.earR.setLocalScale(0.04, 0.07, 0.05);
        // jaw drops open to chew / slurp
        const jawDrop = this.jaw * 0.06;
        V.mouth.setPosition(...face(0, -0.07 - jawDrop * 0.5, 0.118)); V.mouth.setLocalScale(0.08, 0.012 + jawDrop, 0.02); V.mouth.setEulerAngles(0, yawDeg, 0);
        V.jaw.setPosition(...face(0, -0.105 - jawDrop, 0.07)); V.jaw.setLocalScale(0.15, 0.05, 0.12); V.jaw.setEulerAngles(this.jaw * 12, yawDeg, 0);
        L(V.upperL, J.shL, J.elL, 0.065); L(V.foreL, J.elL, J.haL, 0.055);
        L(V.upperR, J.shR, J.elR, 0.065); L(V.foreR, J.elR, J.haR, 0.055);
        V.handL.setPosition(...J.haL); V.handL.setLocalScale(0.09, 0.09, 0.09);
        V.handR.setPosition(...J.haR); V.handR.setLocalScale(0.09, 0.09, 0.09);
        L(V.thighL, J.hipL, J.kneeL, 0.085); L(V.shinL, J.kneeL, J.footL, 0.07);
        L(V.thighR, J.hipR, J.kneeR, 0.085); L(V.shinR, J.kneeR, J.footR, 0.07);
        for (const [e, f] of [[V.footL, J.footL], [V.footR, J.footR]]) {
            e.setPosition(f[0] + fwd[0] * 0.05, Math.max(0.04, f[1] - 0.01), f[2] + fwd[2] * 0.05);
            e.setEulerAngles(0, yawDeg, 0); e.setLocalScale(0.11, 0.08, 0.26);
        }
        // fork: grip in the right hand, handle along forkDir, rolled while twirling
        const grip = sub(this.handR, mul(this.forkDir, 0.12));
        this.fork.setPosition(...grip);
        const q = Hero.quatFromY(this.forkDir);
        const roll = new pc.Quat().setFromAxisAngle(pc.Vec3.UP, this.forkRoll * pc.math.RAD_TO_DEG);
        this.fork.setRotation(q.mul(roll));
    }
}
