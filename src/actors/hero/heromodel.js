import * as pc from 'playcanvas';
import { buildForkMesh, forkMaterial, forkRotation } from './fork.js';
import { SaucePaint } from './saucepaint.js';

// The hero's body: a realistic skinned human (Microsoft Rocketbox, MIT) driven by mocap clips
// (idle / walk / run, blended by speed), with procedural layers on top for what mocap can't know:
//   - legs: squat over food with 2-bone IK that keeps the feet planted (each foot on its own ground)
//   - spine / neck: fold over the plate, lean into strikes, look at the food
//   - right arm: IK to the fork keyframes, a hammer grip whose wrist follows the forearm
//   - left arm: swings with the stride, reaches, grabs a fistful, cups under the chin
//   - face: jaw, cheeks stuffed with food, lips, and sauce smeared around the mouth as he eats
// The Hero class owns gameplay (movement, actions, hit points); this only makes it look real.

const B = {
    root: 'hero', pelvis: 'Bip01 Pelvis', spine0: 'Bip01 Spine', spine: 'Bip01 Spine1', spine2: 'Bip01 Spine2', neck: 'Bip01 Neck', head: 'Bip01 Head',
    jaw: 'Bip01 MJaw', lipU: 'Bip01 MUpperLip', lipD: 'Bip01 MBottomLip', cornerL: 'Bip01 LMouthCorner', cornerR: 'Bip01 RMouthCorner',
    cheekL: 'Bip01 LCheek', cheekR: 'Bip01 RCheek', masL: 'Bip01 LMasseter', masR: 'Bip01 RMasseter', nose: 'Bip01 MNose',
    clavR: 'Bip01 R Clavicle', upR: 'Bip01 R UpperArm', foreR: 'Bip01 R Forearm', handR: 'Bip01 R Hand',
    clavL: 'Bip01 L Clavicle', upL: 'Bip01 L UpperArm', foreL: 'Bip01 L Forearm', handL: 'Bip01 L Hand',
    thighL: 'Bip01 L Thigh', calfL: 'Bip01 L Calf', footL: 'Bip01 L Foot', thighR: 'Bip01 R Thigh', calfR: 'Bip01 R Calf', footR: 'Bip01 R Foot'
};
const WALK_SPEED = 1.39, RUN_SPEED = 3.06;     // metres / second the clips were captured at

const V = (e) => e.getPosition().clone();
const tmpQ = new pc.Quat(), tmpQ2 = new pc.Quat();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fromTo(a, b) {
    const an = a.clone().normalize(), bn = b.clone().normalize();
    const d = Math.max(-1, Math.min(1, an.dot(bn)));
    const axis = new pc.Vec3().cross(an, bn);
    if (axis.length() < 1e-6) return new pc.Quat();
    return new pc.Quat().setFromAxisAngle(axis.normalize(), Math.acos(d) * pc.math.RAD_TO_DEG);
}
// rotate a bone (in world space) so the direction from -> to turns toward from -> target
function aim(bone, from, to, target) {
    const q = fromTo(to.clone().sub(from), target.clone().sub(from));
    bone.setRotation(tmpQ.copy(q).mul(bone.getRotation()));
}
function rotateWorld(bone, axis, deg) {
    tmpQ2.setFromAxisAngle(axis, deg);
    bone.setRotation(tmpQ.copy(tmpQ2).mul(bone.getRotation()));
}
// signed angle (deg) from a to b around axis, both projected onto the plane normal to axis
function twist(a, b, axis) {
    const pa = a.clone().sub(axis.clone().mulScalar(a.dot(axis))), pb = b.clone().sub(axis.clone().mulScalar(b.dot(axis)));
    if (pa.lengthSq() < 1e-8 || pb.lengthSq() < 1e-8) return 0;
    pa.normalize(); pb.normalize();
    const s = new pc.Vec3().cross(pa, pb).dot(axis);
    return Math.atan2(s, pa.dot(pb)) * pc.math.RAD_TO_DEG;
}
const offsetWorld = (bone, d) => { const p = bone.getPosition(); bone.setPosition(p.x + d.x, p.y + d.y, p.z + d.z); };

