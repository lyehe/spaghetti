import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../src/world/grid.js';
import { Creature } from '../src/actors/monsters/creature.js';
import { WormSim, P, BOUND, FREE, EATEN, SLURP } from '../src/sim/wormsim.js';
import { FlyingSpaghettiMonster } from '../src/actors/monsters/boss.js';
import { handle } from '../src/sim/noodleworker.js';

const DT = 1 / 60;
const level = () => { const g = new Grid(); return Object.assign(g, { creatureStart: g.cellCenter(...g.marks.C) }); };

test('a spaghetti monster runs away from the player and gains distance', () => {
    const lv = level();
    const start = lv.cellCenter(18, 14);                    // long open corridor along row 14
    const c = new Creature(lv, { scale: 0.75, behavior: 'flee', start });
    const player = { pos: { x: start.x - 4, z: start.z } };
    const d0 = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    for (let k = 0; k < 180; k++) {
        player.pos.x += 1.2 * DT;                           // the player walks after it
        c.update(DT, player, 1, k * DT);
    }
    const d1 = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    assert.ok(d1 > d0 + 1, `monster should pull away: ${d0.toFixed(1)}m -> ${d1.toFixed(1)}m`);
    assert.ok(!lv.isWallAt(c.x, c.z));
});

test('monsters come in different sizes (whole body scales, including the noodles)', () => {
    const lv = level();
    const small = new Creature(lv, { scale: 0.6, behavior: 'flee' });
    const big = new Creature(lv, { scale: 1.3, behavior: 'flee' });
    const height = (c) => c.joints.head[1];
    assert.ok(Math.abs(height(small) / height(big) - 0.6 / 1.3) < 0.08, `head heights ${height(small).toFixed(2)} vs ${height(big).toFixed(2)}`);
    const simS = new WormSim({ count: 60, grid: lv, bones: small.boneData, coreBones: small.coreBones, boneWeights: small.boneWeight, style: 'pasta', scale: 0.6 });
    const simB = new WormSim({ count: 60, grid: lv, bones: big.boneData, coreBones: big.coreBones, boneWeights: big.boneWeight, style: 'pasta', scale: 1.3 });
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(avg(Array.from(simS.seg)) < avg(Array.from(simB.seg)) * 0.6, 'small monsters have shorter noodles');
});

test('eating: loose noodles get slurped into the mouth and disappear', () => {
    const lv = level();
    const c = new Creature(lv, { scale: 0.8, behavior: 'flee' });
    c.dormant = true;
    const sim = new WormSim({ count: 80, grid: lv, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, style: 'pasta', scale: 0.8, squishy: true });
    const player = { pos: { x: c.x, z: c.z + 40 } };
    const tick = (n) => { for (let k = 0; k < n; k++) { c.update(DT, player, sim.boundFraction, k * DT); sim.setCreature(c.boneData, c.x, c.z, false, 0); sim.step(DT); } };
    tick(30);
    sim.collapse();
    tick(120);
    const mouth = [c.x + 0.8, 1.45, c.z];
    sim.setMouth(...mouth);
    const ids = sim.findEdible(c.x, 0.1, c.z, 1.5, 6);
    assert.ok(ids.length >= 3, `found only ${ids.length} edible noodles`);
    for (const w of ids) sim.slurp(w);
    assert.ok(ids.every(w => sim.state[w] === SLURP));
    tick(150);
    assert.equal(ids.filter(w => sim.state[w] === EATEN).length, ids.length, 'every slurped strand should be eaten');
    assert.equal(sim.eatenCount, ids.length);
    // eaten strands vanish from the mesh
    const f = new Float32Array(WormSim.vertexCount(sim.N) * 7), u = new Uint32Array(f.buffer);
    sim.buildMesh(f, u);
    const v = ids[0] * P * 8;
    assert.equal(f[v * 7 + 1], -50);
    assert.ok(Number.isFinite(sim.pos.reduce((a, b) => a + b, 0)));
});

