import * as pc from 'playcanvas';
import { WormSim } from './sim/wormsim.js';
import { Grid } from './grid.js';

const FIXED = 1 / 60;

// Owns the worm tube mesh on the GPU. The physics runs in a Web Worker (default) or inline
// (debug / fallback); both paths fill the same interleaved vertex layout.
export class Worms {
    constructor(app, creature, level, count = 900, { useWorker = true, bodyCollisions = true } = {}) {
        this.app = app;
        this.creature = creature;
        this.N = count;
        this.boundCount = count;
        this.holding = false;
        this.events = [];
        this.stats = { stepMs: 0, meshMs: 0 };
        this.createMesh();

        const init = {
            count, grid: level.toData(), bones: creature.boneData,
            coreBones: creature.coreBones, boneWeights: creature.boneWeight, seed: 1234, bodyCollisions
        };
        if (useWorker && typeof Worker !== 'undefined') {
            try {
                this.worker = new Worker(new URL('./sim/worker.js', import.meta.url), { type: 'module' });
                this.worker.onmessage = (e) => this.onWorker(e.data);
                this.worker.onerror = (e) => { console.error('worm worker failed, running inline', e.message); this.goInline(init); };
                this.worker.postMessage({ type: 'init', ...init, grid: { ...init.grid, cells: init.grid.cells.slice() } });
                this.pool = [new ArrayBuffer(this.bytes), new ArrayBuffer(this.bytes)];
                this.pending = false;
                this.accDt = 0;
            } catch (err) {
                this.goInline(init);
            }
        } else {
            this.goInline(init);
        }
    }

    goInline(init) {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        this.sim = new WormSim({ ...init, grid: Grid.fromData(init.grid) });
        this.acc = 0;
        this.scratch = new ArrayBuffer(this.bytes);
        this.sf = new Float32Array(this.scratch);
        this.su = new Uint32Array(this.scratch);
    }

    get boundFraction() { return this.boundCount / this.N; }

    // ---- gameplay API ----
    hit(px, py, pz, dir, radius = 0.5) {
        if (this.sim) return this.sim.hit(px, py, pz, dir.x, dir.y, dir.z, radius);
        this.events.push({ type: 'hit', p: [px, py, pz], d: [dir.x, dir.y, dir.z], r: radius });
        return -1;   // unknown until the worker answers
    }

    collapseAll(dir = { x: 0, y: 0, z: 0 }) {
        this.holding = true;
        this.boundCount = 0;
        if (this.sim) { this.sim.collapse(dir.x, dir.y, dir.z); return; }
        this.events.push({ type: 'collapse', d: [dir.x, dir.y, dir.z] });
    }

    startReform() {
        this.holding = false;
        if (this.sim) { this.sim.reform(); return; }
        this.events.push({ type: 'reform' });
    }

    placeAll() {
        this.holding = false;
        this.boundCount = this.N;
        if (this.sim) { this.sim.placeAll(); return; }
        this.events.push({ type: 'reset' });
    }

    // ---- per frame ----
    update(dt) {
        const cr = this.creature;
        if (this.sim) {
            this.sim.setCreature(cr.boneData, cr.x, cr.z, cr.walking, cr.speed);
            this.acc += Math.min(dt, 0.05);
            let n = 0;
            const t0 = performance.now();
            while (this.acc >= FIXED && n < 2) { this.sim.step(FIXED); this.acc -= FIXED; n++; }
            if (this.acc > FIXED) this.acc = 0;
            const t1 = performance.now();
            this.sim.buildMesh(this.sf, this.su);
            this.stats.stepMs = t1 - t0; this.stats.meshMs = performance.now() - t1;
            this.boundCount = this.sim.boundCount;
            this.upload(this.scratch);
            return;
        }
        this.accDt += dt;
        if (this.pending || !this.pool.length) return;
        const buffer = this.pool.pop();
        this.worker.postMessage({
            type: 'frame', dt: this.accDt, events: this.events, bones: cr.boneData.slice(),
            cx: cr.x, cz: cr.z, walking: cr.walking, speed: cr.speed, buffer
        }, [buffer]);
        this.accDt = 0;
        this.events = [];
        this.pending = true;
    }

    onWorker(m) {
        if (m.type !== 'frame') return;
        this.pending = false;
        this.upload(m.buffer);
        this.pool.push(m.buffer);
        // the worker is authoritative, except while a collapse we queued hasn't reached it yet
        if (!this.events.some(e => e.type === 'collapse' || e.type === 'reset')) this.boundCount = m.boundCount;
        this.stats.stepMs = m.stepMs; this.stats.meshMs = m.meshMs;
    }

    upload(buffer) {
        const dst = this.vb.lock();
        new Uint8Array(dst.buffer ?? dst).set(new Uint8Array(buffer));
        this.vb.unlock();
    }

    // ---- rendering setup ----
    createMesh() {
        const device = this.app.graphicsDevice;
        const N = this.N;
        this.numVerts = WormSim.vertexCount(N);
        const indices = WormSim.buildIndices(N);
        const format = new pc.VertexFormat(device, [
            { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_NORMAL, components: 3, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_COLOR, components: 4, type: pc.TYPE_UINT8, normalize: true }
        ]);
        if (format.size !== 28) throw new Error(`unexpected vertex stride ${format.size}`);
        this.bytes = format.size * this.numVerts;
        this.vb = new pc.VertexBuffer(device, format, this.numVerts, { usage: pc.BUFFER_DYNAMIC });
        this.vb.unlock();   // allocate the GL buffer now; the first sim frame may arrive after the first draw
        const ib = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT32, indices.length, pc.BUFFER_STATIC, indices);

        const mesh = new pc.Mesh(device);
        mesh.vertexBuffer = this.vb;
        mesh.indexBuffer[0] = ib;
        mesh.primitive[0].type = pc.PRIMITIVE_TRIANGLES;
        mesh.primitive[0].base = 0;
        mesh.primitive[0].count = indices.length;
        mesh.primitive[0].indexed = true;
        mesh.aabb = new pc.BoundingBox(new pc.Vec3(0, 0, 0), new pc.Vec3(1000, 1000, 1000));

        // wet flesh: dark vertex-colored diffuse, glossy base + clear coat slime, reddish sheen
        const mat = new pc.StandardMaterial();
        mat.diffuse = new pc.Color(1, 1, 1);
        mat.diffuseVertexColor = true;
        mat.useMetalness = true;
        mat.metalness = 0;
        mat.gloss = 0.6;
        mat.specularityFactor = 0.6;
        mat.clearCoat = 0.9;
        mat.clearCoatGloss = 0.88;
        mat.useSheen = true;
        mat.sheen = new pc.Color(0.5, 0.12, 0.12);
        mat.sheenGloss = 0.4;
        mat.update();
        this.material = mat;

        const mi = new pc.MeshInstance(mesh, mat);
        mi.cull = false;
        const e = new pc.Entity('worms');
        e.addComponent('render', { meshInstances: [mi], castShadows: true });
        this.app.root.addChild(e);
    }
}