export class HeroModel {
    static async load(app, url) {
        const asset = await new Promise((res, rej) => {
            const a = new pc.Asset('hero-model', 'container', { url });
            app.assets.add(a);
            a.once('error', rej);
            a.ready(() => res(a));
            app.assets.load(a);
        });
        return asset;
    }

    constructor(app, asset, hero, { envLit = !!app.scene.envAtlas } = {}) {
        this.app = app;
        this.hero = hero;
        this.entity = new pc.Entity('hero-body');
        app.root.addChild(this.entity);
        const model = asset.resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true });
        this.entity.addChild(model);
        this.model = model;
        this.bones = {};
        for (const [k, n] of Object.entries(B)) this.bones[k] = model.findByName(n);
        this.tuneMaterials(model);

        // locomotion: idle <-> (walk/run blend, phase-synced)
        model.addComponent('anim', { activate: true });
        const P = pc.ANIM_PARAMETER_FLOAT;
        model.anim.loadStateGraph({
            layers: [{
                name: 'base',
                states: [{ name: 'START' }, { name: 'Idle', speed: 1, loop: true }, {
                    name: 'Move', speed: 1, loop: true,
                    blendTree: { type: pc.ANIM_BLEND_1D, parameter: 'speed', syncAnimations: true, children: [{ name: 'walk', point: WALK_SPEED }, { name: 'run', point: RUN_SPEED }] }
                }],
                transitions: [
                    { from: 'START', to: 'Idle' },
                    { from: 'Idle', to: 'Move', time: 0.18, conditions: [{ parameterName: 'speed', predicate: pc.ANIM_GREATER_THAN, value: 0.35 }] },
                    { from: 'Move', to: 'Idle', time: 0.25, conditions: [{ parameterName: 'speed', predicate: pc.ANIM_LESS_THAN, value: 0.25 }] }
                ]
            }],
            parameters: { speed: { name: 'speed', type: P, value: 0 } }
        });
        const clip = (name) => asset.resource.animations.find(a => a.resource.name === name || a.name.endsWith(name))?.resource;
        model.anim.assignAnimation('Idle', clip('idle'));
        model.anim.assignAnimation('Move.walk', clip('walk'));
        model.anim.assignAnimation('Move.run', clip('run'));

        // the Great Fork
        this.fork = new pc.Entity('fork');
        this.fork.addComponent('render', { meshInstances: [new pc.MeshInstance(buildForkMesh(app.graphicsDevice), forkMaterial(envLit))], castShadows: true });
        app.root.addChild(this.fork);

        this.power = 0;
        this.mess = 0;              // 0..1 how much sauce is smeared on his face
        this.palmOff = { R: new pc.Vec3(), L: new pc.Vec3() };
        this.sauce = new SaucePaint(model);
    }

    tuneMaterials(model) {
        for (const r of model.findComponents('render')) for (const mi of r.meshInstances) {
            const m = mi.material;
            if (!m || !m.name) continue;
            if (m.name.includes('opacity')) { m.alphaTest = 0.35; m.blendType = pc.BLEND_NONE; m.depthWrite = true; }
            m.useMetalness = true; m.metalness = 0;
            if (m.name.includes('head')) { m.gloss = 0.5; m.specularityFactor = 0.55; }     // a little sweat and grease
            else { m.gloss = 0.14; m.specularityFactor = 0.1; }                               // denim and cotton: matte
            m.update();
        }
    }

    // more sauce on the face (called as he eats); cleared on a new game
    smear(amount) { this.mess = Math.min(1, this.mess + amount); }
    clean() { this.mess = 0; }

    // called every frame AFTER the hero rig update (and after the anim system ran)
    update(dt) {
        const h = this.hero, b = this.bones, e = this.entity, level = h.level;
        const k = 1 + 0.18 * this.power;          // spinach-strong: a bigger, bulkier diner
        const gy = h.gy || 0;
        e.setPosition(h.x, gy, h.z);
        e.setEulerAngles(0, h.yaw * pc.math.RAD_TO_DEG, 0);
        e.setLocalScale(k, k, k);
        const spd = h.speed / k;
        this.model.anim.setFloat('speed', spd);
        // match the clip's stride to the ground speed (feet don't skate)
        const nat = spd < WALK_SPEED ? WALK_SPEED : spd > RUN_SPEED ? RUN_SPEED : spd;
        this.model.anim.speed = spd > 0.35 ? Math.min(1.6, Math.max(0.6, spd / nat)) : 1;

        // remove the captured root motion (the game moves the body)
        const rp = b.root.getLocalPosition();
        b.root.setLocalPosition(0, rp.y, 0);

        const { fwd, right } = h.frame();
        const R = new pc.Vec3(right[0], 0, right[2]), F = new pc.Vec3(fwd[0], 0, fwd[2]);
        const Ax = R.clone().mulScalar(-1);        // pitch axis: a positive turn about it tips the body forward

        // ---- legs: squat, and plant each foot on its own patch of ground
        const feet = [['L', b.thighL, b.calfL, b.footL], ['R', b.thighR, b.calfR, b.footR]].map(([s, th, ca, fo]) => {
            const p = V(fo), rot = fo.getRotation().clone();
            const g = level && level.ground ? clamp(level.groundAt(p.x, p.z) - gy, -0.3, 0.3) : 0;
            return { s, th, ca, fo, rot, target: new pc.Vec3(p.x, p.y + g, p.z), g };
        });
        // the stride phase (for the free arm's swing): which foot is ahead
        this.stride = feet[1].target.clone().sub(feet[0].target).dot(F);
        const drop = h.crouch * k + Math.max(0, -Math.min(feet[0].g, feet[1].g));
        if (drop > 0.002) {
            // squat: hips back and down, feet stay put; knees push forward over the toes
            const pp = V(b.pelvis);
            b.pelvis.setPosition(pp.x - F.x * drop * 0.35, pp.y - drop, pp.z - F.z * drop * 0.35);
            rotateWorld(b.pelvis, Ax, h.crouch * 25);
        }
        for (const f of feet) {
            if (drop <= 0.002 && Math.abs(f.g) < 0.005) continue;
            const side = f.s === 'L' ? -1 : 1;
            const out = (0.15 + h.crouch * 0.8) * side;
            this.ik(f.th, f.ca, f.fo, f.target, new pc.Vec3(F.x + R.x * out, 0.05, F.z + R.z * out));
            f.fo.setRotation(f.rot);                 // keep the sole flat on the ground
        }

        // ---- torso: fold over the food, lean into the strike, twist into the swing
        const lean = (h.lean[0] * fwd[0] + h.lean[1] * fwd[2]) / 0.46;
        const fold = h.bow * 48 - h.crouch * 25;     // the squatting hips already tip him forward
        rotateWorld(b.spine0, Ax, fold * 0.35);
        rotateWorld(b.spine, Ax, lean * 30 + fold * 0.35);
        rotateWorld(b.spine2, Ax, fold * 0.3);
        if (h.action && h.action.type === 'strike') {
            const t = h.action.t;
            const tw = t < 0.18 ? -16 * t / 0.18 : t < 0.32 ? -16 + 36 * (t - 0.18) / 0.14 : 20 * (1 - (t - 0.32) / 0.23);
            rotateWorld(b.spine2, pc.Vec3.UP, tw);
        }

        // ---- head: look at the food while digging in, otherwise eyes front (he stares, chewing)
        const head0 = V(b.head);
        let pitch = -h.bow * 24;                      // keep the face up while folded
        if (h.look) {
            const lx = h.look[0] - head0.x, lz = h.look[2] - head0.z, ly = head0.y - h.look[1];
            const want = Math.atan2(ly, Math.hypot(lx, lz)) * pc.math.RAD_TO_DEG;   // degrees below horizontal
            pitch = clamp(want - (h.bow * 48 - h.crouch * 25) - 10, -30, 40);
        }
        this.pitch = this.pitch === undefined ? pitch : this.pitch + (pitch - this.pitch) * Math.min(1, dt * 10);
        const nod = (h.cheeks || 0) * Math.sin(h.chewT || 0) * 3;      // chewing hard bobs the head
        rotateWorld(b.neck, Ax, this.pitch * 0.55 + nod * 0.4);
        rotateWorld(b.head, Ax, this.pitch * 0.45 + nod);

        // ---- face
        this.face(dt, R, F, Ax);

        // ---- right arm -> fork keyframe target; the shoulder shrugs up when the hand is high
        const lift = (v) => { const p = new pc.Vec3(...v); p.y = gy + (p.y - gy) * k; return p; };   // keyframes are for the unscaled body
        const dir = new pc.Vec3(...h.forkDir).normalize();
        const handT = lift(h.handTargetW || h.handTarget);
        this.shrug(b.clavR, b.upR, handT, F);
        const poleR = h.eating ? new pc.Vec3(R.x * 0.9 - F.x * 0.1, -0.6, R.z * 0.9 - F.z * 0.1) : new pc.Vec3(R.x * 0.5 - F.x * 0.3, -1, R.z * 0.5 - F.z * 0.3);
        this.ik(b.upR, b.foreR, b.handR, handT.clone().sub(this.palmOff.R), poleR);
        const palmR = this.grip(dir, h.forkRoll);
        this.palmOff.R.copy(palmR).sub(V(b.handR));

        // ---- left arm
        let lt;
        if (h.leftMode === 'swing' || !h.leftTarget) {
            // hangs relaxed and swings opposite the left foot
            const sh = V(b.upL), sw = clamp(this.stride / 0.4, -1, 1) * Math.min(1, h.speed / 1.2);
            lt = sh.add(new pc.Vec3(-R.x * 0.07 + F.x * (0.06 + 0.2 * sw), -0.54 * k, -R.z * 0.07 + F.z * (0.06 + 0.2 * sw)));
        } else lt = lift(h.leftTarget);
        this.shrug(b.clavL, b.upL, lt, F);
        const poleL = new pc.Vec3(-R.x * 0.7 - F.x * 0.2, -0.7, -R.z * 0.7 - F.z * 0.2);
        this.ik(b.upL, b.foreL, b.handL, lt.clone().sub(this.palmOff.L), poleL);
        const palmL = this.leftHand(h, R, F);
        this.palmOff.L.copy(palmL).sub(V(b.handL));

        // ---- fork: its grip (origin) sits in the right palm
        this.fork.setPosition(palmR.clone().sub(dir.clone().mulScalar((h.gripSlide || 0) * k)));   // choked up the handle
        this.fork.setRotation(forkRotation(h.forkDir, h.forkSideW || right, h.forkRoll * pc.math.RAD_TO_DEG));
        this.fork.setLocalScale(k, k, k);

        // ---- report the real hand / head / mouth back to the gameplay rig
        h.handR = [palmR.x, palmR.y, palmR.z];
        h.handL = [palmL.x, palmL.y, palmL.z];
        const head = V(b.head);
        h.headPos = [head.x + fwd[0] * 0.04, head.y + 0.06, head.z + fwd[2] * 0.04];
        if (b.lipU && b.lipD) {
            const m = V(b.lipU).add(V(b.lipD)).mulScalar(0.5);
            h.mouthW = [m.x + fwd[0] * 0.015, m.y, m.z + fwd[2] * 0.015];
        }
        this.sauce.set(this.mess);
    }

    // jaw open / chewing, cheeks stuffed, lips pushed out while slurping
    face(dt, R, F, Ax) {
        const h = this.hero, b = this.bones;
        if (!b.jaw) return;
        const jaw = h.jaw || 0, cheeks = h.cheeks || 0;
        rotateWorld(b.jaw, Ax, jaw * 24);
        const puff = cheeks * 0.011;
        if (b.cheekL && b.cheekR) {
            offsetWorld(b.cheekL, new pc.Vec3(-R.x * puff + F.x * puff * 0.3, -puff * 0.2, -R.z * puff + F.z * puff * 0.3));
            offsetWorld(b.cheekR, new pc.Vec3(R.x * puff + F.x * puff * 0.3, -puff * 0.2, R.z * puff + F.z * puff * 0.3));
        }
        if (b.masL && b.masR) {
            const m = cheeks * 0.004 * (0.6 + 0.4 * Math.sin(h.chewT || 0));
            offsetWorld(b.masL, new pc.Vec3(-R.x * m, 0, -R.z * m));
            offsetWorld(b.masR, new pc.Vec3(R.x * m, 0, R.z * m));
        }
        // slurping: an "o" with the lips pushed out, corners pulled in
        const sl = Math.min(1, cheeks * 1.5) * (1 - jaw);
        if (b.lipU && b.lipD && b.cornerL && b.cornerR) {
            const fw = F.clone().mulScalar(0.007 * sl);
            offsetWorld(b.lipU, fw); offsetWorld(b.lipD, fw);
            offsetWorld(b.cornerL, new pc.Vec3(R.x * 0.004 * sl, 0, R.z * 0.004 * sl));
            offsetWorld(b.cornerR, new pc.Vec3(-R.x * 0.004 * sl, 0, -R.z * 0.004 * sl));
        }
    }

    // raise the shoulder (clavicle) when the hand goes above it, like a real reach
    shrug(clav, up, target, F) {
        if (!clav) return;
        const s = V(up), d = target.y - s.y;
        if (d <= 0.02) return;
        const side = new pc.Vec3().sub2(s, V(clav)).normalize();
        const axis = new pc.Vec3().cross(side, pc.Vec3.UP).normalize();
        rotateWorld(clav, axis, -clamp(d * 40, 0, 16));
    }

    fingers(side) {
        this._fingers ||= {};
        if (this._fingers[side] !== undefined) return this._fingers[side];
        const Fn = (n) => this.model.findByName(`Bip01 ${side} Finger${n}`);
        const chain = (k) => [Fn(k), Fn(k + '1'), Fn(k + '2')].filter(Boolean);
        const r = { thumb: chain('0'), index: chain('1'), middle: chain('2'), ring: chain('3'), pinky: chain('4') };
        this._fingers[side] = r.index.length && r.pinky.length && r.middle.length && r.thumb.length ? r : null;
        return this._fingers[side];
    }

    // the hand's frame from its bones: knuckle line (pinky -> index), finger direction, palm normal
    handFrame(side) {
        const f = this.fingers(side), hand = this.bones[side === 'R' ? 'handR' : 'handL'];
        const H = V(hand);
        const across = V(f.index[0]).sub(V(f.pinky[0])).normalize();
        const fdir = V(f.middle[0]).sub(H).normalize();
        const n = new pc.Vec3().cross(fdir, across).normalize();
        if (V(f.thumb[0]).sub(H).dot(n) < 0) n.mulScalar(-1);     // palm side: the thumb sits on it
        return { H, across, fdir, n, f, hand };
    }

    // curl each finger segment around an axis through `centre` (toward it), by the given angles
    wrap(f, axis, centre, angles, scale = 1) {
        const axisDist = (p) => { const d = p.clone().sub(centre); return d.sub(axis.clone().mulScalar(d.dot(axis))).length(); };
        for (const chain of [f.index, f.middle, f.ring, f.pinky]) chain.forEach((bone, j) => {
            const tip = chain[j + 1] || null;
            const probe = () => tip ? V(tip) : V(bone).add(V(bone).sub(V(chain[j - 1] || bone.parent)).mulScalar(0.8));
            const d0 = axisDist(probe());
            rotateWorld(bone, axis, angles[j] * scale);
            if (axisDist(probe()) > d0) rotateWorld(bone, axis, -2 * angles[j] * scale);
        });
    }

    // Right hand: a hammer grip. The knuckle line turns onto the handle, the fingers keep following the
    // forearm (no broken wrist), the fingers and thumb close around the handle. Returns the palm centre.
    grip(dir, roll) {
        const hand = this.bones.handR;
        if (!this.fingers('R')) return V(hand);
        let fr = this.handFrame('R');
        hand.setRotation(tmpQ.copy(fromTo(fr.across, dir)).mul(hand.getRotation()));
        fr = this.handFrame('R');
        const fa = fr.H.clone().sub(V(this.bones.foreR)).normalize();
        rotateWorld(hand, dir, clamp(twist(fr.fdir, fa, dir), -80, 80));
        if (roll) rotateWorld(hand, dir, Math.sin(roll) * 22);             // the wrist rocks while twirling
        fr = this.handFrame('R');
        const palm = fr.H.clone().add(fr.fdir.clone().mulScalar(0.07)).add(fr.n.clone().mulScalar(0.03));
        this.wrap(fr.f, dir, palm, [55, 72, 48]);
        const thumbAxis = new pc.Vec3().cross(dir, fr.n).normalize();
        fr.f.thumb.forEach((bone, j) => rotateWorld(bone, thumbAxis, j === 0 ? 8 : 28));
        return palm;
    }

    // Left hand: palm down to grab, a closing fist holding food, palm toward the mouth to stuff it in
    leftHand(h, R, F) {
        const hand = this.bones.handL;
        if (!this.fingers('L')) return V(hand);
        let fr = this.handFrame('L');
        const fa = fr.H.clone().sub(V(this.bones.foreL)).normalize();
        if (h.leftMode !== 'swing') {
            // which way the palm should face: down at the food, toward the face near the mouth
            const mouth = h.mouthW ? new pc.Vec3(...h.mouthW) : fr.H.clone().add(pc.Vec3.UP);
            const near = clamp(1 - (fr.H.distance(mouth) - 0.12) / 0.25, 0, 1);
            const toFace = mouth.clone().sub(fr.H).normalize();
            const want = new pc.Vec3(0, -1, 0).lerp(new pc.Vec3(0, -1, 0), toFace, near).normalize();
            // tip the fingers down toward the food when reaching low
            const reach = clamp((V(this.bones.upL).y - fr.H.y - 0.25) / 0.35, 0, 1);
            if (reach > 0) { const down = fa.clone().lerp(fa, new pc.Vec3(F.x * 0.5, -1, F.z * 0.5).normalize(), 0.45 * reach); hand.setRotation(tmpQ.copy(fromTo(fr.fdir, down)).mul(hand.getRotation())); fr = this.handFrame('L'); }
            rotateWorld(hand, fa, clamp(twist(fr.n, want, fa), -100, 100));
            fr = this.handFrame('L');
        }
        const palm = fr.H.clone().add(fr.fdir.clone().mulScalar(0.065)).add(fr.n.clone().mulScalar(0.025));
        const fist = h.leftMode === 'swing' ? 0.25 : (h.leftFist || 0);
        this.wrap(fr.f, fr.across, palm, [62, 80, 58], 0.12 + fist * 0.88);
        const thumbAxis = new pc.Vec3().cross(fr.fdir, fr.n).normalize();
        fr.f.thumb.forEach((bone, j) => rotateWorld(bone, thumbAxis, j === 0 ? 0 : 30 * fist));
        return palm;
    }

    ik(up, fore, hand, target, pole) {
        const A = V(up), Bp = V(fore), C = V(hand);
        const l1 = Bp.distance(A), l2 = C.distance(Bp);
        const d = target.clone().sub(A);
        let dl = d.length() || 1e-6;
        const maxR = (l1 + l2) * 0.995;
        if (dl > maxR) { d.mulScalar(maxR / dl); dl = maxR; }
        const dir = d.clone().mulScalar(1 / dl);
        const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
        const hgt = Math.sqrt(Math.max(0, l1 * l1 - a * a));
        const pn = pole.clone().sub(dir.clone().mulScalar(pole.dot(dir))).normalize();
        const elbow = A.clone().add(dir.clone().mulScalar(a)).add(pn.mulScalar(hgt));
        aim(up, A, Bp, elbow);
        aim(fore, V(fore), V(hand), A.clone().add(d));
    }

    destroy() { this.entity.destroy(); this.fork.destroy(); }
}
