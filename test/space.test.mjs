import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CollisionMesh, proceduralKitchen, parseOBJ } from '../src/collision.js';
import { Creature } from '../src/creature.js';
import { WormSim, P, BOUND } from '../src/sim/wormsim.js';

const apt = () => { const j = JSON.parse(fs.readFileSync('spaces/apartment/collision.json', 'utf8')); return new CollisionMesh(j.positions, j.indices); };
const APT_START = { x: 8.625, z: 4.625 };

test('collision mesh: rays hit walls and furniture tops at the right distance', () => {
    const m = proceduralKitchen();
    // from the middle of the room toward the +x wall (inner face at x = 11.8)
    const t = m.raycast({ x: 6, y: 1.5, z: 3 }, { x: 1, y: 0, z: 0 }, 50);
    assert.ok(Math.abs(t - 5.8) < 1e-3, `wall at ${t}`);
    // straight down onto the dining table top (0.76) from 2 m
    const d = m.raycast({ x: 5.9, y: 2, z: 4.9 }, { x: 0, y: -1, z: 0 }, 5);
    assert.ok(Math.abs(d - 1.24) < 1e-3, `table at ${d}`);
    // over the table at 1.5 m nothing is in the way
    assert.equal(m.raycast({ x: 3.5, y: 1.5, z: 4.9 }, { x: 1, y: 0, z: 0 }, 4), 4);
});

test('collision mesh -> occupancy grid: walls full height, tables low, open floor walkable', () => {
    const g = proceduralKitchen().toGrid({ cell: 0.25, wallH: 2.8, start: { x: 6, z: 2 } });
    const at = (x, z) => [Math.floor(x / 0.25), Math.floor(z / 0.25)];
    assert.ok(!g.isWall(...at(6, 2)), 'start is open');
    assert.ok(g.isWall(...at(5.9, 4.9)), 'table blocks walking');
    assert.ok(Math.abs(g.heightAt(...at(5.9, 4.9)) - 0.76) < 0.05, `table height ${g.heightAt(...at(5.9, 4.9))}`);
    assert.ok(!g.isWall(...at(5.9, 4.9), 1.2), 'but not above its top');
    assert.ok(Math.abs(g.heightAt(...at(11.9, 5)) - 2.8) < 1e-4, 'wall is full height');
    assert.ok(g.isWall(...at(2.8, 2.8)), 'column');
    // nav mask keeps bodies away from furniture edges
    assert.ok(g.isBlocked(...at(4.45, 4.9)) && !g.isWall(...at(4.45, 4.9)));
    // a circle pushed into the table ends up outside it
    const p = { x: 5.9, z: 4.3 };
    g.collideCircle(p, 0.3);
    assert.ok(p.z <= 4.2 - 0.29, `pushed out to z=${p.z}`);
});

test('OBJ collision meshes load the same as JSON', () => {
    const obj = fs.readFileSync('spaces/apartment/collision.obj', 'utf8');
    const a = parseOBJ(obj), b = apt();
    assert.equal(a.triCount, b.triCount);
});

test('apartment: collision built from the splat is a connected, roomy play space', () => {
    const m = apt();
    const g = m.toGrid({ cell: 0.25, wallH: 3.0, start: APT_START });
    let open = 0, nav = 0;
    for (let z = 0; z < g.h; z++) for (let x = 0; x < g.w; x++) { if (!g.isWall(x, z)) open++; if (!g.isBlocked(x, z)) nav++; }
    const area = open * 0.0625;
    assert.ok(area > 50 && area < 120, `open area ${area} m2`);
    // everything walkable is reachable from the start
    const dist = g.distanceField(APT_START);
    let reach = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] >= 0) reach++;
    assert.ok(reach >= nav * 0.95, `reachable ${reach} of ${nav}`);
    // the room is enclosed: rays from the start always hit something within the capture
    for (let a = 0; a < 16; a++) {
        const d = { x: Math.sin(a / 16 * Math.PI * 2), y: 0, z: Math.cos(a / 16 * Math.PI * 2) };
        assert.ok(m.raycast({ x: APT_START.x, y: 1, z: APT_START.z }, d, 30) < 15, `ray ${a} escapes`);
    }
});

// --- pac-man behaviour on the real apartment grid
function aptGrid() { return apt().toGrid({ cell: 0.25, wallH: 3.0, start: APT_START }); }
function farOpen(g, from, min) {
    const dist = g.distanceField(from);
    let best = null;
    for (let z = 0; z < g.h; z++) for (let x = 0; x < g.w; x++) if (dist[z * g.w + x] * 0.25 > min && !g.isBlocked(x, z)) { best = { x: (x + 0.5) * 0.25, y: 0, z: (z + 0.5) * 0.25 }; break; }
    return best;
}

test('monsters hunt the player through the furniture, and run when the player has power', () => {
    const g = aptGrid();
    const player = { pos: { x: APT_START.x, z: APT_START.z } };
    const start = farOpen(g, APT_START, 5);
    assert.ok(start, 'a far spawn exists');
    const c = new Creature(g, { scale: 0.9, behavior: 'chase', start });
    c.chaseSpeed = 2.3; c.awake = true; c.radius = 0.22;   // noodle bodies squeeze between furniture
    const d0 = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    let t = 0, minD = d0;
    for (let i = 0; i < 60 * 12; i++) { c.update(1 / 60, player, 1, t += 1 / 60); minD = Math.min(minD, Math.hypot(c.x - player.pos.x, c.z - player.pos.z)); }
    assert.ok(minD < 0.9, `chaser got within ${minD.toFixed(2)} m (started ${d0.toFixed(2)})`);
    assert.ok(!g.isWall(Math.floor(c.x / 0.25), Math.floor(c.z / 0.25)), 'never ends inside furniture');

    // power: same monster now flees
    c.mode = 'flee';
    const near = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    for (let i = 0; i < 60 * 6; i++) c.update(1 / 60, { ...player, panic: true }, 1, t += 1 / 60);
    const far = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    assert.ok(far > near + 1.5, `fled from ${near.toFixed(2)} to ${far.toFixed(2)}`);
});

