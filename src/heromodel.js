import * as pc from 'playcanvas';

// The hero's body: a realistic skinned human (Microsoft Rocketbox, MIT) driven by mocap clips
// (idle / walk / run, blended by speed), with procedural layers on top for what mocap can't know:
//   - right arm: 2-bone IK to the fork keyframes of the Hero rig (strike / reach / twirl / lift)
//   - left arm: IK while shovelling food
//   - spine lean into strikes, head dip toward the plate, jaw chewing
// The Hero class still owns gameplay (movement, actions, hit points); this only makes it look real.

const B = {
    root: 'hero', pelvis: 'Bip01 Pelvis', spine: 'Bip01 Spine1', spine2: 'Bip01 Spine2', neck: 'Bip01 Neck', head: 'Bip01 Head', jaw: 'Bip01 MJaw',
    upR: 'Bip01 R UpperArm', foreR: 'Bip01 R Forearm', handR: 'Bip01 R Hand',
    upL: 'Bip01 L UpperArm', foreL: 'Bip01 L Forearm', handL: 'Bip01 L Hand'
};
const WALK_SPEED = 1.39, RUN_SPEED = 3.06;     // metres / second the clips were captured at

const V = (e) => e.getPosition().clone();
const tmpQ = new pc.Quat(), tmpQ2 = new pc.Quat();

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

    constructor(app, asset, hero) {
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

        this.buildFork();
        this.jawAngle = 0;
        this.power = 0;
    }

    tuneMaterials(model) {
        for (const r of model.findComponents('render')) for (const mi of r.meshInstances) {
            const m = mi.material;
            if (!m || !m.name) continue;
            if (m.name.includes('opacity')) { m.alphaTest = 0.35; m.blendType = pc.BLEND_NONE; m.depthWrite = true; }
            m.useMetalness = true; m.metalness = 0;
            if (m.name.includes('head')) { m.gloss = 0.45; m.specularityFactor = 0.6; }
            else m.gloss = 0.28;
            m.update();
        }
    }

    buildFork() {
        const mat = (c, gloss, metal) => { const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(...c); m.useMetalness = true; m.metalness = metal; m.gloss = gloss; m.update(); return m; };
        const steel = mat([0.8, 0.81, 0.84], 0.88, 0.25), wood = mat([0.36, 0.2, 0.1], 0.35, 0);
        this.fork = new pc.Entity('fork');
        this.app.root.addChild(this.fork);
        const forkMesh = new pc.Entity('fork-mesh');
        forkMesh.setLocalScale(1.3, 1.3, 1.3);
        this.fork.addChild(forkMesh);
        const fp = (type, m, pos, scale) => {
            const e = new pc.Entity();
            e.addComponent('render', { type, material: m, castShadows: true });
            e.setLocalPosition(...pos); e.setLocalScale(...scale);
            forkMesh.addChild(e);
        };
        // fork local space: +Y along the handle toward the tines, grip at the origin
        fp('cylinder', wood, [0, 0.05, 0], [0.05, 0.42, 0.05]);              // wooden grip
        fp('cylinder', steel, [0, 0.48, 0], [0.045, 0.5, 0.045]);           // shaft
        fp('sphere', steel, [0, -0.17, 0], [0.065, 0.065, 0.065]);          // pommel
        fp('box', steel, [0, 0.78, 0], [0.2, 0.12, 0.035]);                 // shoulder
        for (let i = 0; i < 4; i++) fp('box', steel, [-0.075 + i * 0.05, 0.96, 0], [0.022, 0.3, 0.024]);   // tines
    }

    // called every frame AFTER the hero rig update (and after the anim system ran)
    update(dt) {
        const h = this.hero, b = this.bones, e = this.entity;
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
        const R = new pc.Vec3(right[0], 0, right[2]);
        // torso: lean into the strike, bow toward the plate, twist into the swing
        const lean = (h.lean[0] * fwd[0] + h.lean[1] * fwd[2]) / 0.46;
        rotateWorld(b.spine, R, lean * 40);
        if (h.action && h.action.type === 'strike') {
            const t = h.action.t;
            const twist = t < 0.18 ? -18 * t / 0.18 : t < 0.32 ? -18 + 40 * (t - 0.18) / 0.14 : 22 * (1 - (t - 0.32) / 0.23);
            rotateWorld(b.spine2, pc.Vec3.UP, twist);
        }
        rotateWorld(b.neck, R, (h.headDown || 0) * 22);
        rotateWorld(b.head, R, (h.headDown || 0) * 14);
        // chew
        this.jawAngle += ((h.jaw || 0) * 16 - this.jawAngle) * Math.min(1, dt * 20);
        if (b.jaw) rotateWorld(b.jaw, R, this.jawAngle);

        // right arm -> fork keyframe target (IK), then a real grip: the handle runs through the palm
        const lift = (v) => { const p = new pc.Vec3(...v); p.y = gy + (p.y - gy) * k; return p; };   // keyframes are for the unscaled body
        const dir = new pc.Vec3(...h.forkDir).normalize();
        this.ik(b.upR, b.foreR, b.handR, lift(h.handTargetW || h.handTarget), new pc.Vec3(right[0] * 0.5, -1, right[2] * 0.5));
        const palmR = this.grip('R', dir, h.forkRoll);

        // left hand: on the shaft above the right one (a two-handed pitchfork hold) unless it is busy
        // shovelling food while eating
        const eating = h.action && h.action.type === 'eat';
        const twoHanded = !eating;
        const lt = twoHanded ? palmR.clone().add(dir.clone().mulScalar(0.4 * k)) : lift(h.leftTarget);
        this.ik(b.upL, b.foreL, b.handL, lt, new pc.Vec3(-right[0] * 0.6 - fwd[0] * 0.3, -0.8, -right[2] * 0.6 - fwd[2] * 0.3));
        if (twoHanded) this.grip('L', dir, 0); else this.relaxFingers('L');

        // fork: its grip (origin) sits in the right palm
        this.fork.setPosition(palmR.clone().sub(dir.clone().mulScalar((h.gripSlide || 0) * k)));   // hand slid up the shaft while eating
        const q = quatFromY(h.forkDir);
        q.mul(new pc.Quat().setFromAxisAngle(pc.Vec3.UP, h.forkRoll * pc.math.RAD_TO_DEG));
        this.fork.setRotation(q);
        this.fork.setLocalScale(k, k, k);
        // report the real hand / head back to the gameplay rig
        h.handR = [palmR.x, palmR.y, palmR.z];
        const head = V(b.head);
        h.headPos = [head.x + fwd[0] * 0.04, head.y + 0.06, head.z + fwd[2] * 0.04];
    }

    // Turn a hand so the handle (along dir) runs across the palm from pinky to index, then close the
    // fingers around it. Returns the palm centre (where the handle passes).
    grip(side, dir, roll) {
        const fingers = this.fingers(side);
        const hand = this.bones[side === 'R' ? 'handR' : 'handL'];
        if (!fingers) return V(hand);
        const H = V(hand), across = V(fingers.index[0]).sub(V(fingers.pinky[0]));
        // wrist: rotate the knuckle line (pinky -> index) onto the handle direction
        hand.setRotation(tmpQ.copy(fromTo(across, dir)).mul(hand.getRotation()));
        // wrist roll while twirling (only the fork hand)
        if (roll) rotateWorld(hand, dir, (roll * pc.math.RAD_TO_DEG) % 360 * 0.15);
        const H2 = V(hand), fdir = V(fingers.middle[0]).sub(H2).normalize();
        const n = new pc.Vec3().cross(fdir, dir).normalize();
        // palm side: the thumb sits on it
        if (V(fingers.thumb[0]).sub(H2).dot(n) < 0) n.mulScalar(-1);
        const palm = H2.clone().add(fdir.clone().mulScalar(0.075)).add(n.clone().mulScalar(0.035));
        // curl every finger segment toward the handle
        const axisDist = (p) => { const d = p.clone().sub(palm); return d.sub(dir.clone().mulScalar(d.dot(dir))).length(); };
        const curl = (chain, angles) => chain.forEach((bone, j) => {
            const tip = chain[j + 1] || null;
            const probe = () => tip ? V(tip) : V(bone).add(V(bone).sub(V(chain[j - 1] || hand)).mulScalar(0.8));
            const d0 = axisDist(probe());
            rotateWorld(bone, dir, angles[j]);
            if (axisDist(probe()) > d0) rotateWorld(bone, dir, -2 * angles[j]);
        });
        for (const f of [fingers.index, fingers.middle, fingers.ring, fingers.pinky]) curl(f, [55, 70, 45]);
        // the thumb wraps across the other side of the handle
        const thumbAxis = new pc.Vec3().cross(dir, n).normalize();
        fingers.thumb.forEach((bone, j) => rotateWorld(bone, thumbAxis, j === 0 ? 0 : 25));
        return palm;
    }

    relaxFingers(side) {
        const f = this.fingers(side);
        if (!f) return;
        const hand = this.bones[side === 'R' ? 'handR' : 'handL'];
        const fdir = V(f.middle[0]).sub(V(hand)).normalize(), across = V(f.index[0]).sub(V(f.pinky[0])).normalize();
        const axis = new pc.Vec3().cross(fdir, across).cross(fdir).normalize();
        for (const c of [f.index, f.middle, f.ring, f.pinky]) c.forEach(bone => rotateWorld(bone, across, 12));
    }

    fingers(side) {
        this._fingers ||= {};
        if (this._fingers[side] !== undefined) return this._fingers[side];
        const F = (n) => this.model.findByName(`Bip01 ${side} Finger${n}`);
        const chain = (k) => [F(k), F(k + '1'), F(k + '2')].filter(Boolean);
        const r = { thumb: chain('0'), index: chain('1'), middle: chain('2'), ring: chain('3'), pinky: chain('4') };
        this._fingers[side] = r.index.length && r.pinky.length && r.middle.length && r.thumb.length ? r : null;
        return this._fingers[side];
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

function quatFromY(dir) {
    const up = new pc.Vec3(0, 1, 0), v = new pc.Vec3(dir[0], dir[1], dir[2]).normalize();
    const dot = Math.max(-1, Math.min(1, up.dot(v)));
    const axis = new pc.Vec3().cross(up, v);
    const q = new pc.Quat();
    if (axis.length() < 1e-5) { if (dot < 0) q.setFromAxisAngle(pc.Vec3.RIGHT, 180); return q; }
    return q.setFromAxisAngle(axis.normalize(), Math.acos(dot) * pc.math.RAD_TO_DEG);
}
