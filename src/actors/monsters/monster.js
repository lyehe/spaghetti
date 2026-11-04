import { Creature } from './creature.js';
import { makeEyes } from './eyes.js';

// A spaghetti monster: a procedural skeleton (Creature) wearing a body of simulated noodles, with
// meatball eyes. Each hunts differently (like the four ghosts): straight at you, cutting you off
// ahead, flanking from the other side, and a coward that only chases from far away.
export const PERSONAS = [
    { name: 'Spaghetto', scale: 1.1, chase: 2.15, target: 'direct' },
    { name: 'Linguina', scale: 0.8, chase: 2.4, target: 'ambush' },
    { name: 'Fettuccino', scale: 0.95, chase: 2.25, target: 'flank' },
    { name: 'Capellino', scale: 0.62, chase: 2.5, target: 'shy' }
];

export class Monster {
    constructor({ id, persona, start, seed, level, host, kit }) {
        this.id = id;
        this.p = persona;
        this.level = level;
        this.scale = persona.scale;
        this.home = start;
        this.creature = new Creature(level, { scale: this.scale, behavior: 'chase', start });
        this.creature.chaseSpeed = persona.chase;
        this.creature.awake = true;
        this.creature.radius = 0.22;          // noodle bodies squeeze between the furniture
        this.N = Math.round(70 + 100 * this.scale);
        this.body = host.add(id, {
            count: this.N, grid: level.toData(), bones: this.creature.boneData, coreBones: this.creature.coreBones,
            boneWeights: this.creature.boneWeight, seed, style: 'pasta', scale: this.scale, squishy: true, bodyCollisions: false
        });
        this.eyes = makeEyes(kit, this.scale);
        this.state = 'alive';                 // alive -> down (a heap) -> eaten   (down -> alive if left too long)
        this.downT = 0;
        this.dripT = Math.random();
    }

    get boundFrac() { return this.body.boundCount / this.N; }

    // where this monster is heading while hunting the hero
    chaseTarget(hero, blinky) {
        const { fwd } = hero.frame(), c = this.creature, level = this.level;
        const H = { x: hero.x, z: hero.z };
        const clampIn = (p) => level.isWallAt(p.x, p.z) ? H : { x: p.x, z: p.z };
        if (this.p.target === 'ambush') return clampIn({ x: hero.x + fwd[0] * 2.5, z: hero.z + fwd[2] * 2.5 });
        if (this.p.target === 'flank' && blinky) return clampIn({ x: hero.x * 2 - blinky.creature.x, z: hero.z * 2 - blinky.creature.z });
        if (this.p.target === 'shy' && Math.hypot(c.x - hero.x, c.z - hero.z) < 3) return this.home;      // too close: back off home
        return H;
    }
}
