// Fork combat: the hit geometry (pure, shared with the tests) and the strike rules.
import { hideEyes } from '../actors/monsters/eyes.js';
import { RULES } from './rules.js';

// distance from point p to a bone capsule's surface (bone k in a stride-13 bone array)
export function capsuleDist(bd, k, p) {
    const ax = bd[k], ay = bd[k + 1], az = bd[k + 2], ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az;
    let s = ((p[0] - ax) * ux + (p[1] - ay) * uy + (p[2] - az) * uz) / (ux * ux + uy * uy + uz * uz || 1);
    s = Math.max(0, Math.min(1, s));
    return Math.hypot(p[0] - ax - ux * s, p[1] - ay - uy * s, p[2] - az - uz * s) - bd[k + 12];
}

// Does the swinging fork touch a body? Tests the fork shaft (hand -> tip) and the arc the tip swept
// since the previous frame, so the result does not depend on the frame rate.
// Returns { hit, at, best } where `at` is the contact point.
export function forkHit(hand, tip, prevTip, bones, scale = 1) {
    const samples = [];
    for (let j = 0; j <= 6; j++) samples.push([hand[0] + (tip[0] - hand[0]) * j / 6, hand[1] + (tip[1] - hand[1]) * j / 6, hand[2] + (tip[2] - hand[2]) * j / 6]);
    if (prevTip) for (let j = 1; j < 4; j++) samples.push([prevTip[0] + (tip[0] - prevTip[0]) * j / 4, prevTip[1] + (tip[1] - prevTip[1]) * j / 4, prevTip[2] + (tip[2] - prevTip[2]) * j / 4]);
    let best = 9, at = tip;
    for (const q of samples) for (let k = 0; k < bones.length; k += 13) { const d = capsuleDist(bones, k, q); if (d < best) { best = d; at = q; } }
    return { hit: best <= 0.3 + 0.15 * scale, at, best };
}

// ---------------------------------------------------------------- strike rules
// During a strike's active frames, test the fork against every monster (and the boss): with meatball
// power a hit bursts the monster into an edible heap, without it the monster is only bonked and stunned.
export function resolveStrike(G) {
    const { hero, sauce, audio, hud } = G;
    const a = hero.action;
    if (!a || a.type !== 'strike') return;
    if (!hero.strikeActive) { a.prevTip = hero.forkTip; return; }
    a.hit = a.hit || new Set();
    const tip = hero.forkTip;
    const { fwd } = hero.frame();
    for (const m of G.pack.list) {
        if (m.state !== 'alive' || a.hit.has(m.id)) continue;
        const { hit, at } = forkHit(hero.handR, tip, a.prevTip, m.creature.boneData, m.scale);
        if (!hit) continue;
        a.hit.add(m.id);
        const c = m.creature;
        if (G.power > 0) {
            m.body.events.push({ type: 'chunk', p: at, d: [fwd[0], 0.4, fwd[2]], n: Math.ceil(m.N * 0.3) });
            crushMonster(G, m, fwd);
            sauce.burst(at, fwd, 40, 4.5);
            audio.crush(); G.shake = 0.7;
            G.score += RULES.score.crush;
        } else {
            m.body.events.push({ type: 'chunk', p: at, d: [fwd[0], 0.3, fwd[2]], n: Math.ceil(m.N * 0.05) });
            c.impact(fwd[0] * 2.2, fwd[2] * 2.2);
            c.stun(2.6);
            sauce.burst(at, fwd, 14, 3);
            audio.bonk(); G.shake = 0.3;
            G.score += RULES.score.stun;
        }
    }
    a.prevTip = tip;
    const boss = G.boss;
    if (boss && boss.alive && !a.hit.has('boss')) {
        const bd = Math.hypot(boss.x - hero.x, boss.z - hero.z);
        if (G.power > 0 && boss.takeHit(tip)) {
            a.hit.add('boss');
            const body = G.bossfight.body;
            body.events.push({ type: 'hit', p: tip, d: [fwd[0], 0.4, fwd[2]], r: 0.5 });
            sauce.burst(tip, fwd, 30, 4);
            audio.thud(); G.shake = 0.6;
            if (boss.downed) {
                body.events.push({ type: 'collapse', d: [0, 0, 0] });
                sauce.puddle(boss.x, boss.z, 1.4);
                audio.bossHum(false); audio.collapse();
                hud.card('It fell!', 'Eat the Flying Spaghetti Monster. Every last meatball.');
            }
        } else if (G.power <= 0 && bd < 2.2) {
            a.hit.add('boss');
            audio.bonk();
            hud.card('Too weak!', 'Eat a meatball first — catch the ones it throws.', 2);
        }
    }
}

// a monster bursts into a heap of noodles that can be eaten (or that pulls itself back together)
export function crushMonster(G, m, dir = [0, 0, 0]) {
    const c = m.creature;
    m.state = 'down';
    m.downT = 0;
    c.collapse(); c.stateTimer = Infinity; c.stunT = 0;
    m.body.events.push({ type: 'collapse', d: [dir[0] * 0.5, 0, dir[2] * 0.5] });
    G.sauce.puddle(c.x, c.z, 0.8 * m.scale);
    hideEyes(m.eyes);
    G.hud.card('Crushed!', 'Right click — eat it before it pulls itself together.', 2.5);
}
