import * as pc from 'playcanvas';
import { ShadowCatcher } from 'playcanvas/scripts/esm/shadow-catcher.mjs';
import { ProceduralSky } from 'playcanvas/scripts/esm/sky/procedural-sky.mjs';
import { GSplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
import { addStaticMesh } from './physics.js';
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

// Image-based lighting from a painted sky: a gradient dome (zenith -> horizon -> ground) with a soft
// sun glow. It gives metal something to reflect (the fork) and skin / cloth a sky-and-ground ambient
// instead of one flat colour. Indoors the dome is the room's warm ambient.
function makeEnvironment(app, def) {
    const L = def.lighting || {};
    const W = 128, H = 64, data = new Uint8Array(W * H * 4);
    const outdoor = !!def.sky;
    const amb = L.ambient || [0.42, 0.38, 0.34];
    const zen = outdoor ? [0.32, 0.5, 0.82] : amb.map(c => c * 0.8);
    const hor = outdoor ? (def.sky || [0.7, 0.78, 0.88]).map(c => Math.min(1, c * 1.12)) : amb.map(c => Math.min(1, c * 1.35));
    const gnd = outdoor ? [0.3, 0.29, 0.22] : amb.map(c => c * 0.6);
    const [ex, ey] = L.keyAngles || [55, 30, 0];
    // the key light shines along its -Y; the sun sits the other way
    const sd = new pc.Vec3(); new pc.Quat().setFromEulerAngles(ex, ey, 0).transformVector(pc.Vec3.UP, sd);
    const toSRGB = (c) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2));
    for (let y = 0; y < H; y++) {
        const el = (0.5 - (y + 0.5) / H) * Math.PI;           // +pi/2 = up
        for (let x = 0; x < W; x++) {
            const az = ((x + 0.5) / W) * Math.PI * 2;
            const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
            let c;
            if (el > 0) { const t = Math.pow(Math.sin(el), 0.55); c = hor.map((h, i) => h + (zen[i] - h) * t); }
            else { const t = Math.min(1, -Math.sin(el) * 3); c = hor.map((h, i) => h * 0.75 + (gnd[i] - h * 0.75) * t); }
            if (outdoor) {
                const s = Math.max(0, d[0] * sd.x + d[1] * sd.y + d[2] * sd.z);
                const glow = Math.pow(s, 24) * 0.9 + Math.pow(s, 6) * 0.12;
                c = c.map((v, i) => v + glow * [1, 0.93, 0.8][i]);
            }
            const o = (y * W + x) * 4;
            data[o] = toSRGB(c[0]); data[o + 1] = toSRGB(c[1]); data[o + 2] = toSRGB(c[2]); data[o + 3] = 255;
        }
    }
    const device = app.graphicsDevice;
    const tex = new pc.Texture(device, {
        name: 'sky-dome', width: W, height: H, format: pc.PIXELFORMAT_SRGBA8, mipmaps: false,
        projection: pc.TEXTUREPROJECTION_EQUIRECT, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        levels: [data]
    });
    const src = pc.EnvLighting.generateLightingSource(tex);
    const atlas = pc.EnvLighting.generateAtlas(src);
    app.scene.envAtlas = atlas;
    app.scene.skyboxIntensity = L.envIntensity ?? (outdoor ? 0.75 : 0.65);
    app.scene.skyboxMip = 1;
    tex.destroy(); src.destroy();
}

// options: physics (add static colliders for the rigidbody hero), reveal (the splat sweeps in)
export async function loadSpace(app, name, { onProgress = () => {}, showCollision = false, physics = false, reveal = false } = {}) {
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
    // the sky: outdoors PlayCanvas's procedural (Preetham) daylight sky lights the scene and keeps the
    // sun in sync; its sun sits where the capture's own sun was (the key light). Indoors a painted dome.
    lv.envLit = false;
    if (def.sky && !new URLSearchParams(location.search).has('paintedsky')) {
        try {
            const sd = new pc.Vec3();
            new pc.Quat().setFromEulerAngles(...(L.keyAngles || [55, 30, 0])).transformVector(pc.Vec3.UP, sd);
            const sky = new pc.Entity('sky');
            sky.addComponent('script').create(ProceduralSky, { properties: {
                elevation: Math.asin(sd.y) * pc.math.RAD_TO_DEG, azimuth: Math.atan2(sd.x, sd.z) * pc.math.RAD_TO_DEG,
                turbidity: L.turbidity ?? 3, sunLight: sun, luminance: 1
            } });
            app.root.addChild(sky);
            scene.skyboxIntensity = L.skyIntensity ?? 0.25;           // the analytic sky is HDR: much brighter than the painted dome
            lv.sky = sky; lv.envLit = true;
        } catch (err) { console.warn('procedural sky unavailable', err); }
    }
    if (!lv.envLit) try { makeEnvironment(app, def); lv.envLit = true; } catch (err) { console.warn('environment lighting unavailable', err); }

    // physics: the collision mesh as a static triangle collider (+ a floor plane indoors)
    if (physics) {
        lv.collider = addStaticMesh(app, mesh.pos, mesh.idx);
        if (!def.terrain) {
            const floor = new pc.Entity('floor-collider');
            floor.addComponent('collision', { type: 'box', halfExtents: new pc.Vec3(lv.w * lv.CELL / 2 + 5, 0.5, lv.h * lv.CELL / 2 + 5) });
            floor.addComponent('rigidbody', { type: 'static', friction: 0.4 });
            floor.setPosition(lv.w * lv.CELL / 2, -0.5, lv.h * lv.CELL / 2);
            app.root.addChild(floor);
        }
        lv.physics = true;
    }

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
        // an opaque ground under the splat: the scan's ground has thin, see-through patches, and a
        // bright sky dome behind them reads as white blotches. Unlit, the colour of the paving.
        const bm = new pc.StandardMaterial();
        bm.diffuse = new pc.Color(0, 0, 0); bm.useLighting = false; bm.emissive = new pc.Color(...(def.groundColor || [0.3, 0.28, 0.23])); bm.update();
        // only the real ground (not bench seats or the tops of tree canopies), well below the splat
        const low = keep.filter((_, i) => i % 3 === 0).flatMap((_, t) => {
            const a = keep[t * 3] * 3, b = keep[t * 3 + 1] * 3, c = keep[t * 3 + 2] * 3;
            const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
            return cy - lv.groundAt(cx, cz) < 0.3 ? [keep[t * 3], keep[t * 3 + 1], keep[t * 3 + 2]] : [];
        });
        const bmesh = new pc.Mesh(app.graphicsDevice);
        bmesh.setPositions(P); bmesh.setIndices(low); bmesh.update();
        const backdrop = new pc.Entity('ground-backdrop');
        backdrop.addComponent('render', { meshInstances: [new pc.MeshInstance(bmesh, bm)], castShadows: false, receiveShadows: false });
        backdrop.setPosition(0, -0.25, 0);
        app.root.addChild(backdrop);
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
            if (reveal) {
                // PlayCanvas's radial reveal: the scan sweeps in from where the hero stands
                const c = new pc.Vec3();
                e.getWorldTransform().clone().invert().transformPoint(new pc.Vec3(lv.start.x, lv.start.y, lv.start.z), c);
                e.addComponent('script').create(GSplatRevealRadial, { properties: {
                    center: c, speed: 2.5, acceleration: 3, delay: 0.8, endRadius: 40, oscillationIntensity: 0.15,
                    dotTint: new pc.Color(1, 0.8, 0.45), waveTint: new pc.Color(3, 0.5, 0.15)
                } });
            }
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

