// Runs the worm simulation + tube mesh build off the main thread.
import { WormSim } from '../sim/wormsim.js';
import { Grid } from '../world/grid.js';

const FIXED = 1 / 60;
const MAX_STEPS = 2;
let sim = null;
let acc = 0;

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        sim = new WormSim({
            count: m.count, grid: Grid.fromData(m.grid), bones: m.bones,
            coreBones: m.coreBones, boneWeights: m.boneWeights, seed: m.seed, bodyCollisions: m.bodyCollisions
        });
        self.postMessage({ type: 'ready' });
        return;
    }
    if (m.type !== 'frame' || !sim) return;

    let released = 0;
    for (const ev of m.events) {
        if (ev.type === 'hit') released += sim.hit(ev.p[0], ev.p[1], ev.p[2], ev.d[0], ev.d[1], ev.d[2], ev.r);
        else if (ev.type === 'collapse') sim.collapse(ev.d[0], ev.d[1], ev.d[2]);
        else if (ev.type === 'reform') sim.reform();
        else if (ev.type === 'reset') sim.placeAll();
    }
    sim.setCreature(m.bones, m.cx, m.cz, m.walking, m.speed);

    const t0 = performance.now();
    acc += Math.min(m.dt, 0.1);
    let n = 0;
    while (acc >= FIXED && n < MAX_STEPS) { sim.step(FIXED); acc -= FIXED; n++; }
    if (acc > FIXED) acc = 0;      // can't keep up: slow the sim down rather than spiral
    const t1 = performance.now();

    const buf = m.buffer;
    sim.buildMesh(new Float32Array(buf), new Uint32Array(buf));
    const t2 = performance.now();
    self.postMessage({ type: 'frame', buffer: buf, boundCount: sim.boundCount, released, stepMs: t1 - t0, meshMs: t2 - t1, steps: n }, [buf]);
};
