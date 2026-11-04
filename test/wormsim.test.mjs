import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WormSim, P, BOUND, FREE, CLING, RETURN } from '../src/sim/wormsim.js';
import { Grid } from '../src/world/grid.js';
import { Creature } from '../src/actors/monsters/creature.js';

const DT = 1 / 60;

// distance from a point to the nearest bone capsule axis of the creature
function boneDist(bd, x, y, z) {
    let best = 1e9;
    for (let k = 0; k < bd.length; k += 13) {
        const ax = bd[k], ay = bd[k + 1], az = bd[k + 2], ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az;
        let s = ((x - ax) * ux + (y - ay) * uy + (z - az) * uz) / (ux * ux + uy * uy + uz * uz || 1);
        s = Math.max(0, Math.min(1, s));
        best = Math.min(best, Math.hypot(x - ax - ux * s, y - ay - uy * s, z - az - uz * s));
    }
    return best;
}


function setup(count = 900, seed = 7) {
    const grid = new Grid();
    const level = Object.assign(grid, { creatureStart: grid.cellCenter(...grid.marks.C) });
    const creature = new Creature(level);
    const sim = new WormSim({ count, grid, bones: creature.boneData, coreBones: creature.coreBones, boneWeights: creature.boneWeight, seed });
    const player = { pos: { x: creature.x, z: creature.z + 40 } };   // far away: creature idles
    const tick = (n, { walk = false, t0 = 0 } = {}) => {
        for (let k = 0; k < n; k++) {
            const bf = sim.boundFraction;
            creature.dormant = !walk; creature.awake = walk;
            creature.update(DT, player, bf, t0 + k * DT);
            sim.setCreature(creature.boneData, creature.x, creature.z, creature.walking, creature.speed);
            sim.step(DT);
        }
    };
    return { grid, creature, sim, player, tick };
}

function finite(sim) {
    for (const v of sim.pos) if (!Number.isFinite(v)) return false;
    return true;
}

test('idle body is stable: no NaN, heads stay on their anchors', () => {
    const { sim, tick } = setup();
    tick(300);
    assert.ok(finite(sim));
    let far = 0;
    for (let w = 0; w < sim.N; w++) {
        if (sim.state[w] !== BOUND) continue;
        const o = w * P * 3;
        const d = Math.hypot(sim.pos[o] - sim.anchorA[w * 3], sim.pos[o + 1] - sim.anchorA[w * 3 + 1], sim.pos[o + 2] - sim.anchorA[w * 3 + 2]);
        if (d > 0.15) far++;
    }
    assert.ok(far < sim.N * 0.02, `${far} bound heads drifted off their anchor`);
    assert.ok(sim.boundFraction > 0.98);
});

test('worms actually writhe (points move relative to the body while idle)', () => {
    const { sim, tick } = setup(200);
    tick(60);
    const snap = sim.pos.slice();
    tick(30);
    let moved = 0;
    for (let w = 0; w < sim.N; w++) {
        const o = (w * P + P - 1) * 3;   // tail tip
        if (Math.hypot(sim.pos[o] - snap[o], sim.pos[o + 1] - snap[o + 1], sim.pos[o + 2] - snap[o + 2]) > 0.03) moved++;
    }
    assert.ok(moved > sim.N * 0.5, `only ${moved} tails moved`);
});

