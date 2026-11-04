import * as pc from 'playcanvas';
import { FORK } from './fork.js';

// The player: a hungry diner with a giant fork. This is the gameplay rig: movement, actions, and the
// targets the skinned body (heromodel.js) is posed to — hand / fork / head / crouch / face. It can
// also draw itself from primitives (?prims, and the tests run it headless).
//   legs:  planted-foot stepping + 2-bone IK (feet never slide)
//   arms:  targets keyframed in body space (strike) or placed on the world (food, mouth)
//   eating: frantic, both hands: stab + twirl a forkful, stuff a fistful, chew with the cheeks full
// Left click = strike, right click (hold) = eat.

export const FORK_REACH = FORK.reach;     // palm -> tine tips
const THIGH = 0.46, SHIN = 0.47, UPPER = 0.31, FORE = 0.3;
const HIP_W = 0.12, FOOT_W = 0.14, SHOULDER_W = 0.23;

const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const seg = (u, a, b) => smooth((u - a) / (b - a));

// right palm (body space: x right, y up from the floor, z forward) and the fork's handle direction
const POSE = {
    ready:  { hand: v3(0.3, 1.0, 0.27), dir: v3(0.12, 0.96, 0.2) },       // upright at his side like a trident, forearm level
    run:    { hand: v3(0.27, 1.02, 0.26), dir: v3(0.0, 0.74, 0.67) },     // tipped forward on the run
    windup: { hand: v3(0.3, 1.52, -0.08), dir: v3(0.03, 0.1, 1) },        // raised beside the head, tines forward
    strike: { hand: v3(0.1, 1.12, 0.6), dir: v3(-0.06, -0.5, 1) },        // stabbed down and forward
    aside:  { hand: v3(0.4, 0.86, 0.1), dir: v3(0.55, 0.75, -0.35) },     // held out to the side while the left hand eats
};
const BITE = { fork: 1.05, hand: 0.9 };   // seconds per bite (x0.72 when meatball-strong: frantic)
// when, in a bite (0..1), the noodles are picked up and when they go in the mouth
export const BITE_AT = { fork: { grab: 0.24, feed: 0.7 }, hand: { grab: 0.29, feed: 0.56 } };

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
        this.events = [];             // 'step', 'swing', 'grab', 'feed' for the game / audio
        this.buildRig();
        if (visual) this.buildVisual();
        this.update(0, { x: 0, z: 0, sprint: false, camYaw: 0 });
    }

    // ------------------------------------------------------------------ rig
    frame() {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        return { fwd: [s, 0, c], right: [-c, 0, s] };      // facing +z with y up, the right hand is on -x
    }

    toWorld(p) {   // body space -> world (y stays on the local floor; terrain is added at the end)
        const { fwd, right } = this.frame();
        return [this.x + right[0] * p[0] + fwd[0] * p[2], p[1], this.z + right[2] * p[0] + fwd[2] * p[2]];
    }

    toBody(w) {    // world (with terrain height) -> body space
        const { fwd, right } = this.frame();
        const dx = w[0] - this.x, dz = w[2] - this.z;
        return [dx * right[0] + dz * right[2], w[1] - (this.gy || 0), dx * fwd[0] + dz * fwd[2]];
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
        this.leftMode = 'swing';                  // 'swing' (walking), 'open' (reaching / cupping), 'fist' (holding food)
        this.leftFist = 0;                        // 0 open .. 1 a closed fist
        this.power = 0;                           // 0..1: meatball strength (faster, harder)
        this.forkDir = norm(POSE.ready.dir);
        this.forkSide = [1, 0, 0];
        this.forkRoll = 0;
        this.gripSlide = 0;                       // how far the hand has slid up the handle toward the tines
        this.crouch = 0;                          // metres the pelvis drops (squatting over food)
        this.bow = 0;                             // 0..1 how far he folds over the food
        this.jaw = 0;                             // 0..1 mouth open
        this.cheeks = 0;                          // 0..1 cheeks stuffed
        this.mouthful = 0;                        // food in the mouth (chewing)
        this.chewT = 0;
        this.look = null;                         // world point the head turns to
        this.leftSwing = 0;
        this.mouthW = null;                       // the real mouth (set by the skinned body)
        this.air = 0; this.vy = 0;                // height of the feet above the ground (jumping) and vertical speed
        this.land = 0;                            // 1 on touchdown, fades: the landing squash
        this.emote = null; this.emoteT = 0;       // 'cheer' / 'dance' (mocap clips), and how long it lasts
        this.emoteW = 0;                          // 0..1 how much the mocap owns the arms
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

    // a dodge roll along (dx, dz) (or straight ahead): a burst of speed, a forward roll, a moment
    // the monsters can't catch him
    dodge(dx = 0, dz = 0) {
        if (this.action || this.air > 0.1) return false;
        const { fwd } = this.frame();
        let l = Math.hypot(dx, dz);
        if (l < 0.1) { dx = fwd[0]; dz = fwd[2]; l = 1; }
        this.action = { type: 'dodge', t: 0, dur: 0.62, dir: [dx / l, dz / l] };
        this.events.push('roll');
        return true;
    }

    // a celebration from the mocap library while he stands still ('cheer' / 'dance')
    celebrate(kind = 'cheer', dur = 2.6) {
        if (this.action || this.speed > 0.6) return false;
        this.emote = kind; this.emoteT = dur;
        return true;
    }

    // one bite of the food at `target` (world point): kind 'fork' (stab, twirl, shovel it in) or
    // 'hand' (grab a fistful and stuff it in). Hold the button and the game chains them.
    eat(target, kind = 'fork') {
        if (this.action) return false;
        const dur = BITE[kind] * (this.power > 0 ? 0.72 : 1);
        this.action = { type: 'eat', kind, t: 0, dur, target, fired: {} };
        return true;
    }

    // food went down: fills the mouth (the cheeks bulge, he chews harder)
    swallow(strands) { this.mouthful = Math.min(1.4, this.mouthful + 0.16 + 0.07 * strands); }

    // the current action as targets. Hands are body-space; `abs` means y is from the floor (food,
    // mouth) instead of riding with the pelvis (keyframes).
    actionPose() {
        const a = this.action, P = POSE;
        const base = { slide: 0, roll: 0, jawOpen: 0, bow: 0, crouch: 0, left: null, leftAbs: false, leftMode: 'swing', fist: 0, look: null, abs: false };
        const lerpPose = (A, B, t) => ({ hand: lerp(A.hand, B.hand, t), dir: norm(lerp(A.dir, B.dir, t)) });
        if (!a) {
            const run = clamp((this.speed - 2.4) / 1.5, 0, 1);
            return { ...base, ...lerpPose(P.ready, P.run, run) };
        }
        const t = a.t;
        if (a.type === 'dodge') {
            // tuck into a ball, fork hugged to the chest
            const u = t / a.dur, k = Math.sin(Math.PI * Math.min(1, u * 1.15));
            this.strikeActive = false;
            return { ...base, hand: v3(0.16, 1.0, 0.22), dir: v3(0.2, 0.9, 0.3), crouch: 0.42 * k, bow: k, left: v3(-0.16, 0.95, 0.24), leftMode: 'open', fist: 0.8 };
        }
        if (a.type === 'strike') {
            // windup 0-0.18, thrust 0.18-0.3 (hits), recover 0.3-0.55
            this.strikeActive = t > 0.18 && t < 0.32;
            let p;
            if (t < 0.18) p = lerpPose(P.ready, P.windup, smooth(t / 0.18));
            else if (t < 0.3) p = lerpPose(P.windup, P.strike, (t - 0.18) / 0.12);
            else p = lerpPose(P.strike, P.ready, smooth((t - 0.3) / 0.25));
            // the free hand flings out for balance as he lunges
            const bal = t < 0.18 ? smooth(t / 0.18) : t < 0.32 ? 1 : 1 - smooth((t - 0.32) / 0.23);
            return { ...base, ...p, jawOpen: t > 0.18 && t < 0.4 ? 0.7 : 0.1, bow: 0.15 * bal, left: lerp(v3(-0.24, 0.82, 0.05), v3(-0.42, 1.05, 0.22), bal), leftMode: 'open' };
        }
        this.strikeActive = false;
        const u = t / a.dur;
        const T = this.toBody(a.target);
        const M = this.toBody(this.mouth);
        const ty = T[1];
        if (a.kind === 'fork') {
            // dip 0-0.22 (stab the heap), twirl 0.22-0.47, lift 0.47-0.68, chomp 0.68-0.8, pull out
            const C = clamp(0.5 - ty * 0.8, 0.12, 0.42);
            const dDip = norm(v3(0.12, -0.72, 0.68));                          // stabbed in at an angle, arm out in front
            const dipHand = sub(T, mul(dDip, FORK.reach - 0.05));
            const SL = 0.3;                                                    // chokes up the handle to bring it to his mouth
            const offs = mul(norm(v3(0.74, -0.22, 0.62)), FORK.reach - SL - 0.03);  // across the face from the right, tips just past the lips
            const mouthHand = add(M, offs), mouthDir = norm(mul(offs, -1));
            const turns = Math.PI * 2 * 2.5;
            let hand, dir, roll = 0, crouch = C, bow = 0.85, jawOpen = 0, left, look = a.target, slide = 0;
            const cup = add(T, v3(-0.2, 0.28, -0.12));
            if (u < 0.22) {
                const s = seg(u, 0, 0.22);
                hand = add(dipHand, v3(0, 0.16 * (1 - s), -0.05 * (1 - s))); dir = dDip;
                crouch = C * s; bow = 0.85 * s; left = cup;
            } else if (u < 0.47) {
                const s = (u - 0.22) / 0.25;
                roll = s * turns;
                hand = add(dipHand, v3(Math.cos(roll) * 0.025, 0.02 * s, Math.sin(roll) * 0.025)); dir = dDip; left = cup;
            } else if (u < 0.68) {
                const s = seg(u, 0.47, 0.68);
                roll = turns + s * 1.2;
                hand = add(lerp(dipHand, mouthHand, s), v3(0, Math.sin(Math.PI * s) * 0.1, 0));
                dir = norm(lerp(dDip, mouthDir, s));
                crouch = C + (C * 0.45 - C) * s; bow = 0.85 - 0.45 * s; slide = SL * seg(u, 0.47, 0.6);
                jawOpen = seg(u, 0.56, 0.68);
                left = lerp(cup, add(M, v3(-0.06, -0.24, 0.16)), s);          // cupped under the chin, catching drips
                look = null;
            } else {
                const s = seg(u, 0.8, 1);
                roll = turns + 1.2;
                const inMouth = add(mouthHand, mul(mouthDir, 0.035));
                hand = u < 0.8 ? inMouth : lerp(inMouth, add(mouthHand, v3(0.06, -0.14, 0.08)), s);
                dir = mouthDir; crouch = C * 0.45; bow = 0.4; slide = SL * (1 - seg(u, 0.84, 1));
                jawOpen = u < 0.72 ? 1 : 0;
                left = add(M, v3(-0.06, -0.24, 0.16)); look = null;
            }
            return { ...base, hand, dir, roll, crouch, bow, jawOpen, left, leftAbs: true, leftMode: 'open', fist: 0, look, abs: true, slide };
        }
        // a fistful: reach 0-0.25, grab 0.25-0.34, lift 0.34-0.55, stuff 0.55-0.75, back down
        const C = clamp(0.62 - ty, 0.25, 0.5);
        const grabL = add(T, v3(0, 0.05, 0)), mouthL = add(M, v3(-0.015, -0.04, 0.075));
        const rest = v3(-0.24, 0.8, 0.12);
        let left, crouch = C, bow = 1, jawOpen = 0, fist = 0, look = a.target;
        if (u < 0.25) { const s = seg(u, 0, 0.25); left = lerp(add(grabL, v3(0, 0.25, -0.1)), grabL, s); crouch = C * s; bow = s; }
        else if (u < 0.34) { left = add(grabL, v3(0, -0.02, 0)); fist = seg(u, 0.25, 0.32); }
        else if (u < 0.55) {
            const s = seg(u, 0.34, 0.55);
            left = add(lerp(grabL, mouthL, s), v3(0, Math.sin(Math.PI * s) * 0.06, 0));
            fist = 1; crouch = C + (C * 0.5 - C) * s; bow = 1 - 0.55 * s; jawOpen = seg(u, 0.42, 0.55); look = null;
        } else if (u < 0.75) {
            // shove it in, wiggling
            const w = Math.sin(u * 90) * 0.012;
            left = add(mouthL, v3(w, -w * 0.5, -0.03 * seg(u, 0.55, 0.62)));
            fist = 1 - 0.4 * seg(u, 0.62, 0.75); crouch = C * 0.5; bow = 0.45; jawOpen = u < 0.66 ? 1 : 0; look = null;
        } else {
            const s = seg(u, 0.75, 1);
            left = lerp(mouthL, add(grabL, v3(0, 0.25, -0.1)), s * 0.6);
            fist = 0.6 * (1 - s); crouch = C * 0.5; bow = 0.45 + 0.3 * s; look = null;
        }
        return { ...base, ...P.aside, crouch, bow, jawOpen, left, leftAbs: true, leftMode: fist > 0.3 ? 'fist' : 'open', fist, look };
    }

    // world position of the fork tines (hit point) and of the mouth (slurp target)
    get forkTip() { return add(this.handR, mul(this.forkDir, FORK_REACH - this.gripSlide)); }
    get forkWad() { return add(this.handR, mul(this.forkDir, FORK.wad - this.gripSlide)); }
    get fist() { return this.handL || this.leftTarget; }
    get mouth() {
        if (this.mouthW) return this.mouthW;
        const { fwd } = this.frame();
        return [this.headPos[0] + fwd[0] * 0.11, this.headPos[1] - 0.08, this.headPos[2] + fwd[2] * 0.11];
    }
    get eating() { return this.action && this.action.type === 'eat'; }
    get slurping() { return this.eating && this.action.t > 0.6 && this.action.t < 1.2; }
    // the fork as the noodle sim wants it: tip, handle axis, tine plane side, roll
    get forkAnchor() { return [...this.forkTip, ...this.forkDir, ...this.forkSideW, this.forkRoll]; }

    // ------------------------------------------------------------------ update
    // input: { x, z } move axes in camera space, sprint, camYaw (radians, view heading)
    update(dt, input) {
        this.time += dt;
        this.events.length = 0;
        const a = this.action;
        if (a) {
            a.t += dt;
            if (a.type === 'eat') {
                const at = BITE_AT[a.kind], u = a.t / a.dur;
                for (const ev of ['grab', 'feed']) if (!a.fired[ev] && u >= at[ev]) { a.fired[ev] = true; this.events.push(ev); }
            }
            if (a.t >= a.dur) { this.action = null; this.strikeActive = false; }
        }

        // movement relative to the camera; slower while busy
        const busy = !!this.action;
        const { fwd } = this.frame();
        const cs = Math.sin(input.camYaw), cc = Math.cos(input.camYaw);
        // camera forward is (sin, cos); screen-right is (-cos, sin) (facing +z with y up, right is -x)
        let mx = -input.x * cc + input.z * cs, mz = input.x * cs + input.z * cc;
        const ml = Math.hypot(mx, mz);
        if (ml > 1) { mx /= ml; mz /= ml; }
        const top = (input.sprint && !busy ? 4.6 : 2.9) * (busy ? 0.5 : 1) * (1 + 0.15 * this.power);
        let tvx = mx * top, tvz = mz * top;
        const act = this.action;
        // moves the actions make on their own: these override the player's steering
        this.wantVel = null;
        if (act && act.type === 'strike' && act.t > 0.14 && act.t < 0.32) { tvx += fwd[0] * 2.6; tvz += fwd[2] * 2.6; this.wantVel = [tvx, tvz]; }   // lunge into the stab
        if (act && act.type === 'eat' && act.t / act.dur < 0.3) {
            // shuffle up to the food: the tines reach ~0.8 m out, the hand ~0.5
            const dx = act.target[0] - this.x, dz = act.target[2] - this.z, d = Math.hypot(dx, dz) || 1;
            const gap = d - (act.kind === 'fork' ? 0.78 : 0.5);
            if (Math.abs(gap) > 0.05) { const v = clamp(gap * 7, -1.5, 2.6); tvx = dx / d * v; tvz = dz / d * v; }
            this.wantVel = [tvx, tvz];
        } else if (act && act.type === 'eat') this.wantVel = [0, 0];                  // planted while he eats
        if (input.external) {
            // a physics capsule (the PlayCanvas character controller) moves the body; the rig follows it
            const e = input.external;
            this.x = e.x; this.z = e.z; this.vx = e.vx; this.vz = e.vz;
            const wasAir = this.air;
            this.air = e.air || 0; this.vy = e.vy || 0;
            if (wasAir > 0.12 && this.air < 0.04) { this.land = Math.min(1, 0.4 + wasAir * 1.5 + Math.max(0, -this.vy) * 0.1); this.events.push('land'); }
        } else {
            const k = Math.min(1, dt * 9);
            this.vx += (tvx - this.vx) * k;
            this.vz += (tvz - this.vz) * k;
            this.x += this.vx * dt; this.z += this.vz * dt;
            const p = { x: this.x, z: this.z };
            this.level.collideCircle(p, 0.26);
            if (dt > 0) { this.vx = (p.x - (this.x - this.vx * dt)) / dt; this.vz = (p.z - (this.z - this.vz * dt)) / dt; }
            this.x = p.x; this.z = p.z;
        }
        this.speed = Math.hypot(this.vx, this.vz);

        // face the move direction; face the view while fighting, the food while eating
        let want = this.yaw;
        if (act && act.type === 'dodge') {
            const u = act.t / act.dur, v = u < 0.8 ? 6.2 * (1 - u * 0.7) : 1.5;     // a burst, easing off
            this.wantVel = [act.dir[0] * v, act.dir[1] * v];
            if (!input.external) { this.vx = this.wantVel[0]; this.vz = this.wantVel[1]; }
        }
        this.land = Math.max(0, this.land - dt * 3.5);
        // celebrations end when he moves or does anything else
        if (this.emote && ((this.emoteT -= dt) <= 0 || this.speed > 0.6 || act)) this.emote = null;
        this.emoteW += ((this.emote ? 1 : 0) - this.emoteW) * Math.min(1, dt * 5);
        if (act && act.type === 'dodge') want = Math.atan2(act.dir[0], act.dir[1]);
        else if (act && act.type === 'eat') want = Math.atan2(act.target[0] - this.x, act.target[2] - this.z);
        else if (busy) want = input.camYaw;
        else if (this.speed > 0.3) want = Math.atan2(this.vx, this.vz);
        let dy = want - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yawRate = dt > 0 ? dy * Math.min(1, dt * (busy ? 14 : 11)) / dt : 0;   // for banking into turns
        this.yaw += dy * Math.min(1, dt * (busy ? 14 : 11));

        // chewing never stops while there is food in his mouth
        this.mouthful = Math.max(0, this.mouthful - dt * 0.2);
        this.chewT += dt * Math.PI * 2 * (this.power > 0 ? 5.2 : 4.2);

        this.pose(dt);
    }

    pose(dt) {
        const { fwd, right } = this.frame();
        this.stepFeet(dt);
        const ap = this.actionPose();
        const ease = (cur, to, rate) => cur + (to - cur) * (dt > 0 ? Math.min(1, dt * rate) : 1);
        this.crouch = ease(this.crouch, ap.crouch, 9);
        this.bow = ease(this.bow, ap.bow, 10);
        this.look = ap.look;

        // pelvis: bob with the steps, squat over food
        const swing = this.feet.find(f => !f.planted);
        const bob = swing ? Math.sin(Math.PI * swing.t) * 0.035 : 0;
        let py = 0.98 + bob - this.crouch;
        for (const f of this.feet) {
            const hip = [this.x + right[0] * f.side * HIP_W, this.z + right[2] * f.side * HIP_W];
            const hd = Math.hypot(f.pos[0] - hip[0], f.pos[2] - hip[1]);
            const L = (THIGH + SHIN) * 0.985;
            py = Math.min(py, f.pos[1] + Math.sqrt(Math.max(0, L * L - hd * hd)) + 0.04);
        }
        this.pelvisY += (py - this.pelvisY) * (dt > 0 ? Math.min(1, dt * 18) : 1);

        // torso lean into acceleration / the strike / over the food
        if (dt > 0) {
            const strikeLean = this.action && this.action.type === 'strike' ? (this.strikeActive ? 0.18 : -0.06) : 0;
            const f = 0.05 * Math.min(1, this.speed / 3) + strikeLean + this.bow * 0.3;
            const tl = [fwd[0] * f, fwd[2] * f];
            for (let i = 0; i < 2; i++) { this.leanV[i] += ((tl[i] - this.lean[i]) * 90 - this.leanV[i] * 12) * dt; this.lean[i] += this.leanV[i] * dt; }
        }
        this.headDown = this.bow * 0.6;

        const J = {};
        J.pelvis = [this.x, this.pelvisY, this.z];
        J.chest = [this.x + this.lean[0], this.pelvisY + 0.46 - this.bow * 0.08, this.z + this.lean[1]];
        J.neck = [J.chest[0] + this.lean[0] * 0.3, J.chest[1] + 0.2, J.chest[2] + this.lean[1] * 0.3];
        const headT = [J.neck[0] + fwd[0] * (0.03 + this.headDown * 0.12), J.neck[1] + 0.17 - this.headDown * 0.05, J.neck[2] + fwd[2] * (0.03 + this.headDown * 0.12)];
        if (!this.head || dt === 0) { this.head = headT; this.headV = [0, 0, 0]; }
        else for (let i = 0; i < 3; i++) { this.headV[i] += ((headT[i] - this.head[i]) * 220 - this.headV[i] * 18) * dt; this.head[i] += this.headV[i] * dt; }
        J.head = this.head.slice();
        this.headPos = J.head;

        // legs
        for (const f of this.feet) {
            const sd = f.side < 0 ? 'L' : 'R';
            const hip = [J.pelvis[0] + right[0] * f.side * HIP_W, J.pelvis[1] - 0.04, J.pelvis[2] + right[2] * f.side * HIP_W];
            const pole = [fwd[0] + right[0] * f.side * 0.15, 0.05, fwd[2] + right[2] * f.side * 0.15];
            const { mid, end } = this.ik(hip, f.pos, THIGH, SHIN, pole);
            J['hip' + sd] = hip; J['knee' + sd] = mid; J['foot' + sd] = end;
        }

        // right hand follows the action (smoothed so poses blend)
        const handT = ap.abs ? this.toWorld(ap.hand) : this.toWorldRel(ap.hand, J);
        const kH = dt > 0 ? Math.min(1, dt * 22) : 1;
        this.handTarget = lerp(this.handTarget, handT, kH);
        this.handR = this.handTarget.slice();
        const dirW = norm(this.dirToWorld(ap.dir));
        this.forkDir = norm(lerp(this.forkDir, dirW, kH));
        this.forkSideW = right.slice();
        this.forkRoll = ap.roll;
        this.gripSlide = ease(this.gripSlide, ap.slide, 16);
        // the face: mouth wide for a bite, otherwise chewing; cheeks bulge with food
        const chew = this.mouthful > 0.03 ? (0.18 + 0.32 * (0.5 + 0.5 * Math.sin(this.chewT))) * Math.min(1, this.mouthful * 1.6) : 0;
        this.jaw = ease(this.jaw, Math.max(ap.jawOpen, chew), 25);
        this.cheeks = ease(this.cheeks, Math.min(1, this.mouthful), 6);

        const shR = [J.chest[0] + right[0] * SHOULDER_W, J.chest[1] + 0.1, J.chest[2] + right[2] * SHOULDER_W];
        const armR = this.ik(shR, this.handR, UPPER, FORE, [right[0] * 0.6, -0.8, right[2] * 0.6]);
        J.shR = shR; J.elR = armR.mid; J.haR = armR.end;

        // left hand: swings with the walk, or grabs / cups food
        this.leftSwing += dt * this.speed * 3.2;
        const sw = Math.sin(this.leftSwing) * Math.min(1, this.speed / 3);
        const leftT = ap.left ? (ap.leftAbs ? this.toWorld(ap.left) : this.toWorldRel(ap.left, J)) : this.toWorldRel(v3(-0.24, 0.8, 0.04 + sw * 0.22), J);
        this.leftSmooth = this.leftSmooth && dt > 0 ? lerp(this.leftSmooth, leftT, Math.min(1, dt * 20)) : leftT;
        this.leftMode = ap.leftMode;
        this.leftFist = ease(this.leftFist, ap.fist, 20);
        const shL = [J.chest[0] - right[0] * SHOULDER_W, J.chest[1] + 0.1, J.chest[2] - right[2] * SHOULDER_W];
        const armL = this.ik(shL, this.leftSmooth, UPPER, FORE, [-right[0] * 0.6, -0.8, -right[2] * 0.6]);
        J.shL = shL; J.elL = armL.mid; J.haL = armL.end;
        this.leftTarget = this.leftSmooth;
        // outdoor terrain: the rig runs on a flat local floor; lift every world-facing point onto the ground
        const gyT = this.level.ground ? this.level.groundAt(this.x, this.z) : 0;
        this.gy = this.gy === undefined || dt === 0 ? gyT : this.gy + (gyT - this.gy) * Math.min(1, dt * 12);
        const lift = this.gy + this.air;            // terrain height, plus the jump
        if (lift) {
            const up = (v) => [v[0], v[1] + lift, v[2]];
            for (const k in J) J[k] = up(J[k]);
            this.headPos = J.head;
            this.handR = up(this.handTarget);
            this.leftTarget = up(this.leftSmooth);
        }
        this.handTargetW = this.handR.slice();
        if (!this.visual) { this.handL = J.haL; }
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
