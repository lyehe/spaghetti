import * as pc from 'playcanvas';
import { FlyingSpaghettiMonster } from '../actors/monsters/boss.js';
import { meatEye } from '../actors/monsters/eyes.js';
import { Hero } from '../actors/hero/hero.js';
import { farCells } from '../world/spawns.js';
import { RULES } from './rules.js';

// Dessert: the Flying Spaghetti Monster. It hovers out of reach and lobs meatballs; the ones that
// land can make you strong. Only a meatball-strong fork can bring it down, then you eat it.
export class BossFight {
    constructor(G) {
        this.G = G;
        this.boss = null;
        this.body = null;
        this.vis = null;
        this.projectiles = [];
        for (let i = 0; i < 6; i++) { const e = G.kit.sphere(G.kit.meat); e.enabled = false; this.projectiles.push({ e, p: [0, 0, 0], v: [0, 0, 0], active: false }); }
    }

    spawn() {
        const { level, hero, host, kit, app, audio, hud } = this.G;
        const at = farCells(level, { x: hero.x, z: hero.z }, 3, 1)[0] || level.start;
        const boss = this.boss = new FlyingSpaghettiMonster(level, at);
        this.body = host.add('boss', {
            count: 240, grid: level.toData(), bones: boss.boneData, coreBones: boss.coreBones, boneWeights: boss.boneWeight,
            seed: 999, style: 'pasta', scale: 1.25, squishy: true, bodyCollisions: false
        });
        const meat = [kit.sphere(kit.meat), kit.sphere(kit.meat)];
        meat.forEach(m => { for (let i = 0; i < 7; i++) { const s = kit.sphere(kit.meatDark, m); const a = i * 2.4, e = (i % 3 - 1) * 0.5; s.setLocalPosition(Math.cos(a) * 0.42 * Math.cos(e), Math.sin(e) * 0.42, Math.sin(a) * 0.42 * Math.cos(e)); s.setLocalScale(0.25, 0.25, 0.25); } });
        const stalks = [0, 1].map(() => { const e = new pc.Entity(); e.addComponent('render', { type: 'cylinder', material: kit.meat, castShadows: true }); e.prim = 'cylinder'; app.root.addChild(e); return e; });
        this.vis = { meat, stalks, eyes: [0, 1].map(() => ({ white: meatEye(kit), pupil: kit.sphere(kit.eyeBlack) })) };
        audio.bossHum(true);
        hud.card('Dessert — His Noodly Appendage', 'Its meatballs only break when you are meatball-strong. Its thrown meatballs make you strong.', 5);
        hud.showBossBar();
    }

    update(dt, sdt, playing, drivers) {
        const G = this.G, { hero, level, sauce, audio } = G;
        if (!this.boss && playing && G.pack.allEaten) this.spawn();
        const boss = this.boss;
        if (boss) {
            const evs = sdt > 0 ? boss.update(sdt, { x: hero.x, z: hero.z }) : [];
            for (const ev of evs) {
                const pr = this.projectiles.find(p => !p.active);
                if (pr) { pr.active = true; pr.p = ev.from.slice(); pr.v = ev.vel.slice(); pr.e.enabled = true; pr.e.setLocalScale(0.26, 0.26, 0.26); }
            }
            const vis = this.vis, [mA, mB] = boss.meatballs(), gone = boss.state === 'eaten';
            vis.meat[0].setPosition(...mA.c); vis.meat[0].setLocalScale(mA.r * 2, mA.r * 2, mA.r * 2);
            vis.meat[1].setPosition(...mB.c); vis.meat[1].setLocalScale(mB.r * 2, mB.r * 2, mB.r * 2);
            vis.meat.forEach(m => m.enabled = !gone);
            const J = boss.joints;
            Hero.setLimb(vis.stalks[0], J.sL0, J.eyeL, 0.035); Hero.setLimb(vis.stalks[1], J.sR0, J.eyeR, 0.035);
            vis.stalks.forEach(s => s.enabled = !boss.downed);
            vis.eyes.forEach((e, i) => {
                const c = i ? J.eyeR : J.eyeL;
                e.white.enabled = e.pupil.enabled = !boss.downed;
                e.white.setPosition(...c); e.white.setLocalScale(0.17, 0.17, 0.17);
                const lx = hero.headPos[0] - c[0], ly = hero.headPos[1] - c[1], lz = hero.headPos[2] - c[2], l = Math.hypot(lx, ly, lz) || 1;
                e.pupil.setPosition(c[0] + lx / l * 0.065, c[1] + ly / l * 0.065, c[2] + lz / l * 0.065); e.pupil.setLocalScale(0.08, 0.08, 0.08);
            });
            if (boss.state !== 'eaten' || this.body.eaten < 200) drivers.set('boss', { bones: boss.boneData, x: boss.x, z: boss.z, walking: false, speed: 0, ...G.eaterAnchors() });
            if (boss.state === 'eaten' && G.mode === 'play') {
                G.score += RULES.score.bossWin;
                audio.bossHum(false);
                G.end('won', 'BUON APPETITO', `You ate every spaghetti monster and the Flying Spaghetti Monster itself.<br>
                    Score ${G.score} · ${G.strandsEaten} strands.<br><br><i>click to play again</i>`);
            }
        }

        // its meatballs: dodge them in the air; the ones that land may become power meatballs
        for (const pr of this.projectiles) {
            if (!pr.active) continue;
            pr.v[1] -= 9.8 * sdt;
            for (let i = 0; i < 3; i++) pr.p[i] += pr.v[i] * sdt;
            pr.e.setPosition(...pr.p);
            const hitHero = Math.hypot(pr.p[0] - hero.x, pr.p[2] - hero.z) < 0.45 && pr.p[1] - (hero.gy || 0) < 1.9;
            const pg = level.groundAt(pr.p[0], pr.p[2]);
            if (hitHero || pr.p[1] < pg + 0.15 || level.isWallAt(pr.p[0], pr.p[2], pr.p[1]) || pr.p[1] > level.WALL_H - 0.1) {
                pr.active = false; pr.e.enabled = false;
                sauce.burst(pr.p, [0, 1, 0], 14, 2.5);
                audio.thud();
                if (hitHero && G.power <= 0 && G.invuln <= 0) G.hurt('Ow — meatball!', 2, 0.8);
                else if (!hitHero && pr.p[1] < pg + 0.2 && Math.random() < 0.5) G.meatballs.spawn([pr.p[0], 0, pr.p[2]]);
            }
        }
    }
}