test('eating with the fork: strands wind onto the tines, hang off it, then get sucked into a mouth high above', () => {
    const lv = level();
    const c = new Creature(lv, { scale: 0.95, behavior: 'flee' });
    c.dormant = true;
    const sim = new WormSim({ count: 120, grid: lv, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, style: 'pasta', scale: 0.95, squishy: true, bodyCollisions: false });
    const player = { pos: { x: c.x, z: c.z + 40 } };
    let t = 0;
    const tick = (n, each) => { for (let k = 0; k < n; k++) { t += DT; each?.(); c.update(DT, player, sim.boundFraction, t); sim.setCreature(c.boneData, c.x, c.z, false, 0); sim.step(DT); } };
    tick(30);
    sim.collapse();
    tick(150);
    const any = sim.findEdible(c.x, 0.05, c.z, 1.6, 1)[0], o = any * P * 3 + (P >> 1) * 3;
    const tip = [sim.pos[o], 0.06, sim.pos[o + 2]];
    const ids = sim.findEdible(tip[0], 0.06, tip[2], 0.5, 5);          // what the tines land among
    assert.ok(ids.length >= 3, `found only ${ids.length} edible noodles`);
    sim.setFork([...tip, 0, -1, 0, 1, 0, 0, 0]);
    for (const w of ids) sim.slurp(w, 1);
    // twirl in place, then lift the fork 1.8 m up to the mouth
    tick(30, () => { sim.fork[9] += 0.6; });
    const wound = ids.map(w => sim.slurpN[w]);
    assert.ok(wound.every(n => n >= 5), `strands should wind onto the tines: ${wound}`);
    tick(30, () => { sim.fork[1] = Math.min(1.85, sim.fork[1] + 0.07); });
    tick(45);                                                          // let them swing down
    const hang = ids.map(w => { const e = w * P * 3 + (P - 1) * 3; return sim.fork[1] - sim.pos[e + 1]; });
    assert.ok(hang.every(h => h > 0.2), `the loose ends should dangle below the fork: ${hang.map(h => h.toFixed(2))}`);
    const mouth = [tip[0], 1.9, tip[2] + 0.05];
    sim.setMouth(...mouth);
    sim.feed(1);
    tick(150);
    assert.equal(ids.filter(w => sim.state[w] === EATEN).length, ids.length, `every strand should be eaten: ${ids.map(w => sim.state[w] + '/' + sim.slurpN[w])}`);
    assert.ok(Number.isFinite(sim.pos.reduce((a, b) => a + b, 0)));
});

test('boss: hovers out of reach, swoops into reach, can be hit, crashes, lobs meatballs at you', () => {
    // an open arena so line of sight is clear
    const rows = ['##############', ...Array.from({ length: 12 }, () => '#............#'), '##############'];
    const lv = new Grid(rows);
    const boss = new FlyingSpaghettiMonster(lv, lv.cellCenter(10, 7));
    const player = lv.cellCenter(4, 7);
    let minY = 9, maxCruise = 0, throws = [], swooped = false;
    for (let k = 0; k < 60 * 12; k++) {
        const ev = boss.update(DT, player);
        throws.push(...ev);
        if (boss.state === 'fly' && k > 120) maxCruise = Math.max(maxCruise, boss.y);
        if (boss.state === 'swoop') { swooped = true; minY = Math.min(minY, boss.y); }
    }
    assert.ok(maxCruise > 1.9, 'cruises above fork reach');
    assert.ok(swooped && minY < 1.6, `swoops low enough to hit (min ${minY.toFixed(2)}m)`);
    assert.ok(throws.length >= 2, `threw ${throws.length} meatballs`);
    // a lobbed meatball lands near the player
    const t0 = throws[0];
    let p = t0.from.slice(), v = t0.vel.slice();
    for (let i = 0; i < 400 && p[1] > 1.0; i++) { v[1] -= 9.8 * DT; p = [p[0] + v[0] * DT, p[1] + v[1] * DT, p[2] + v[2] * DT]; }
    assert.ok(Math.hypot(p[0] - player.x, p[2] - player.z) < 2.5, 'meatball should land near the player');
    // fork hits on the meatballs wear it down until it crashes
    let hits = 0;
    while (boss.alive && hits < 40) { if (boss.takeHit(boss.joints.mA)) hits++; }
    assert.equal(hits, boss.maxHp);
    assert.ok(boss.downed);
    for (let k = 0; k < 120; k++) boss.update(DT, player);
    assert.ok(boss.y < 0.5, 'falls to the floor');
    for (let i = 0; i < 5; i++) boss.eatBite();
    assert.equal(boss.state, 'eaten');
});

test('noodle worker protocol: frames return meshes, counts and the loose (edible) strands', () => {
    const lv = level();
    const c = new Creature(lv, { scale: 0.7, behavior: 'flee' });
    const opts = { count: 40, grid: lv.toData(), bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, style: 'pasta', scale: 0.7, squishy: true, bodyCollisions: false, seed: 3 };
    handle({ type: 'add', id: 'm1', opts }, () => {});
    const bytes = WormSim.vertexCount(40) * 28;
    let res = null;
    const frame = (events) => handle({ type: 'frame', dt: DT, sims: [{ id: 'm1', bones: c.boneData, cx: c.x, cz: c.z, walking: false, speed: 0, mouth: [0, 0, 0], events, buffer: new ArrayBuffer(bytes) }] }, (m) => { res = m; });
    frame([]);
    assert.equal(res.sims[0].boundCount, 40);
    assert.equal(res.sims[0].loose.length, 0);
    frame([{ type: 'collapse', d: [0, 0, 0] }]);
    for (let i = 0; i < 30; i++) frame([]);
    assert.ok(res.sims[0].loose.length / 4 > 30, 'collapsed noodles are loose and edible');
    assert.equal(res.sims[0].buffer.byteLength, bytes);
    handle({ type: 'remove', id: 'm1' }, () => {});
});

