import * as pc from 'playcanvas';
import { WormSim } from './sim/wormsim.js';
import { handle } from './sim/noodleworker.js';

// Main-thread side of the noodle simulation: one GPU mesh per monster, all sims stepped in one
// worker message per frame (or inline for debugging). Each body exposes boundCount / eaten / loose
// (the loose strands' midpoints, used to aim the eating).
export class NoodleHost {
    constructor(app, level, { useWorker = true } = {}) {
        this.app = app;
        this.level = level;
        this.bodies = new Map();
        this.pending = false;
        this.accDt = 0;
        this.stepMs = 0;
        this.material = NoodleHost.makeMaterial();
        if (useWorker && typeof Worker !== 'undefined') {
            try {
                this.worker = new Worker(new URL('./sim/noodleworker.js', import.meta.url), { type: 'module' });
                this.worker.onmessage = (e) => this.onResult(e.data);
                this.worker.onerror = (e) => { console.error('noodle worker failed; running inline', e.message); this.worker = null; this.pending = false; };
            } catch (err) { this.worker = null; }
        }
    }

    static makeMaterial() {
        // cooked pasta with glossy tomato sauce: vertex colors carry the pasta/sauce mix
        const m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(1, 1, 1);
        m.diffuseVertexColor = true;
        m.useMetalness = true;
        m.metalness = 0;
        m.gloss = 0.7;
        m.specularityFactor = 0.7;
        m.clearCoat = 0.5;
        m.clearCoatGloss = 0.85;
        m.update();
        return m;
    }

    add(id, opts) {
        const device = this.app.graphicsDevice;
        const N = opts.count;
        const numVerts = WormSim.vertexCount(N);
        const indices = WormSim.buildIndices(N);
        const format = new pc.VertexFormat(device, [
            { semantic: pc.SEMANTIC_POSITION, components: 3, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_NORMAL, components: 3, type: pc.TYPE_FLOAT32 },
            { semantic: pc.SEMANTIC_COLOR, components: 4, type: pc.TYPE_UINT8, normalize: true }
        ]);
        const bytes = format.size * numVerts;
        const vb = new pc.VertexBuffer(device, format, numVerts, { usage: pc.BUFFER_DYNAMIC });
        vb.unlock();
        const ib = new pc.IndexBuffer(device, pc.INDEXFORMAT_UINT32, indices.length, pc.BUFFER_STATIC, indices);
        const mesh = new pc.Mesh(device);
        mesh.vertexBuffer = vb;
        mesh.indexBuffer[0] = ib;
        mesh.primitive[0].type = pc.PRIMITIVE_TRIANGLES;
        mesh.primitive[0].base = 0;
        mesh.primitive[0].count = indices.length;
        mesh.primitive[0].indexed = true;
        mesh.aabb = new pc.BoundingBox(new pc.Vec3(0, 0, 0), new pc.Vec3(1000, 1000, 1000));
        const mi = new pc.MeshInstance(mesh, this.material);
        mi.cull = false;
        const entity = new pc.Entity('noodles-' + id);
        entity.addComponent('render', { meshInstances: [mi], castShadows: true });
        this.app.root.addChild(entity);

        const body = {
            id, N, entity, vb, bytes, buffer: new ArrayBuffer(bytes),
            boundCount: N, eaten: 0, released: 0, loose: new Float32Array(0), events: []
        };
        this.bodies.set(id, body);
        const msg = { type: 'add', id, opts: { ...opts, grid: { ...opts.grid, cells: opts.grid.cells.slice() } } };
        if (this.worker) this.worker.postMessage(msg); else handle(msg, () => {});
        return body;
    }

    remove(id) {
        const b = this.bodies.get(id);
        if (!b) return;
        b.entity.destroy();
        this.bodies.delete(id);
        const msg = { type: 'remove', id };
        if (this.worker) this.worker.postMessage(msg); else handle(msg, () => {});
    }

    // drivers: Map id -> { bones, x, z, walking, speed, mouth: [x,y,z] }
    update(dt, drivers) {
        this.accDt += dt;
        if (this.pending) return;
        const sims = [], transfer = [];
        for (const [id, b] of this.bodies) {
            const d = drivers.get(id);
            if (!d || !b.buffer) continue;
            sims.push({ id, bones: d.bones.slice(), cx: d.x, cz: d.z, walking: d.walking, speed: d.speed, mouth: d.mouth, events: b.events, buffer: b.buffer });
            if (this.worker) transfer.push(b.buffer);
            b.events = [];
            if (this.worker) b.buffer = null;
        }
        const msg = { type: 'frame', dt: this.accDt, sims };
        this.accDt = 0;
        if (this.worker) { this.pending = true; this.worker.postMessage(msg, transfer); }
        else handle(msg, (res) => this.onResult(res));
    }

    onResult(m) {
        if (m.type !== 'frame') return;
        this.pending = false;
        this.stepMs = m.stepMs;
        for (const r of m.sims) {
            const b = this.bodies.get(r.id);
            if (!b) continue;
            b.buffer = r.buffer;
            const dst = b.vb.lock();
            new Uint8Array(dst.buffer ?? dst).set(new Uint8Array(r.buffer));
            b.vb.unlock();
            // events queued after this frame was sent (e.g. a collapse) win over the stale count
            if (!b.events.some(e => e.type === 'collapse' || e.type === 'reset')) b.boundCount = r.boundCount;
            b.eaten = r.eaten;
            b.released += r.released;
            b.loose = r.loose;
        }
        // bodies whose buffer was lost (removed mid-flight) get a fresh one
        for (const b of this.bodies.values()) if (!b.buffer && !this.pending) b.buffer = new ArrayBuffer(b.bytes);
    }

    // loose strands of a body near a point, nearest first
    edibleNear(body, p, radius, max = 6) {
        const L = body.loose, out = [];
        for (let i = 0; i < L.length; i += 4) {
            const d = Math.hypot(L[i + 1] - p[0], L[i + 2] - p[1], L[i + 3] - p[2]);
            if (d < radius) out.push([d, L[i]]);
        }
        out.sort((a, b) => a[0] - b[0]);
        return out.slice(0, max).map(o => o[1]);
    }
}