test('collapse sprays worms, they pile on the floor without passing through each other', () => {
    const { sim, tick, creature } = setup();
    tick(30);
    creature.collapse();
    sim.collapse(0, 0, -1);
    assert.equal(sim.boundFraction, 0);
    let maxClinging = 0;
    for (let k = 0; k < 12; k++) {
        tick(20);
        let c = 0; for (let w = 0; w < sim.N; w++) if (sim.state[w] === CLING) c++;
        maxClinging = Math.max(maxClinging, c);
    }
    assert.ok(finite(sim));
    assert.ok(maxClinging > 5, `only ${maxClinging} worms ever clung to walls/ceiling`);

    // after settling, nearly everything is low; deep overlaps between different worms are rare
    tick(300);
    let high = 0, n = 0;
    for (let w = 0; w < sim.N; w++) {
        if (sim.state[w] === CLING) continue;
        for (let i = 0; i < P; i++) { n++; if (sim.pos[(w * P + i) * 3 + 1] > 0.6) high++; }
    }
    assert.ok(high / n < 0.05, `${(high / n * 100).toFixed(1)}% of points still floating`);

    let pairs = 0, deep = 0;
    const pts = [];
    for (let w = 0; w < sim.N; w += 3) for (let i = 0; i < P; i += 2) pts.push([w, i]);
    for (let a = 0; a < pts.length; a++) {
        const [wa, ia] = pts[a], oa = (wa * P + ia) * 3;
        for (let b = a + 1; b < pts.length; b++) {
            const [wb, ib] = pts[b];
            if (wa === wb) continue;
            const ob = (wb * P + ib) * 3;
            const d = Math.hypot(sim.pos[oa] - sim.pos[ob], sim.pos[oa + 1] - sim.pos[ob + 1], sim.pos[oa + 2] - sim.pos[ob + 2]);
            const rr = sim.prad[wa * P + ia] + sim.prad[wb * P + ib];
            if (d < rr * 1.5) { pairs++; if (d < rr * 0.5) deep++; }
        }
    }
    assert.ok(pairs > 50, 'expected a dense pile');
    assert.ok(deep / pairs < 0.15, `${(deep / pairs * 100).toFixed(1)}% of contacts are deep interpenetrations`);
    // pile has some thickness: worms stack on each other
    let stacked = 0;
    for (let w = 0; w < sim.N; w++) for (let i = 0; i < P; i++) {
        const pi = w * P + i, y = sim.pos[pi * 3 + 1];
        if (y > sim.prad[pi] * 2.5 && y < 0.4) stacked++;
    }
    // thin (3-5cm) worms settle into a mostly 1-2 layer mat like the reference video, so ~3% stacked
    assert.ok(stacked > sim.N * P * 0.03, `only ${stacked} points stacked above the floor layer`);
});

test('reform: leaders rear up, body rebuilds bottom-up to >85% within 8s by climbing', () => {
    const { sim, tick, creature } = setup();
    tick(30);
    creature.collapse();
    sim.collapse();
    tick(240);
    creature.state = 2;            // REFORM
    sim.reform();
    tick(60);
    let leaderMax = 0;
    for (let w = 0; w < sim.N; w++) if (sim.leader[w]) leaderMax = Math.max(leaderMax, sim.pos[w * P * 3 + 1]);
    assert.ok(leaderMax > 0.7, `leaders only reached ${leaderMax.toFixed(2)}m`);

    const history = [];
    for (let s = 0; s < 8; s++) { tick(60); history.push(+sim.boundFraction.toFixed(2)); }
    assert.ok(finite(sim));
    const final = history[history.length - 1];
    assert.ok(final > 0.85, `bound fraction history ${history.join(' ')}`);
    // fills feet-first: early on, bound worms are mostly low on the body
    assert.ok(history[1] < final, 'rebuild should be progressive');
    assert.ok(sim.teleports < sim.N * 0.08, `${sim.teleports} worms had to be teleported home; history ${history.join(' ')}`);
});

test('a free worm crawls along the floor toward the creature (anisotropic friction locomotion)', () => {
    const { sim, tick, creature } = setup(50);
    // put worm 0 flat on the floor 3m away, returning
    const w = 0, base = 0;
    sim.release(w, 0, 0, 0, 0);
    for (let i = 0; i < P; i++) {
        const o = base + i * 3;
        sim.pos[o] = creature.x; sim.pos[o + 1] = sim.rad[w]; sim.pos[o + 2] = creature.z + 3 + i * sim.seg[w];
        sim.prev[o] = sim.pos[o]; sim.prev[o + 1] = sim.pos[o + 1]; sim.prev[o + 2] = sim.pos[o + 2];
    }
    sim.state[w] = RETURN; sim.retTime[w] = 0;
    const d0 = Math.hypot(sim.pos[0] - creature.x, sim.pos[2] - creature.z);
    tick(180);
    const d1 = Math.hypot(sim.pos[0] - creature.x, sim.pos[2] - creature.z);
    assert.ok(sim.state[w] === BOUND || d0 - d1 > 1.2, `crawled only ${(d0 - d1).toFixed(2)}m in 3s`);
    // it stayed on the ground while crawling (no flying)
});