test('every landed fork strike knocks off a chunk, even after that side is stripped', () => {
    const lv = level();
    const c = new Creature(lv, { scale: 0.95, behavior: 'flee' });
    c.dormant = true;
    const sim = new WormSim({ count: 194, grid: lv, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, style: 'pasta', scale: 0.95, squishy: true, bodyCollisions: false });
    const player = { pos: { x: c.x, z: c.z + 40 } };
    for (let k = 0; k < 60; k++) { c.update(DT, player, 1, k * DT); sim.setCreature(c.boneData, c.x, c.z, false, 0); sim.step(DT); }
    const k0 = 0; const bd = c.boneData;
    const p = [(bd[k0] + bd[k0 + 3]) / 2 + 0.3, (bd[k0 + 1] + bd[k0 + 4]) / 2, (bd[k0 + 2] + bd[k0 + 5]) / 2];
    const fr = [];
    for (let s = 0; s < 4; s++) {
        const n = sim.chunk(p[0], p[1], p[2], -1, 0.3, 0, Math.ceil(sim.N * 0.18));
        assert.ok(n >= Math.ceil(sim.N * 0.18) - 1, `strike ${s} only knocked off ${n}`);
        for (let k = 0; k < 10; k++) { sim.setCreature(c.boneData, c.x, c.z, false, 0); sim.step(DT); }
        fr.push(sim.boundFraction);
    }
    assert.ok(fr[3] < 0.35, `after 4 strikes ${(fr[3] * 100).toFixed(0)}% of the body remains`);
});

test('gameplay loop: the hero strikes a monster down with the fork, then eats it', async () => {
    const { Hero } = await import('../src/actors/hero/hero.js');
    const { forkHit } = await import('../src/game/combat.js');
    const lv = level();
    const start = lv.cellCenter(20, 8);
    const c = new Creature(lv, { scale: 0.95, start });           // held still for the test (chase + dormant)
    c.dormant = true;
    const sim = new WormSim({ count: 194, grid: lv, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, style: 'pasta', scale: 0.95, squishy: true, bodyCollisions: false, seed: 5 });
    const hero = new Hero(null, lv, { x: start.x, z: start.z - 1.1 }, { visual: false });
    const player = { pos: { x: hero.x, z: hero.z } };
    const input = { x: 0, z: 0, sprint: false, camYaw: 0 };   // facing +z, toward the monster
    let t = 0;
    const tick = () => {
        hero.update(DT, input);
        c.update(DT, player, sim.boundFraction, t);
        sim.setCreature(c.boneData, c.x, c.z, false, 0);
        sim.setMouth(...hero.mouth);
        sim.step(DT); t += DT;
    };
    for (let k = 0; k < 30; k++) tick();
    let strikes = 0, landed = 0;
    while (sim.boundFraction >= 0.45 && strikes < 10) {
        hero.strike(); strikes++;
        let prevTip = null, hitThis = false;
        while (hero.action) {
            tick();
            if (hero.strikeActive && !hitThis) {
                const r = forkHit(hero.handR, hero.forkTip, prevTip, c.boneData, 0.95);
                if (r.hit) { hitThis = true; landed++; sim.chunk(...r.at, 0, 0.3, 1, Math.ceil(sim.N * 0.18)); }
            }
            prevTip = hero.strikeActive ? hero.forkTip : null;
        }
    }
    assert.equal(landed, strikes, `only ${landed} of ${strikes} strikes connected at point-blank range`);
    assert.ok(strikes <= 5, `took ${strikes} strikes to break it`);
    sim.collapse();
    for (let k = 0; k < 90; k++) tick();
    // eat, like the game does: forkful, fistful, forkful. 'grab' winds what is near the tines (or the
    // fist) onto it, 'feed' sends it to the mouth
    const before = sim.eatenCount;
    let fed = 0, grabbed = 0;
    for (let bite = 0; bite < 3; bite++) {
        const kind = bite % 2 ? 'hand' : 'fork';
        const pile = sim.findEdible(c.x, 0.1, c.z, 1.6, 1)[0];
        const o = pile * P * 3 + (P >> 1) * 3;
        assert.ok(hero.eat([sim.pos[o], 0.05, sim.pos[o + 2]], kind));
        const anchor = kind === 'fork' ? 1 : 2;
        while (hero.action) {
            tick();
            sim.setFork(hero.forkAnchor); sim.setFist(hero.fist);
            for (const ev of hero.events) {
                if (ev === 'grab') {
                    const tip = kind === 'fork' ? hero.forkTip : hero.fist, tg = hero.action.target;
                    const at = Math.hypot(tip[0] - tg[0], tip[2] - tg[2]) < 0.35 ? tip : tg;      // as the game does
                    for (const w of sim.findEdible(at[0], at[1], at[2], 0.55, 6)) { sim.slurp(w, anchor); grabbed++; }
                }
                if (ev === 'feed') { sim.feed(anchor); fed++; }
            }
        }
        for (let k = 0; k < 30; k++) tick();
    }
    for (let k = 0; k < 60; k++) tick();                                // the last mouthful is still being slurped up
    assert.equal(fed, 3);
    assert.ok(grabbed >= 9, `three bites picked up only ${grabbed} strands`);
    assert.ok(sim.eatenCount - before >= grabbed - 1, `picked up ${grabbed} strands but ate only ${sim.eatenCount - before}`);
});
