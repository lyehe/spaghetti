import * as pc from 'playcanvas';

// Tomato sauce: pooled droplets that fly ballistically and leave glossy splats where they land
// (floor, walls, ceiling). Hits burst sauce, monsters drip a trail. Oldest splats get recycled.
export class Sauce {
    constructor(app, level, { drops = 140, splats = 240 } = {}) {
        this.app = app;
        this.level = level;
        const mk = (c, gloss) => {
            const m = new pc.StandardMaterial();
            m.diffuse = new pc.Color(...c);
            m.useMetalness = true; m.metalness = 0; m.gloss = gloss;
            m.clearCoat = 0.6; m.clearCoatGloss = 0.9;
            m.update();
            return m;
        };
        this.dropMat = mk([0.62, 0.06, 0.03], 0.75);
        this.splatMats = [mk([0.5, 0.04, 0.02], 0.8), mk([0.42, 0.03, 0.015], 0.7), mk([0.58, 0.09, 0.03], 0.85)];
        this.drops = [];
        for (let i = 0; i < drops; i++) {
            const e = new pc.Entity('sauce-drop');
            e.addComponent('render', { type: 'sphere', material: this.dropMat, castShadows: false });
            e.enabled = false;
            app.root.addChild(e);
            this.drops.push({ e, p: [0, 0, 0], v: [0, 0, 0], r: 0.03, life: 0, active: false });
        }
        this.splats = [];
        for (let i = 0; i < splats; i++) {
            const e = new pc.Entity('sauce-splat');
            e.addComponent('render', { type: 'cylinder', material: this.splatMats[i % 3], castShadows: false });
            e.enabled = false;
            app.root.addChild(e);
            this.splats.push(e);
        }
        this.nextDrop = 0;
        this.nextSplat = 0;
    }

    // a spray of sauce from point p, mostly along dir
    burst(p, dir, count = 14, power = 3) {
        for (let i = 0; i < count; i++) {
            const d = this.drops[this.nextDrop++ % this.drops.length];
            d.active = true; d.life = 3;
            d.p = [p[0], p[1], p[2]];
            d.v = [dir[0] * power * (0.4 + Math.random()) + (Math.random() - 0.5) * power,
                   Math.random() * power * 0.9 + 0.5,
                   dir[2] * power * (0.4 + Math.random()) + (Math.random() - 0.5) * power];
            d.r = 0.015 + Math.random() * 0.035;
            d.e.enabled = true;
            d.e.setLocalScale(d.r * 2, d.r * 2, d.r * 2);
        }
    }

    drip(p) { this.burst(p, [0, -1, 0], 1, 0.3); }

    // a flat glossy blob on a surface with the given normal
    splat(p, n, size) {
        const e = this.splats[this.nextSplat++ % this.splats.length];
        e.enabled = true;
        e.setPosition(p[0] + n[0] * 0.006, p[1] + n[1] * 0.006, p[2] + n[2] * 0.006);
        const up = new pc.Vec3(0, 1, 0), v = new pc.Vec3(n[0], n[1], n[2]);
        const axis = new pc.Vec3().cross(up, v);
        const q = new pc.Quat();
        if (axis.length() > 1e-5) q.setFromAxisAngle(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, up.dot(v)))) * pc.math.RAD_TO_DEG);
        else if (n[1] < 0) q.setFromAxisAngle(pc.Vec3.RIGHT, 180);
        // random spin around the normal + a stretched, irregular shape
        q.mul(new pc.Quat().setFromAxisAngle(pc.Vec3.UP, Math.random() * 360));
        e.setRotation(q);
        e.setLocalScale(size * (0.8 + Math.random() * 0.6), 0.008, size * (0.6 + Math.random() * 0.5));
    }

    // a pool of sauce on the floor (e.g. under a destroyed monster)
    puddle(x, z, size) {
        const g = (x, z) => (this.level.groundAt ? this.level.groundAt(x, z) : 0);
        this.splat([x, g(x, z) + 0.003, z], [0, 1, 0], size);
        for (let i = 0; i < 4; i++) { const px = x + (Math.random() - 0.5) * size, pz = z + (Math.random() - 0.5) * size; this.splat([px, g(px, pz) + 0.004, pz], [0, 1, 0], size * (0.3 + Math.random() * 0.4)); }
    }

    update(dt) {
        const lv = this.level, C = lv.CELL, H = lv.WALL_H;
        for (const d of this.drops) {
            if (!d.active) continue;
            d.life -= dt;
            d.v[1] -= 9.8 * dt;
            const np = [d.p[0] + d.v[0] * dt, d.p[1] + d.v[1] * dt, d.p[2] + d.v[2] * dt];
            let n = null;
            const gy = lv.groundAt ? lv.groundAt(np[0], np[2]) : 0;
            if (np[1] <= gy + 0.005) { np[1] = gy + 0.003; n = [0, 1, 0]; }
            else if (np[1] >= H - 0.005) { np[1] = H - 0.003; n = [0, -1, 0]; }
            else if (lv.heights && lv.isWallAt(np[0], np[2], np[1]) && d.p[1] >= lv.heightAt(Math.floor(np[0] / C), Math.floor(np[2] / C)) - 0.01) {
                // landed on a table / counter top
                np[1] = lv.heightAt(Math.floor(np[0] / C), Math.floor(np[2] / C)) + 0.003; n = [0, 1, 0];
            }
            else if (lv.isWallAt(np[0], np[2], np[1])) {
                // which face did we cross?
                const cx0 = Math.floor(d.p[0] / C), cz0 = Math.floor(d.p[2] / C);
                const cx1 = Math.floor(np[0] / C), cz1 = Math.floor(np[2] / C);
                if (cx1 !== cx0) { n = [cx1 > cx0 ? -1 : 1, 0, 0]; np[0] = (cx1 > cx0 ? cx1 * C : cx0 * C) + n[0] * 0.003; }
                else if (cz1 !== cz0) { n = [0, 0, cz1 > cz0 ? -1 : 1]; np[2] = (cz1 > cz0 ? cz1 * C : cz0 * C) + n[2] * 0.003; }
                else { n = [-Math.sign(d.v[0]) || 1, 0, 0]; np[0] = d.p[0]; }   // pillar: approximate
            }
            if (n || d.life <= 0) {
                if (n) this.splat(np, n, d.r * (5 + Math.random() * 4));
                d.active = false; d.e.enabled = false;
                continue;
            }
            d.p = np;
            d.e.setPosition(np[0], np[1], np[2]);
        }
    }
}