test('walking sheds a trail of worms behind the creature', () => {
    const { sim, tick, creature, player } = setup();
    player.pos = { x: creature.x, z: creature.z + 4 };      // open floor straight ahead
    const sx = creature.x, sz = creature.z;
    tick(150, { walk: true });
    assert.ok(Math.hypot(creature.x - sx, creature.z - sz) > 1.5, 'creature should have walked');
    let trail = 0;
    for (let w = 0; w < sim.N; w++) {
        if (sim.state[w] === BOUND) continue;
        const o = w * P * 3;
        if (sim.pos[o + 1] < 0.2 && Math.hypot(sim.pos[o] - creature.x, sim.pos[o + 2] - creature.z) > 0.5) trail++;
    }
    assert.ok(trail > 5, `trail had ${trail} worms`);
    assert.ok(sim.boundFraction > 0.75);
});

test('performance: step + mesh build for 900 worms', () => {
    const { sim, tick, creature } = setup();
    tick(60);
    const f = new Float32Array(WormSim.vertexCount(sim.N) * 7);
    const u = new Uint32Array(f.buffer);
    let t0 = performance.now();
    tick(60);
    const idleStep = (performance.now() - t0) / 60;
    creature.collapse(); sim.collapse();
    tick(120);
    t0 = performance.now();
    tick(60);
    const pileStep = (performance.now() - t0) / 60;
    t0 = performance.now();
    for (let k = 0; k < 20; k++) sim.buildMesh(f, u);
    const mesh = (performance.now() - t0) / 20;
    console.log(`  idle step ${idleStep.toFixed(2)}ms | pile step ${pileStep.toFixed(2)}ms | mesh ${mesh.toFixed(2)}ms`);
    assert.ok(pileStep < 16, 'pile step too slow for 60Hz in a worker');
});

test('one torso shot knocks off a chunk, not the whole body', () => {
    const { sim, tick, creature } = setup();
    tick(60);
    const k = 0;   // pelvis->chest bone
    const bd = creature.boneData;
    const px = (bd[k] + bd[k + 3]) / 2, py = (bd[k + 1] + bd[k + 4]) / 2, pz = (bd[k + 2] + bd[k + 5]) / 2;
    const released = sim.hit(px, py, pz + 0.3, 0, 0, -1, 0.21);   // same radius the game uses
    assert.ok(released > sim.N * 0.05 && released < sim.N * 0.25, `released ${released}`);
});

test('adhesion: clingers stick along several points, hang from the ceiling, slide down walls, peel off gradually', () => {
    const { sim, tick, creature } = setup(900, 11);
    tick(30);
    creature.collapse();
    sim.collapse(0, 0, -1);
    tick(45);
    const sample = () => {
        let cling = 0, pts = 0, ceilHang = 0, wallY = 0, wallN = 0;
        for (let w = 0; w < sim.N; w++) {
            if (sim.state[w] !== CLING) continue;
            cling++;
            pts += sim.stuckN[w];
            let onCeil = false, lowest = 9;
            for (let i = 0; i < P; i++) {
                const pi = w * P + i;
                if (sim.stuckPt[pi] === 1) onCeil = true;
                if (sim.stuckPt[pi] === 2) { wallY += sim.stuckPos[pi * 3 + 1]; wallN++; }
                lowest = Math.min(lowest, sim.pos[pi * 3 + 1]);
            }
            if (onCeil && lowest < 3 - 0.4) ceilHang++;
        }
        return { cling, avgPts: pts / Math.max(1, cling), ceilHang, wallY: wallY / Math.max(1, wallN), wallN };
    };
    const a = sample();
    // follow the individual points glued to walls now (the stuck population turns over as worms peel off)
    const tracked = [];
    for (let w = 0; w < sim.N; w++) for (let i = 0; i < P; i++) { const pi = w * P + i; if (sim.stuckPt[pi] === 2) tracked.push([pi, sim.stuckPos[pi * 3 + 1]]); }
    tick(90);
    const b = sample();
    let drop = 0, still = 0;
    for (const [pi, y0] of tracked) if (sim.stuckPt[pi] === 2) { still++; drop += y0 - sim.stuckPos[pi * 3 + 1]; }
    tick(240);
    const c = sample();
    assert.ok(finite(sim));
    assert.ok(a.cling > 10, `only ${a.cling} worms clinging`);
    assert.ok(a.avgPts >= 2.5, `clingers only hold by ${a.avgPts.toFixed(1)} points`);
    assert.ok(a.ceilHang + b.ceilHang > 2, 'expected strands hanging from the ceiling');
    if (still > 3) assert.ok(drop / still > 0.02, `wall worms should creep down (mean ${(drop / still * 100).toFixed(1)}cm in 1.5s)`);
    assert.ok(b.cling > 0 && c.cling < a.cling, `should peel off gradually: ${a.cling} -> ${b.cling} -> ${c.cling}`);
});

