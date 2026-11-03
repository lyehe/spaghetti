// Worker hosting one WormSim per monster. Steps them all and builds their meshes off the main thread.
import { WormSim, P, FREE, CLING, RETURN } from './wormsim.js';
import { Grid } from '../grid.js';

const FIXED = 1 / 60;
const sims = new Map();
let acc = 0;

// loose strands (edible): [w, x, y, z] of each strand's middle point
function looseList(sim) {
    const out = [];
    const m = (P >> 1) * 3;
    for (let w = 0; w < sim.N; w++) {
        const st = sim.state[w];
        if (st !== FREE && st !== CLING && st !== RETURN) continue;
        const o = w * P * 3 + m;
        out.push(w, sim.pos[o], sim.pos[o + 1], sim.pos[o + 2]);
    }
    return new Float32Array(out);
}

export function handle(m, post) {
    if (m.type === 'add') {
        const o = m.opts;
        sims.set(m.id, new WormSim({ ...o, grid: Grid.fromData(o.grid) }));
        return;
    }
    if (m.type === 'remove') { sims.delete(m.id); return; }
    if (m.type !== 'frame') return;

    for (const s of m.sims) {
        const sim = sims.get(s.id);
        if (!sim) continue;
        s.released = 0;
        for (const ev of s.events) {
            if (ev.type === 'hit') s.released += sim.hit(ev.p[0], ev.p[1], ev.p[2], ev.d[0], ev.d[1], ev.d[2], ev.r, !!ev.any);
            else if (ev.type === 'chunk') s.released += sim.chunk(ev.p[0], ev.p[1], ev.p[2], ev.d[0], ev.d[1], ev.d[2], ev.n);
            else if (ev.type === 'collapse') sim.collapse(ev.d[0], ev.d[1], ev.d[2]);
            else if (ev.type === 'slurp') for (const w of ev.ids) { const st = sim.state[w]; if (st === FREE || st === CLING || st === RETURN) sim.slurp(w); }
            else if (ev.type === 'reset') sim.placeAll();
            else if (ev.type === 'reform') sim.reform();
        }
        sim.setCreature(s.bones, s.cx, s.cz, s.walking, s.speed);
        sim.setMouth(s.mouth[0], s.mouth[1], s.mouth[2]);
    }
    acc += Math.min(m.dt, 0.1);
    let n = 0;
    const t0 = performance.now();
    while (acc >= FIXED && n < 2) {
        for (const s of m.sims) { const sim = sims.get(s.id); if (sim) sim.step(FIXED); }
        acc -= FIXED; n++;
    }
    if (acc > FIXED) acc = 0;
    const stepMs = performance.now() - t0;
    const out = [], transfer = [];
    for (const s of m.sims) {
        const sim = sims.get(s.id);
        if (!sim) continue;
        sim.buildMesh(new Float32Array(s.buffer), new Uint32Array(s.buffer));
        const loose = looseList(sim);
        out.push({ id: s.id, buffer: s.buffer, boundCount: sim.boundCount, eaten: sim.eatenCount, released: s.released, loose });
        transfer.push(s.buffer, loose.buffer);
    }
    post({ type: 'frame', sims: out, stepMs }, transfer);
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.onmessage = (e) => handle(e.data, (msg, tr) => self.postMessage(msg, tr));
}
