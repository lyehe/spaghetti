// Eating, like a man who has not eaten in a week. Right click (hold to keep going): a stab-and-twirl
// forkful, then a stuffed fistful, then another forkful... The hero rig plays each bite and fires
// two events: 'grab' winds the nearby noodles onto the tines / into the fist, 'feed' hands them to
// the mouth, which sucks them in while the loose ends dangle from his lips.
export class Eating {
    constructor(G) {
        this.G = G;
        this.held = false;        // the eat button is down
        this.biteN = 0;
        this.lastChew = 0;
    }

    // the nearest loose noodles in front of the hero (or the downed boss)
    target() {
        const { hero, host, level, rig } = this.G, boss = this.G.boss, yaw = rig.cam.yaw;
        let target = null, bestD = 2.4;
        const consider = (q) => {
            const dx = q[0] - hero.x, dz = q[2] - hero.z, d = Math.hypot(dx, dz);
            const facing = d < 0.9 || (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / d > -0.2;
            if (d < bestD && facing && q[1] - level.groundAt(q[0], q[2]) < 1.2) { bestD = d; target = q; }
        };
        for (const b of host.bodies.values()) for (let i = 0; i < b.loose.length; i += 4) consider([b.loose[i + 1], b.loose[i + 2], b.loose[i + 3]]);
        if (boss && boss.downed) consider([boss.x, level.groundAt(boss.x, boss.z) + 0.3, boss.z]);
        return target;
    }

    // start the next bite; auto (button held): stop when the plate is clean
    bite(auto = false) {
        const { hero, level, hud } = this.G;
        if (hero.action) return;
        const target = this.target();
        if (!target && auto) { this.held = false; return; }
        const { fwd } = hero.frame();
        const kind = this.biteN++ % 2 ? 'hand' : 'fork';
        const t = target || [hero.x + fwd[0] * 0.8, level.groundAt(hero.x, hero.z) + 0.05, hero.z + fwd[2] * 0.8];
        hero.eat([t[0], Math.min(t[1], level.groundAt(t[0], t[2]) + 0.35), t[2]], kind);
        hero.action.held = 0;
        if (!target) hud.hint('Nothing to eat here.');
    }

    press() { this.held = true; this.bite(); }
    release() { this.held = false; }

    update() {
        const G = this.G, { hero, host, audio } = G;
        const a = hero.action;
        if (a && a.type === 'eat') {
            const anchor = a.kind === 'fork' ? 1 : 2;
            for (const ev of hero.events) {
                if (ev === 'grab') {
                    const at = a.kind === 'fork' ? hero.forkTip : hero.fist;
                    const near = Math.hypot(at[0] - a.target[0], at[2] - a.target[2]) < 0.35 ? at : a.target;
                    const per = (a.kind === 'fork' ? 6 : 4) + (G.power > 0 ? 4 : 0);
                    let n = 0;
                    for (const b of host.bodies.values()) {
                        const ids = host.edibleNear(b, near, 0.55, per - n);
                        if (ids.length) { b.events.push({ type: 'slurp', ids, anchor }); n += ids.length; }
                        if (n >= per) break;
                    }
                    a.held = n;
                    const boss = G.boss;
                    if (boss && boss.downed && Math.hypot(boss.x - hero.x, boss.z - hero.z) < 2.6) { boss.eatBite(); a.held += 3; }
                    if (n) audio.squelch(a.kind === 'hand' ? 0.7 : 0.35);
                } else if (ev === 'feed') {
                    for (const b of host.bodies.values()) b.events.push({ type: 'feed', anchor });
                    if (a.held) {
                        hero.swallow(a.held);
                        if (G.body) G.body.smear(0.02 + 0.007 * a.held);
                        audio.slurp();
                    }
                    audio.chomp();
                }
            }
        }
        if (this.held && !hero.action) this.bite(true);
        // loud chewing in time with the jaw
        const ph = Math.sin(hero.chewT);
        if (hero.mouthful > 0.12 && ph > 0 && this.lastChew <= 0) audio.munch(Math.min(1, hero.mouthful));
        this.lastChew = ph;
    }
}