test('a stunned monster stops in its tracks, then resumes the hunt', () => {
    const g = aptGrid();
    const start = farOpen(g, APT_START, 4);
    const c = new Creature(g, { scale: 1, behavior: 'chase', start });
    c.awake = true; c.chaseSpeed = 2.2; c.radius = 0.22;
    const player = { pos: { x: APT_START.x, z: APT_START.z } };
    let t = 0;
    for (let i = 0; i < 60; i++) c.update(1 / 60, player, 1, t += 1 / 60);
    c.stun(2);
    for (let i = 0; i < 40; i++) c.update(1 / 60, player, 1, t += 1 / 60);   // let knock-back settle
    const x0 = c.x, z0 = c.z;
    for (let i = 0; i < 60; i++) c.update(1 / 60, player, 1, t += 1 / 60);
    assert.ok(Math.hypot(c.x - x0, c.z - z0) < 0.15, 'stunned: stays put');
    for (let i = 0; i < 120; i++) c.update(1 / 60, player, 1, t += 1 / 60);
    assert.ok(Math.hypot(c.x - x0, c.z - z0) > 0.5, 'hunting again after the stun');
    for (const v of Object.values(c.joints)) assert.ok(v.every(Number.isFinite));
});

test('crushed monster: worms stay on the splat floor / furniture, never inside the collision mesh', () => {
    const g = aptGrid();
    const start = farOpen(g, APT_START, 3);
    const c = new Creature(g, { scale: 1, behavior: 'chase', start });
    const sim = new WormSim({ count: 160, grid: g, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, seed: 3, style: 'pasta', squishy: true });
    sim.setCreature(c.boneData, c.x, c.z, false, 0);
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    sim.chunk(c.x, 1.1, c.z - 0.3, 0, 0.4, 1, 50);
    sim.collapse(0, 0, 0.5);
    c.collapse(); c.stateTimer = Infinity;
    for (let i = 0; i < 60 * 4; i++) { c.update(1 / 60, { pos: APT_START }, sim.boundCount / sim.N, i / 60); sim.setCreature(c.boneData, c.x, c.z, false, 0); sim.step(1 / 60); }
    let inside = 0, total = 0;
    for (let w = 0; w < sim.N; w++) for (let i = 0; i < P; i += 4) {
        const o = (w * P + i) * 3, x = sim.pos[o], y = sim.pos[o + 1], z = sim.pos[o + 2];
        total++;
        if (y < -0.01 || g.isWall(Math.floor(x / 0.25), Math.floor(z / 0.25), y + 0.05)) inside++;
    }
    assert.ok(inside / total < 0.02, `${inside}/${total} points inside geometry`);
    assert.ok(sim.boundCount < sim.N * 0.5);
});

// --- outdoor terrain (the park capture): no ceiling, uneven ground
test('park terrain: ground follows the scan, bodies and worms stand on it, no ceiling', () => {
    const j = JSON.parse(fs.readFileSync('spaces/sunnyvale/collision.json', 'utf8'));
    const g = new CollisionMesh(j.positions, j.indices).toGrid({ cell: 0.25, wallH: 40, terrain: true, start: { x: 16, z: 16 } });
    // the ground is not flat, but gentle where people walk
    const dist = g.distanceField({ x: 16, z: 16 });
    let lo = Infinity, hi = -Infinity, open = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] >= 0) { open++; lo = Math.min(lo, g.ground[i]); hi = Math.max(hi, g.ground[i]); }
    assert.ok(open * 0.0625 > 300, `walkable ${open * 0.0625} m2`);
    assert.ok(hi - lo > 0.15 && hi - lo < 2.5, `ground range ${lo.toFixed(2)}..${hi.toFixed(2)}`);
    // a monster walking across it keeps its feet on the ground
    const start = farOpen(g, { x: 16, z: 16 }, 6);
    const c = new Creature(g, { scale: 1, behavior: 'chase', start });
    c.awake = true; c.radius = 0.22;
    let worst = 0;
    for (let i = 0; i < 60 * 6; i++) {
        c.update(1 / 60, { pos: { x: 16, z: 16 } }, 1, i / 60);
        for (const f of ['ftL', 'ftR']) { const p = c.joints[f]; worst = Math.max(worst, Math.abs(p[1] - g.groundAt(p[0], p[2]))); }
    }
    assert.ok(worst < 0.3, `feet off the ground by up to ${worst.toFixed(2)} m`);
    // a crushed heap settles on the ground: nothing sinks below it, nothing hangs from a ceiling
    const sim = new WormSim({ count: 120, grid: g, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, seed: 5, style: 'pasta', squishy: true });
    sim.setCreature(c.boneData, c.x, c.z, false, 0);
    sim.collapse(0, 0, 0);
    for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);
    let below = 0, high = 0;
    for (let w = 0; w < sim.N; w++) for (let i = 0; i < P; i += 4) {
        const o = (w * P + i) * 3, y = sim.pos[o + 1], gy = g.groundAt(sim.pos[o], sim.pos[o + 2]);
        if (y < gy - 0.02) below++;
        if (y > gy + 2.5) high++;
    }
    assert.equal(below, 0, 'points below the ground');
    assert.equal(high, 0, 'points stuck up high (ceiling)');
});
