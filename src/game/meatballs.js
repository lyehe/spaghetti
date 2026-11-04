import * as pc from 'playcanvas';
import { RULES } from './rules.js';

// The power pellets: meatballs pop up somewhere open, bob in a little puddle of sauce under a warm
// light, and give a minute of strength to whoever walks into them.
export class Meatballs {
    constructor(G) {
        this.G = G;
        const { app, kit } = G;
        this.light = new pc.Entity('meatball-light');
        this.light.addComponent('light', { type: 'omni', color: new pc.Color(1, 0.55, 0.25), intensity: 1.2, range: 2.2, castShadows: false });
        app.root.addChild(this.light);
        this.pool = [];
        for (let i = 0; i < 3; i++) {
            const root = new pc.Entity('meatball'); app.root.addChild(root);
            const core = kit.sphere(kit.meat, root); core.setLocalScale(0.34, 0.32, 0.34);
            for (let j = 0; j < 9; j++) {
                const b = kit.sphere(kit.meatDark, core), a = j * 2.39996, e = Math.asin(1 - 2 * (j + 0.5) / 9);
                b.setLocalPosition(Math.cos(a) * Math.cos(e) * 0.47, Math.sin(e) * 0.47, Math.sin(a) * Math.cos(e) * 0.47); b.setLocalScale(0.22, 0.2, 0.22);
            }
            const glaze = kit.sphere(kit.sauce, root); glaze.setLocalPosition(0, 0.12, 0); glaze.setLocalScale(0.3, 0.12, 0.3);
            root.enabled = false;
            this.pool.push({ root, core, active: false, p: [0, 0, 0], t: 0, life: 0 });
        }
        this.timer = 4;          // the first one shows up soon
    }

    get active() { return this.pool.filter(m => m.active); }

    spawn(at = null) {
        const { level, hero, rand, sauce } = this.G;
        const m = this.pool.find(b => !b.active);
        if (!m) return;
        let p = at;
        // somewhere open, not right next to the player, not inside a monster
        const C = level.CELL;
        for (let tries = 0; tries < 200 && !p; tries++) {
            const x = Math.floor(rand() * level.w), z = Math.floor(rand() * level.h);
            if (level.isBlocked(x, z) || x < 10 || z < 10 || x > level.w - 10 || z > level.h - 10) continue;
            const q = [(x + 0.5) * C, 0, (z + 0.5) * C];
            if (Math.hypot(q[0] - hero.x, q[2] - hero.z) < 3) continue;
            if (this.G.pack.list.some(mm => mm.state !== 'eaten' && Math.hypot(q[0] - mm.creature.x, q[2] - mm.creature.z) < 1.5)) continue;
            p = q;
        }
        if (!p) return;
        m.active = true; m.p = p; m.t = 0; m.life = RULES.meatballLife; m.root.enabled = true;
        sauce.puddle(p[0], p[2], 0.35);
    }

    update(dt, sdt, playing) {
        const G = this.G, { level, hero, sauce, rand } = G;
        if (playing && !(G.boss && G.boss.downed)) {
            this.timer -= sdt;
            if (this.timer <= 0) {
                if (this.active.length < 2 && G.power < 10) this.spawn();
                const [a, b] = RULES.meatballEvery;
                this.timer = a + rand() * (b - a);
            }
        }
        let lit = null;
        for (const m of this.pool) {
            if (!m.active) continue;
            m.t += dt; m.life -= sdt;
            const pop = Math.min(1, m.t * 3);
            const gy = level.groundAt(m.p[0], m.p[2]), y = 0.28 + Math.sin(m.t * 3) * 0.05;
            m.root.setPosition(m.p[0], gy + y * pop, m.p[2]);
            m.root.setEulerAngles(0, m.t * 60, 0);
            m.root.setLocalScale(pop, pop, pop);
            if (!lit) lit = m;
            if (Math.random() < dt * 3) sauce.drip([m.p[0] + (Math.random() - 0.5) * 0.2, gy + y, m.p[2] + (Math.random() - 0.5) * 0.2]);
            if (playing && Math.hypot(m.p[0] - hero.x, m.p[2] - hero.z) < 0.6 + 0.1 * hero.power) {
                m.active = false; m.root.enabled = false;
                G.score += RULES.score.meatball;
                G.startPower();
            } else if (m.life <= 0) { m.active = false; m.root.enabled = false; }
        }
        this.light.enabled = !!lit;
        if (lit) this.light.setPosition(lit.p[0], level.groundAt(lit.p[0], lit.p[2]) + 0.8, lit.p[2]);
    }
}
