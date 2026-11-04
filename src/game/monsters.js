import { Monster, PERSONAS } from '../actors/monsters/monster.js';
import { placeEyes } from '../actors/monsters/eyes.js';
import { farCells } from '../world/spawns.js';
import { crushMonster } from './combat.js';
import { RULES } from './rules.js';

// The pack of four spaghetti monsters and their rules: they hunt you (or flee while you are
// meatball-strong), catch you, fall apart, get eaten, or pull themselves back together.
export class Pack {
    constructor(G) {
        this.G = G;
        const { level, host, kit } = G;
        this.list = farCells(level, level.start, 3, PERSONAS.length)
            .map((start, i) => new Monster({ id: 'm' + i, persona: PERSONAS[i], start, seed: 100 + i, level, host, kit }));
    }

    get left() { return this.list.filter(m => m.state !== 'eaten').length; }
    get allEaten() { return this.list.every(m => m.state === 'eaten'); }

    // every monster gets punted away when the hero powers up
    scatter() {
        const { hero } = this.G;
        for (const m of this.list) if (m.state === 'alive') { m.creature.stunT = 0; m.creature.impact((m.creature.x - hero.x) * 0.3, (m.creature.z - hero.z) * 0.3); }
    }
    stunAll(t) { for (const m of this.list) if (m.state === 'alive') m.creature.stun(t); }

    update(dt, sdt, playing, drivers) {
        const G = this.G, { hero, host, sauce, hud } = G;
        const blinky = this.list.find(m => m.p.target === 'direct' && m.state === 'alive');
        for (const m of this.list) {
            if (m.state === 'eaten') continue;
            const c = m.creature;
            if (m.state === 'alive') {
                c.mode = G.power > 0 ? 'flee' : 'chase';
                const tgt = G.power > 0 ? { x: hero.x, z: hero.z, panic: true } : m.chaseTarget(hero, blinky);
                if (sdt > 0) c.update(sdt, { pos: { x: tgt.x, z: tgt.z }, panic: tgt.panic }, m.boundFrac, G.time);
                const dHero = Math.hypot(c.x - hero.x, c.z - hero.z);
                // a monster that loses most of its noodles to bonks falls apart too
                if (m.boundFrac < 0.45) crushMonster(G, m);
                else if (playing && G.power <= 0 && G.invuln <= 0 && !c.stunned && dHero < 0.45 + 0.3 * m.scale) G.caught(m);
                else {
                    const { fwd, right } = c.frame();
                    placeEyes(m.eyes, c.joints.head, fwd, right, hero.headPos, G.power > 0 || c.stunned);
                    if ((m.dripT -= sdt) <= 0) { m.dripT = 0.25 + Math.random() * 0.5; sauce.drip([c.x + (Math.random() - 0.5) * 0.4 * m.scale, (c.gy || 0) + 0.7 * m.scale, c.z + (Math.random() - 0.5) * 0.4 * m.scale]); }
                }
            } else if (m.state === 'down') {
                if (sdt > 0) c.update(sdt, { pos: { x: hero.x, z: hero.z } }, m.boundFrac, G.time);
                m.downT += sdt;
                if (m.body.eaten >= m.N * 0.8) {
                    m.state = 'eaten';
                    host.remove(m.id);
                    G.score += RULES.score.monster;
                    hud.card('Delizioso.', this.left ? `${this.left} left` : '', 2.5);
                    continue;
                }
                // left alone without power for too long, the heap pulls itself back together
                if (G.power <= 0 && m.downT > RULES.reformAfter && m.body.eaten < m.N * 0.5) {
                    m.state = 'alive';
                    c.stateTimer = 0;           // COLLAPSED -> REFORM
                    m.body.events.push({ type: 'reform' });
                    hud.card('It is getting back up!', '', 2);
                }
            }
            drivers.set(m.id, { bones: c.boneData, x: c.x, z: c.z, walking: c.walking && m.state === 'alive', speed: c.speed, ...G.eaterAnchors() });
        }
    }
}