test('body worms push each other apart without inflating the silhouette', () => {
    const measure = (bodyCollisions) => {
        const grid = new Grid();
        const level = Object.assign(grid, { creatureStart: grid.cellCenter(...grid.marks.C) });
        const creature = new Creature(level);
        creature.dormant = true;
        const sim = new WormSim({ count: 600, grid, bones: creature.boneData, coreBones: creature.coreBones, boneWeights: creature.boneWeight, seed: 3, bodyCollisions });
        const player = { pos: { x: creature.x, z: creature.z + 40 } };
        for (let k = 0; k < 150; k++) { creature.update(DT, player, 1, k * DT); sim.setCreature(creature.boneData, creature.x, creature.z, true, 0); sim.step(DT); }
        const pts = [];
        for (let w = 0; w < sim.N; w++) if (sim.state[w] === BOUND) for (let i = 1; i < P; i += 2) pts.push(w * P + i);
        let deep = 0;
        for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
            const pa = pts[a], pb = pts[b];
            if (((pa / P) | 0) === ((pb / P) | 0)) continue;
            const d = Math.hypot(sim.pos[pa * 3] - sim.pos[pb * 3], sim.pos[pa * 3 + 1] - sim.pos[pb * 3 + 1], sim.pos[pa * 3 + 2] - sim.pos[pb * 3 + 2]);
            if (d < (sim.prad[pa] + sim.prad[pb]) * 0.5) deep++;
        }
        const bd = creature.boneData;
        let rsum = 0, rn = 0;
        for (let w = 0; w < sim.N; w++) {
            const k = sim.bone[w] * 13, ax = bd[k], ay = bd[k + 1], az = bd[k + 2];
            const ux = bd[k + 3] - ax, uy = bd[k + 4] - ay, uz = bd[k + 5] - az, uu = ux * ux + uy * uy + uz * uz;
            for (let i = 0; i < P; i += 3) {
                const q = (w * P + i) * 3;
                let s = ((sim.pos[q] - ax) * ux + (sim.pos[q + 1] - ay) * uy + (sim.pos[q + 2] - az) * uz) / uu;
                s = Math.max(0, Math.min(1, s));
                rsum += Math.hypot(sim.pos[q] - ax - ux * s, sim.pos[q + 1] - ay - uy * s, sim.pos[q + 2] - az - uz * s) - bd[k + 12]; rn++;
            }
        }
        return { deep, shell: rsum / rn, ok: finite(sim) };
    };
    const off = measure(false), on = measure(true);
    assert.ok(on.ok);
    assert.ok(on.deep < off.deep * 0.65, `deep overlaps ${off.deep} -> ${on.deep}`);
    assert.ok(on.shell - off.shell < 0.03, `body inflated ${off.shell.toFixed(3)} -> ${on.shell.toFixed(3)}`);
});

test('silhouette matches the reference: narrow draped column reaching the floor, hanging worms', () => {
    const { sim, tick, creature } = setup();
    tick(150);
    const { fwd, right } = creature.frame();
    const lat = [], low = [];
    let top = 0, vert = 0, vn = 0;
    for (let w = 0; w < sim.N; w++) {
        if (sim.state[w] !== BOUND) continue;
        for (let i = 0; i < P; i++) {
            const o = (w * P + i) * 3;
            const dx = sim.pos[o] - creature.x, dz = sim.pos[o + 2] - creature.z;
            if (!sim.train[w]) lat.push(Math.abs(dx * right[0] + dz * right[2]));
            low.push(sim.pos[o + 1] < 0.35 ? 1 : 0);
            top = Math.max(top, sim.pos[o + 1]);
            if (!sim.tail[w] && !sim.train[w] && i > 3 && i < P - 1) {
                const q = o + 3;
                const tx = sim.pos[q] - sim.pos[o], ty = sim.pos[q + 1] - sim.pos[o + 1], tz = sim.pos[q + 2] - sim.pos[o + 2];
                vert += Math.abs(ty) / (Math.hypot(tx, ty, tz) || 1); vn++;
            }
        }
    }
    lat.sort((a, b) => a - b);
    const p90 = lat[Math.floor(lat.length * 0.9)];
    const lowFrac = low.reduce((a, b) => a + b, 0) / low.length;
    assert.ok(p90 < 0.42, `too wide: 90% of the body within ${p90.toFixed(2)}m of the center line`);
    assert.ok(lowFrac > 0.08, `drape barely reaches the floor (${(lowFrac * 100).toFixed(1)}% of points low)`);
    assert.ok(top > 1.95, `too short (${top.toFixed(2)}m)`);
    assert.ok(vert / vn > 0.6, `worms should hang mostly vertically (mean |dy| ${(vert / vn).toFixed(2)})`);
});

