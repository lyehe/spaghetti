import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../src/world/grid.js';
import { Creature } from '../src/actors/monsters/creature.js';
import { WormSim, P } from '../src/sim/wormsim.js';

test('pillars stand against walls inside open cells', () => {
    const g = new Grid();
    assert.ok(g.pillars.length > 20, `only ${g.pillars.length} pillars`);
    for (const [x0, z0, x1, z1] of g.pillars) {
        const cx = Math.floor((x0 + x1) / 2 / g.CELL), cz = Math.floor((z0 + z1) / 2 / g.CELL);
        assert.ok(!g.isWall(cx, cz), 'pillar inside a wall cell');
        // it touches a wall face: one of its sides lies on the cell boundary next to a wall
        const touches = (z0 === cz * g.CELL && g.isWall(cx, cz - 1)) || (z1 === (cz + 1) * g.CELL && g.isWall(cx, cz + 1)) ||
            (x0 === cx * g.CELL && g.isWall(cx - 1, cz)) || (x1 === (cx + 1) * g.CELL && g.isWall(cx + 1, cz));
        assert.ok(touches, 'pillar floating in the middle of a room');
    }
});

test('pillars block circles, rays and line of sight', () => {
    const g = new Grid();
    const [x0, z0, x1, z1] = g.pillars[0];
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    assert.ok(g.isWallAt(mx, mz));
    const p = { x: mx, z: z1 + 0.1 };                          // overlapping the open face
    assert.ok(g.collideCircle(p, 0.3));
    assert.ok(p.z >= z1 + 0.3 - 1e-6, 'circle pushed out of the pillar');
    // ray from the open side straight at the pillar stops at its face
    const t = g.raycast({ x: mx, y: 1.5, z: z1 + 1.5 }, { x: 0, y: 0, z: -1 });
    assert.ok(Math.abs(t - 1.5) < 0.06, `ray stopped at ${t.toFixed(2)}`);
});

test('worm points get pushed out of pillars', () => {
    const g = new Grid();
    const level = Object.assign(g, { creatureStart: g.cellCenter(...g.marks.C) });
    const c = new Creature(level);
    const sim = new WormSim({ count: 4, grid: g, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, seed: 1 });
    const [x0, z0, x1, z1] = g.pillars[0];
    sim.release(0, 0, 0, 0, 999);
    for (let i = 0; i < P; i++) {
        const o = i * 3;
        sim.pos[o] = (x0 + x1) / 2 + (i - P / 2) * 0.01; sim.pos[o + 1] = 1; sim.pos[o + 2] = (z0 + z1) / 2;
        sim.prev[o] = sim.pos[o]; sim.prev[o + 1] = 1; sim.prev[o + 2] = sim.pos[o + 2];
    }
    sim.setCreature(c.boneData, c.x, c.z, false, 0);
    sim.step(1 / 60);
    let inside = 0;
    for (let i = 0; i < P; i++) if (g.isWallAt(sim.pos[i * 3], sim.pos[i * 3 + 2])) inside++;
    assert.equal(inside, 0, `${inside} points still inside the pillar (or pushed into the wall behind it)`);
});

test('the creature still finds its way across the map around pillars', () => {
    const g = new Grid();
    const level = Object.assign(g, { creatureStart: g.cellCenter(...g.marks.C) });
    const c = new Creature(level);
    c.awake = true;
    const player = { pos: g.cellCenter(...g.marks.S) };
    let reached = false;
    for (let k = 0; k < 60 * 60 && !reached; k++) {
        c.update(1 / 60, player, 1, k / 60);
        if (Math.hypot(c.x - player.pos.x, c.z - player.pos.z) < 1.2) reached = true;
        assert.ok(!g.isWallAt(c.x, c.z), 'creature walked into a wall or pillar');
    }
    assert.ok(reached, `stuck at ${c.x.toFixed(1)},${c.z.toFixed(1)}`);
});
