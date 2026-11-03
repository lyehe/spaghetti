import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../src/grid.js';
import { Creature, THIGH, SHIN, UPPER_ARM, FOREARM } from '../src/creature.js';

const DT = 1 / 60;
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function make(cx, cz, yaw) {
    const grid = new Grid();
    const level = Object.assign(grid, { creatureStart: grid.cellCenter(cx, cz) });
    const c = new Creature(level);
    c.place(level.creatureStart.x, level.creatureStart.z, yaw);
    return { c, grid };
}

// long straight corridor: row 14, x 12..24 open
test('walking: planted feet never slide, legs keep their length, steps alternate', () => {
    const { c, grid } = make(13, 14, Math.PI / 2);          // facing +x
    const player = { pos: grid.cellCenter(23, 14) };
    c.awake = true;
    const x0 = c.x;
    let steps = 0, maxSlide = 0, bothSwing = 0, maxLegErr = 0, minFootY = 1, frames = 0;
    const sway = [];
    let minPelvis = 9;
    let prev = null;
    for (let k = 0; k < 240; k++) {
        c.update(DT, player, 1, k * DT);
        frames++;
        if (c.stepEvent) steps++;
        const feet = c.rig.feet;
        if (!feet[0].planted && !feet[1].planted) bothSwing++;
        if (prev) for (let i = 0; i < 2; i++) {
            if (feet[i].planted && prev[i].planted) maxSlide = Math.max(maxSlide, d3(feet[i].pos, prev[i].pos));
        }
        prev = feet.map(f => ({ planted: f.planted, pos: f.pos.slice() }));
        const J = c.joints;
        for (const s of ['L', 'R']) {
            maxLegErr = Math.max(maxLegErr, Math.abs(d3(J['hi' + s], J['kn' + s]) - THIGH) / THIGH, Math.abs(d3(J['kn' + s], J['ft' + s]) - SHIN) / SHIN);
            minFootY = Math.min(minFootY, J['ft' + s][1]);
        }
        if (k > 60) { sway.push(J.pelvis[2] - c.z); minPelvis = Math.min(minPelvis, J.pelvis[1]); }
    }
    const secs = frames * DT;
    assert.ok(c.x - x0 > 3, `only walked ${(c.x - x0).toFixed(2)}m`);
    assert.ok(maxSlide < 0.002, `planted foot slid ${(maxSlide * 1000).toFixed(1)}mm in one frame`);
    assert.equal(bothSwing, 0, 'both feet were in the air at once');
    assert.ok(maxLegErr < 0.02, `leg bone length error ${(maxLegErr * 100).toFixed(1)}%`);
    assert.ok(minFootY >= 0.03, `foot went through the floor (${minFootY.toFixed(3)})`);
    const rate = steps / secs;
    assert.ok(rate > 1.5 && rate < 5, `step rate ${rate.toFixed(2)}/s`);
    assert.ok(minPelvis > 0.85, "hips dropped to " + minPelvis.toFixed(2) + "m (stride too long for the legs)");
    const swayAmp = Math.max(...sway) - Math.min(...sway);
    assert.ok(swayAmp > 0.03, `pelvis barely shifts weight (${swayAmp.toFixed(3)}m)`);
});

test('arms hang and swing with fixed segment lengths', () => {
    const { c, grid } = make(13, 14, Math.PI / 2);
    const player = { pos: grid.cellCenter(23, 14) };
    c.awake = true;
    let maxErr = 0, handAbove = 0;
    const handTrack = [];
    for (let k = 0; k < 180; k++) {
        c.update(DT, player, 1, k * DT);
        const J = c.joints;
        for (const s of ['L', 'R']) {
            maxErr = Math.max(maxErr, Math.abs(d3(J['sh' + s], J['el' + s]) - UPPER_ARM) / UPPER_ARM, Math.abs(d3(J['el' + s], J['ha' + s]) - FOREARM) / FOREARM);
            if (J['ha' + s][1] > J['sh' + s][1]) handAbove++;
        }
        if (k > 60) handTrack.push(c.joints.haL[0] - c.joints.pelvis[0]);
    }
    assert.ok(maxErr < 0.03, `arm length error ${(maxErr * 100).toFixed(1)}%`);
    assert.equal(handAbove, 0, 'hands should hang below the shoulders');
    assert.ok(Math.max(...handTrack) - Math.min(...handTrack) > 0.05, 'arms should swing relative to the body');
});

test('a hit makes it lurch back and stagger-step, then recover', () => {
    const { c, grid } = make(18, 14, Math.PI / 2);          // facing +x, standing still
    const player = { pos: grid.cellCenter(18, 14) };
    c.dormant = true;
    for (let k = 0; k < 60; k++) c.update(DT, player, 1, k * DT);
    const lean = () => (c.joints.chest[0] - c.joints.pelvis[0]);   // forward is +x
    const before = lean();
    c.impact(-1, 0);                                         // shot from the front pushes toward -x
    let minLean = before, steps = 0;
    for (let k = 0; k < 60; k++) { c.update(DT, player, 1, 1 + k * DT); minLean = Math.min(minLean, lean()); if (c.stepEvent) steps++; }
    assert.ok(before - minLean > 0.08, `torso only lurched ${(before - minLean).toFixed(3)}m`);
    assert.ok(steps >= 1, 'should take a stagger step');
    for (let k = 0; k < 120; k++) c.update(DT, player, 1, 2 + k * DT);
    assert.ok(Math.abs(lean() - before) < 0.04, `did not recover (${(lean() - before).toFixed(3)})`);
    assert.ok(c.rig.feet.every(f => f.planted), 'feet settle when it stands still');
});

test('collapse and re-form keep every joint finite (small and large creatures)', () => {
    for (const scale of [0.6, 1, 1.3]) {
        const { c, grid } = make(18, 14, Math.PI / 2);
        c.s = scale; c.rig = null;
        const player = { pos: grid.cellCenter(18, 14) };
        c.dormant = true;
        for (let k = 0; k < 30; k++) c.update(DT, player, 1, k * DT);
        c.collapse();
        for (let k = 0; k < 400; k++) {
            c.update(DT, player, k > 330 ? 0.5 : 0, k * DT);
            for (const v of c.boneData) assert.ok(Number.isFinite(v), `non-finite bone data at scale ${scale}, step ${k}`);
        }
    }
});