test('a train of worms drags along the floor behind it while walking', () => {
    const { sim, tick, creature, player } = setup();
    player.pos = { x: creature.x, z: creature.z + 4 };
    tick(120, { walk: true });
    const { fwd } = creature.frame();
    let behind = 0, total = 0;
    for (let w = 0; w < sim.N; w++) {
        if (!sim.train[w] || sim.state[w] !== BOUND) continue;
        for (let i = P >> 1; i < P; i++) {
            const o = (w * P + i) * 3;
            total++;
            const along = (sim.pos[o] - creature.x) * fwd[0] + (sim.pos[o + 2] - creature.z) * fwd[2];
            if (along < -0.3 && sim.pos[o + 1] < 0.12) behind++;
        }
    }
    assert.ok(total > 0, 'no train worms');
    assert.ok(behind / total > 0.3, `only ${(behind / total * 100).toFixed(0)}% of the train drags behind on the floor`);
});

test('tube triangles face outward (front faces visible, not the tube interior)', () => {
    const { sim } = setup(20);
    const f = new Float32Array(WormSim.vertexCount(sim.N) * 7), u = new Uint32Array(f.buffer);
    sim.buildMesh(f, u);
    const idx = WormSim.buildIndices(sim.N);
    let outward = 0, total = 0;
    for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t] * 7, idx[t + 1] * 7, idx[t + 2] * 7];
        const e1 = [f[b] - f[a], f[b + 1] - f[a + 1], f[b + 2] - f[a + 2]];
        const e2 = [f[c] - f[a], f[c + 1] - f[a + 1], f[c + 2] - f[a + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const vn = [f[a + 3] + f[b + 3] + f[c + 3], f[a + 4] + f[b + 4] + f[c + 4], f[a + 5] + f[b + 5] + f[c + 5]];
        const dot = n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2];
        if (Math.abs(dot) < 1e-12) continue;
        total++; if (dot > 0) outward++;
    }
    assert.ok(outward / total > 0.99, `only ${(outward / total * 100).toFixed(1)}% of triangles wind outward`);
});

test('hanging worms curl and sag instead of hanging as straight rods', () => {
    const { sim, tick } = setup();
    tick(180);
    const ratios = [];
    for (let w = 0; w < sim.N; w++) {
        if (sim.state[w] !== BOUND || sim.tail[w] || sim.train[w]) continue;
        const a = w * P * 3, b = (w * P + P - 1) * 3;
        const chord = Math.hypot(sim.pos[b] - sim.pos[a], sim.pos[b + 1] - sim.pos[a + 1], sim.pos[b + 2] - sim.pos[a + 2]);
        ratios.push(chord / (sim.seg[w] * (P - 1)));
    }
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    const straight = ratios.filter(r => r > 0.95).length / ratios.length;
    assert.ok(mean < 0.85, `hanging worms too straight: mean chord/length ${mean.toFixed(2)}`);
    assert.ok(mean > 0.4, `worms balled up: mean chord/length ${mean.toFixed(2)}`);
    assert.ok(straight < 0.15, `${(straight * 100).toFixed(0)}% of hanging worms are ruler-straight`);
});

