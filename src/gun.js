import * as pc from 'playcanvas';

function mat(color, gloss, emissive, ei = 1) {
    const m = new pc.StandardMaterial();
    m.diffuse = color;
    m.useMetalness = true;
    m.metalness = 0.1;
    m.gloss = gloss;
    if (emissive) { m.emissive = emissive; m.emissiveIntensity = ei; }
    m.update();
    return m;
}

// Chunky white sci-fi blaster held in the bottom right of the view.
export class Gun {
    constructor(app, camera) {
        this.app = app;
        this.root = new pc.Entity('gun');
        camera.addChild(this.root);
        this.basePos = new pc.Vec3(0.2, -0.19, -0.4);
        this.root.setLocalPosition(this.basePos);
        this.root.setLocalScale(0.65, 0.65, 0.65);

        const white = mat(new pc.Color(0.92, 0.92, 0.9), 0.75);
        const grey = mat(new pc.Color(0.35, 0.36, 0.38), 0.6);
        const dark = mat(new pc.Color(0.02, 0.02, 0.025), 0.9);
        this.screenMat = mat(new pc.Color(0, 0, 0), 0.9, new pc.Color(0.2, 0.35, 0.4), 0.6);
        const metal = mat(new pc.Color(0.7, 0.7, 0.72), 0.8);

        const part = (type, m, pos, scale, rot) => {
            const e = new pc.Entity();
            e.addComponent('render', { type, material: m, castShadows: false });
            e.setLocalPosition(...pos);
            e.setLocalScale(...scale);
            if (rot) e.setLocalEulerAngles(...rot);
            this.root.addChild(e);
            return e;
        };

        part('box', white, [0, 0, 0], [0.12, 0.13, 0.34]);                 // body
        part('box', white, [0, 0.085, -0.02], [0.13, 0.06, 0.28]);         // top shell
        part('box', dark, [0, 0.105, 0.06], [0.1, 0.08, 0.004], [-20, 0, 0]); // rear screen
        this.screen = part('box', this.screenMat, [0, 0.106, 0.058], [0.085, 0.065, 0.002], [-20, 0, 0]);
        part('box', grey, [0, -0.04, -0.06], [0.125, 0.04, 0.2]);          // grey band
        part('cylinder', metal, [0, 0, -0.2], [0.07, 0.06, 0.07], [90, 0, 0]);   // muzzle ring
        part('cylinder', dark, [0, 0, -0.232], [0.05, 0.01, 0.05], [90, 0, 0]);  // bore
        part('box', white, [0, -0.11, 0.08], [0.06, 0.14, 0.07], [15, 0, 0]);    // grip
        part('box', grey, [-0.065, 0.0, -0.05], [0.01, 0.05, 0.16]);             // side rail

        // muzzle flash
        const flashMat = new pc.StandardMaterial();
        flashMat.diffuse = new pc.Color(0, 0, 0);
        flashMat.emissive = new pc.Color(1, 0.85, 0.6);
        flashMat.emissiveIntensity = 12;
        flashMat.blendType = pc.BLEND_ADDITIVE;
        flashMat.depthWrite = false;
        flashMat.update();
        this.flash = new pc.Entity('flash');
        this.flash.addComponent('render', { type: 'sphere', material: flashMat, castShadows: false });
        this.flash.setLocalPosition(0, 0, -0.27);
        this.flash.setLocalScale(0.09, 0.09, 0.16);
        this.flash.enabled = false;
        this.root.addChild(this.flash);

        this.light = new pc.Entity('flash-light');
        this.light.addComponent('light', { type: 'omni', color: new pc.Color(1, 0.85, 0.65), intensity: 0, range: 7, castShadows: false });
        this.light.setLocalPosition(0, 0.05, -0.35);
        this.root.addChild(this.light);

        this.recoil = 0;
        this.flashT = 0;
        this.reloadT = 0;
        this.ammo = 12;
        this.maxAmmo = 12;
        this.cool = 0;
    }

    canFire() { return this.cool <= 0 && this.reloadT <= 0 && this.ammo > 0; }

    fire() {
        this.ammo--;
        this.cool = 0.16;
        this.recoil = 1;
        this.flashT = 0.06;
        this.flash.enabled = true;
        this.flash.setLocalEulerAngles(0, 0, Math.random() * 360);
        if (this.ammo === 0) this.reload();
    }

    reload() {
        if (this.reloadT > 0 || this.ammo === this.maxAmmo) return false;
        this.reloadT = 1.4;
        return true;
    }

    update(dt, t, moving) {
        this.cool -= dt;
        if (this.reloadT > 0) {
            this.reloadT -= dt;
            if (this.reloadT <= 0) this.ammo = this.maxAmmo;
        }
        this.recoil = Math.max(0, this.recoil - dt * 7);
        this.flashT -= dt;
        if (this.flashT <= 0) this.flash.enabled = false;
        this.light.light.intensity = Math.max(0, this.flashT) * 60;

        const sway = Math.min(1, moving / 3);
        const rl = this.reloadT > 0 ? Math.sin((1.4 - this.reloadT) / 1.4 * Math.PI) : 0;
        this.root.setLocalPosition(
            this.basePos.x + Math.sin(t * 5.2) * 0.008 * sway,
            this.basePos.y + Math.abs(Math.cos(t * 5.2)) * 0.01 * sway - rl * 0.15,
            this.basePos.z + this.recoil * 0.07
        );
        this.root.setLocalEulerAngles(this.recoil * 9 - rl * 30, rl * 20, rl * 25);
        this.screenMat.emissiveIntensity = 0.4 + 0.3 * (this.ammo / this.maxAmmo) + Math.random() * 0.1;
        this.screenMat.update();
    }
}
