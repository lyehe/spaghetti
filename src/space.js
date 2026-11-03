import * as pc from 'playcanvas';
import { ShadowCatcher } from 'playcanvas/scripts/esm/shadow-catcher.mjs';
import { CollisionMesh, parseOBJ } from './collision.js';
import { SPACES } from './spaces.js';

// A playable space: a Gaussian-splat capture for the looks + a triangle collision mesh for physics.
// The returned object is a Grid (rasterized from the mesh) extended with what the game needs:
// start points, the mesh raycast, lights and the splat entity.

async function fetchCollision(def) {
    if (def.procedural) return def.procedural();
    const res = await fetch(def.collision);
    if (!res.ok) throw new Error(`collision mesh ${def.collision}: ${res.status}`);
    if (def.collision.endsWith('.obj')) return parseOBJ(await res.text());
    const j = await res.json();
    return new CollisionMesh(j.positions, j.indices);
}

function loadAsset(app, name, type, url) {
    return new Promise((resolve, reject) => {
        const a = new pc.Asset(name, type, { url });
        app.assets.add(a);
        a.once('error', (e) => reject(new Error(`${url}: ${e}`)));
        a.ready(() => resolve(a));
        app.assets.load(a);
    });
}

export async function loadSpace(app, name, { onProgress = () => {}, showCollision = false } = {}) {
    const def = SPACES[name] || SPACES[Object.keys(SPACES)[0]];
    onProgress(`Loading ${def.title}…`);
    const mesh = await fetchCollision(def);
    const lv = mesh.toGrid({ cell: 0.25, wallH: def.wallH, navRadius: 0.3, start: { x: def.start[0], z: def.start[1] }, terrain: !!def.terrain });
    lv.def = def;
    lv.mesh = mesh;
    lv.start = { x: def.start[0], y: lv.groundAt(def.start[0], def.start[1]), z: def.start[1] };
    lv.creatureStart = lv.start;
    // rays hit the real triangles (and the floor / ceiling planes)
    lv.raycast = (o, d, maxDist = 60) => {
        let t = mesh.raycast(o, d, maxDist);
        if (d.y < 0 && !def.terrain) t = Math.min(t, -o.y / d.y);
        if (d.y > 0) t = Math.min(t, (def.wallH - o.y) / d.y);
        return Math.max(0, t);
    };
    lv.updateLights = () => {};
    lv.updateShadowLights = () => {};

    const scene = app.scene;
    scene.fog.type = pc.FOG_NONE;
    const L = def.lighting || {};
    scene.ambientLight = new pc.Color(...(L.ambient || [0.42, 0.38, 0.34]));

    // key light: the only shadow caster; its shadows land on the splat floor via a shadow catcher
    const sun = new pc.Entity('key');
    sun.addComponent('light', {
        type: 'directional', color: new pc.Color(...(L.keyColor || [1, 0.94, 0.85])), intensity: L.keyIntensity ?? 1.4,
        castShadows: true, shadowResolution: 1024, shadowDistance: 14, shadowBias: 0.25, normalOffsetBias: 0.05, shadowIntensity: def.shadowIntensity ?? 1,
        shadowType: pc.SHADOW_PCF3_16F
    });
    sun.setEulerAngles(...(L.keyAngles || [55, 30, 0]));
    app.root.addChild(sun);
    // soft fill from the opposite side so faces in shadow keep some shape
    const fill = new pc.Entity('fill');
    fill.addComponent('light', { type: 'directional', color: new pc.Color(...(L.fillColor || [0.55, 0.6, 0.7])), intensity: L.fillIntensity ?? 0.35, castShadows: false });
    fill.setEulerAngles(40, 210, 0);
    app.root.addChild(fill);
    lv.sun = sun;

    const W = lv.w * lv.CELL, H = lv.h * lv.CELL;
    const catcher = new pc.Entity('shadow-catcher');
    if (def.terrain) {
        // shadows land on the real ground: the walkable (upward-facing) triangles of the collision mesh
        const P = mesh.pos, I = mesh.idx, keep = [];
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
            const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
            if (Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1) > 0.7) keep.push(I[t], I[t + 1], I[t + 2]);
        }
        const gm = new pc.Mesh(app.graphicsDevice);
        gm.setPositions(P); gm.setIndices(keep);
        gm.setNormals(pc.calculateNormals(Array.from(P), keep));
        gm.update();
        const tmp = new pc.StandardMaterial();
        catcher.addComponent('render', { meshInstances: [new pc.MeshInstance(gm, tmp)], castShadows: false, receiveShadows: true });
        catcher.setPosition(0, 0.01, 0);
        catcher.addComponent('script').create(ShadowCatcher, { properties: { scale: new pc.Vec3(1, 1, 1), drawBucket: 0 } });
    } else {
        catcher.addComponent('script').create(ShadowCatcher, { properties: { scale: new pc.Vec3(W, 1, H), drawBucket: 0 } });
        catcher.setPosition(W / 2, 0.004, H / 2);
    }
    // drawBucket 0: drawn after the splats, so the shadow darkens the splat ground
    app.root.addChild(catcher);

    // the splat itself
    if (def.splat) {
        try {
            onProgress(`Loading ${def.title} (splats)…`);
            const asset = await loadAsset(app, name + '-splat', 'gsplat', def.splat);
            const e = new pc.Entity('splat');
            e.addComponent('gsplat', { asset });
            const T = def.transform || {};
            if (T.position) e.setLocalPosition(...T.position);
            if (T.rotation) e.setLocalEulerAngles(...T.rotation);
            if (T.quat) e.setLocalRotation(new pc.Quat(...T.quat));
            if (T.scale) e.setLocalScale(T.scale, T.scale, T.scale);
            app.root.addChild(e);
            lv.splat = e;
        } catch (err) {
            console.warn('splat failed to load, showing the collision mesh instead', err);
            showCollision = true;
        }
    } else showCollision = true;

    if (showCollision) {
        const m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(0.62, 0.56, 0.48); m.gloss = 0.25; m.useMetalness = true;
        if (lv.splat) { m.opacity = 0.35; m.blendType = pc.BLEND_NORMAL; m.depthWrite = false; }
        m.update();
        const pm = new pc.Mesh(app.graphicsDevice);
        pm.setPositions(mesh.pos);
        pm.setIndices(mesh.idx);
        pm.setNormals(pc.calculateNormals(Array.from(mesh.pos), Array.from(mesh.idx)));
        pm.update();
        const e = new pc.Entity('collision-mesh');
        e.addComponent('render', { meshInstances: [new pc.MeshInstance(pm, m)], castShadows: false, receiveShadows: true });
        app.root.addChild(e);
        lv.collisionEntity = e;
    }
    return lv;
}