test('attachment points sway in place instead of orbiting around the limbs', () => {
    const { sim, tick } = setup(300);
    tick(30);
    const A = new Float32Array(sim.N * 3), B = new Float32Array(sim.N * 3);
    const t0 = sim.time;
    for (let w = 0; w < sim.N; w++) sim.anchor(w, sim.tA[w], sim.angA[w], A, w * 3);
    let worst = 0, sum = 0;
    for (const dt of [5, 10, 20, 40]) {
        sim.time = t0 + dt;
        for (let w = 0; w < sim.N; w++) sim.anchor(w, sim.tA[w], sim.angA[w], B, w * 3);
        let m = 0;
        for (let w = 0; w < sim.N; w++) m += Math.hypot(B[w * 3] - A[w * 3], B[w * 3 + 1] - A[w * 3 + 1], B[w * 3 + 2] - A[w * 3 + 2]);
        m /= sim.N; sum += m; worst = Math.max(worst, m);
    }
    sim.time = t0;
    assert.ok(worst < 0.08, `anchors drift ${worst.toFixed(3)}m on average over time (orbiting)`);
});

test('worms never float out in the air like spikes (idle, walking, hit, re-forming)', () => {
    // a point floats out if it is up in the air, more than 0.5m from every body part, and not glued to a surface
    const floating = (sim, c) => {
        let n = 0, tot = 0;
        for (let w = 0; w < sim.N; w++) {
            const st = sim.state[w];
            if (st === CLING || (st === FREE && sim.timer[w] > 900)) continue;   // clinging / mid-air spray
            for (let i = 0; i < P; i++) {
                const o = (w * P + i) * 3; tot++;
                if (sim.pos[o + 1] > 0.4 && boneDist(c.boneData, sim.pos[o], sim.pos[o + 1], sim.pos[o + 2]) > 0.5) n++;
            }
        }
        return n / tot;
    };
    const results = {};
    { const { sim, tick, creature } = setup(); tick(180); results.idle = floating(sim, creature); }
    { const { sim, tick, creature, player } = setup(); player.pos = { x: creature.x, z: creature.z + 4 }; tick(150, { walk: true }); results.walking = floating(sim, creature); }
    {
        const { sim, tick, creature } = setup(); tick(60);
        const bd = creature.boneData;
        for (let k = 0; k < 3; k++) { sim.hit((bd[0] + bd[3]) / 2, 1.3, (bd[2] + bd[5]) / 2 + 0.3, 0, 0, -1, 0.38); tick(20); }
        tick(240); results.afterHits = floating(sim, creature);
    }
    {
        const { sim, tick, creature } = setup(); tick(30); creature.collapse(); sim.collapse(); tick(240);
        creature.state = 2; sim.reform(); tick(120); results.reform2s = floating(sim, creature);
        tick(240); results.reform6s = floating(sim, creature);
    }
    const bad = Object.entries(results).filter(([, f]) => f > 0.01);
    assert.equal(bad.length, 0, 'floating worm points: ' + Object.entries(results).map(([k, f]) => `${k} ${(f * 100).toFixed(2)}%`).join(', '));
});

test('after re-forming, re-attached worms flop down instead of standing up above the head', () => {
    const { sim, tick, creature } = setup();
    tick(30); creature.collapse(); sim.collapse(0, 0, -1); tick(240);
    creature.state = 2; sim.reform();
    let worst = 0;
    for (let k = 0; k < 6; k++) {
        tick(60);
        const headTop = creature.joints.head[1] + 0.13;
        let n = 0;
        for (let w = 0; w < sim.N; w++) {
            if (sim.state[w] !== BOUND) continue;
            for (let i = 0; i < P; i++) if (sim.pos[(w * P + i) * 3 + 1] > headTop + 0.15) n++;
        }
        worst = Math.max(worst, n / (sim.N * P));
    }
    assert.ok(worst < 0.0005, `${(worst * 100).toFixed(2)}% of points stand up above the head after re-forming`);
});

test('re-forming is organic: soft latching, uneven growth front, body rises as it gathers', () => {
    const { sim, tick, creature } = setup();
    tick(30); creature.collapse(); sim.collapse(0, 0, -1); tick(240);
    creature.state = 2; sim.reform();
    let maxJump = 0, earlyPelvis = 9, latePelvis = 0;
    const jumps = [];
    const windows = [];
    let windowY = [];
    const prevHead = new Float32Array(sim.N * 3);
    for (let k = 0; k < 480; k++) {
        for (let w = 0; w < sim.N; w++) { const o = w * P * 3; prevHead[w * 3] = sim.pos[o]; prevHead[w * 3 + 1] = sim.pos[o + 1]; prevHead[w * 3 + 2] = sim.pos[o + 2]; }
        const before = sim.state.slice();
        tick(1);
        for (let w = 0; w < sim.N; w++) {
            if (sim.state[w] !== BOUND || sim.bindAge[w] > 1) continue;
            const o = w * P * 3;
            const j = Math.hypot(sim.pos[o] - prevHead[w * 3], sim.pos[o + 1] - prevHead[w * 3 + 1], sim.pos[o + 2] - prevHead[w * 3 + 2]);
            maxJump = Math.max(maxJump, j); jumps.push(j);
            if (before[w] !== BOUND) windowY.push(sim.anchorA[w * 3 + 1]);
        }
        if (k % 30 === 29) { if (windowY.length >= 8) windows.push(windowY); windowY = []; }
        const bf = sim.boundFraction, py = creature.joints.pelvis[1];
        if (bf < 0.25) earlyPelvis = Math.min(earlyPelvis, py);
        if (bf > 0.85) latePelvis = Math.max(latePelvis, py);
    }
    const std = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
    const spread = windows.map(std).reduce((s, v) => s + v, 0) / windows.length;
    jumps.sort((a, b) => a - b);
    const p999 = jumps[Math.floor(jumps.length * 0.999)];
    assert.ok(p999 < 0.06, `re-attaching worm heads snap: 99.9th percentile ${(p999 * 100).toFixed(1)}cm per step`);
    assert.ok(maxJump < 0.12, `a re-attaching worm head snapped ${(maxJump * 100).toFixed(1)}cm in one step`);
    assert.ok(spread > 0.15, `growth front too flat: worms latching together span only ${spread.toFixed(2)}m of height`);
    assert.ok(earlyPelvis < 0.8, `body should start crouched (pelvis ${earlyPelvis.toFixed(2)}m)`);
    assert.ok(latePelvis > 0.95, `body should stand up once gathered (pelvis ${latePelvis.toFixed(2)}m)`);
});

test('no worm ever stretches into a rope (long gameplay stress run)', () => {
    const grid = new Grid();
    const level = Object.assign(grid, { creatureStart: grid.cellCenter(...grid.marks.C) });
    const c = new Creature(level);
    const sim = new WormSim({ count: 900, grid, bones: c.boneData, coreBones: c.coreBones, boneWeights: c.boneWeight, seed: 7 });
    const spots = [grid.cellCenter(20, 14), grid.cellCenter(13, 14), grid.cellCenter(24, 9)];
    const player = { pos: { ...spots[0] } };
    let holding = false, worst = 0, worstInfo = '';
    for (let k = 0; k < 60 * 90; k++) {
        if (k % 600 === 0) player.pos = { ...spots[(k / 600) % spots.length] };
        c.awake = true;
        c.update(DT, player, sim.boundFraction, k * DT);
        if (c.walking && sim.boundFraction < 0.5) { c.collapse(); sim.collapse(0, 0, -1); holding = true; }
        if (c.reforming && holding) { sim.reform(); holding = false; }
        if (k % 30 === 0 && c.walking) { const bd = c.boneData; sim.hit((bd[0] + bd[3]) / 2, (bd[1] + bd[4]) / 2, (bd[2] + bd[5]) / 2, Math.sin(c.yaw), 0, Math.cos(c.yaw), 0.21); }
        sim.setCreature(c.boneData, c.x, c.z, c.walking, c.speed);
        sim.step(DT);
        if (k % 10 === 0) for (let w = 0; w < sim.N; w++) {
            let L = 0;
            for (let i = 0; i < P - 1; i++) { const o = (w * P + i) * 3; L += Math.hypot(sim.pos[o + 3] - sim.pos[o], sim.pos[o + 4] - sim.pos[o + 1], sim.pos[o + 5] - sim.pos[o + 2]); }
            const r = L / (sim.seg[w] * (P - 1));
            if (r > worst) { worst = r; worstInfo = `worm ${w} state ${sim.state[w]} at ${(k * DT).toFixed(1)}s`; }
        }
    }
    assert.ok(finite(sim));
    assert.ok(worst < 1.6, `a worm stretched to ${worst.toFixed(2)}x its length (${worstInfo})`);
});
