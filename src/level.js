import * as pc from 'playcanvas';
import { CELL, WALL_H } from './map.js';
import { Grid } from './grid.js';

// ---------- procedural canvas textures ----------
function rand(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function canvasTex(device, w, h, draw, name) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new pc.Texture(device, {
        name, width: w, height: h, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true,
        addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT,
        minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR, anisotropy: 8
    });
    tex.setSource(c);
    return tex;
}

function stains(ctx, w, h, r, n, color, maxR) {
    for (let i = 0; i < n; i++) {
        const x = r() * w, y = r() * h, rad = (0.2 + r()) * maxR;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
}

function noise(ctx, w, h, r, amount) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const n = (r() - 0.5) * amount;
        d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.8;
    }
    ctx.putImageData(img, 0, 0);
}

function wallTexture(device) {
    // texture spans 2m wide x 3m tall
    return canvasTex(device, 256, 384, (ctx, w, h) => {
        const r = rand(7);
        ctx.fillStyle = '#c2b56a';
        ctx.fillRect(0, 0, w, h);
        // faint wallpaper stripes / chevrons
        for (let x = 0; x < w; x += 16) {
            ctx.fillStyle = 'rgba(120,105,40,0.10)';
            ctx.fillRect(x, 0, 2, h);
            for (let y = 0; y < h; y += 16) {
                ctx.fillStyle = 'rgba(150,135,60,0.08)';
                ctx.fillRect(x + 6, y + 6, 4, 4);
            }
        }
        stains(ctx, w, h, r, 14, 'rgba(90,75,25,0.18)', 60);
        // water streaks from the ceiling
        for (let i = 0; i < 6; i++) {
            const x = r() * w, len = 40 + r() * 140;
            const g = ctx.createLinearGradient(0, 0, 0, len);
            g.addColorStop(0, 'rgba(80,65,20,0.35)');
            g.addColorStop(1, 'rgba(80,65,20,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x, 0, 3 + r() * 8, len);
        }
        // baseboard
        ctx.fillStyle = '#e8e2c8';
        ctx.fillRect(0, h - 14, w, 14);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, h - 15, w, 1);
        noise(ctx, w, h, r, 14);
    }, 'wall');
}

function carpetTexture(device) {
    return canvasTex(device, 256, 256, (ctx, w, h) => {
        const r = rand(11);
        ctx.fillStyle = '#6f6a52';
        ctx.fillRect(0, 0, w, h);
        noise(ctx, w, h, r, 40);
        stains(ctx, w, h, r, 10, 'rgba(40,35,20,0.25)', 50);
        stains(ctx, w, h, r, 6, 'rgba(150,140,100,0.15)', 40);
    }, 'carpet');
}

function ceilingTexture(device) {
    // 2m x 2m, 0.6m-ish tiles
    return canvasTex(device, 256, 256, (ctx, w, h) => {
        const r = rand(23);
        ctx.fillStyle = '#d6d0b0';
        ctx.fillRect(0, 0, w, h);
        noise(ctx, w, h, r, 22);
        stains(ctx, w, h, r, 5, 'rgba(120,100,40,0.3)', 35);
        ctx.fillStyle = '#9d987c';
        const step = w / 3;
        for (let i = 0; i <= 3; i++) {
            ctx.fillRect(Math.round(i * step) - 2, 0, 4, h);
            ctx.fillRect(0, Math.round(i * step) - 2, w, 4);
        }
    }, 'ceiling');
}

// ---------- geometry helpers ----------
class MeshBuilder {
    constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
    quad(a, b, c, d, n, uva, uvb, uvc, uvd, flip = false) {
        const base = this.p.length / 3;
        this.p.push(...a, ...b, ...c, ...d);
        for (let k = 0; k < 4; k++) this.n.push(...n);
        this.uv.push(...uva, ...uvb, ...uvc, ...uvd);
        if (flip) this.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
        else this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    build(device) {
        const mesh = new pc.Mesh(device);
        mesh.setPositions(this.p);
        mesh.setNormals(this.n);
        mesh.setUvs(0, this.uv);
        mesh.setIndices(this.i);
        mesh.update();
        return mesh;
    }
}

function addMeshEntity(app, name, mesh, material) {
    const e = new pc.Entity(name);
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
    app.root.addChild(e);
    return e;
}

export class Level extends Grid {
    constructor(app) {
        super();
        this.app = app;
        this.lights = [];
        const cc = (k) => { const [x, z] = this.marks[k]; return new pc.Vec3((x + 0.5) * CELL, 0, (z + 0.5) * CELL); };
        this.start = cc('S');
        this.creatureStart = cc('C');
        this.exit = cc('E');
        this.exitCell = this.marks.E;
        this.build();
    }

    build() {
        const app = this.app;
        const device = app.graphicsDevice;

        const wallMat = new pc.StandardMaterial();
        wallMat.diffuseMap = wallTexture(device);
        wallMat.useMetalness = true;
        wallMat.metalness = 0;
        wallMat.gloss = 0.25;
        wallMat.update();

        const floorMat = new pc.StandardMaterial();
        floorMat.diffuseMap = carpetTexture(device);
        floorMat.useMetalness = true;
        floorMat.metalness = 0;
        floorMat.gloss = 0.15;
        floorMat.update();

        const ceilMat = new pc.StandardMaterial();
        ceilMat.diffuseMap = ceilingTexture(device);
        ceilMat.useMetalness = true;
        ceilMat.metalness = 0;
        ceilMat.gloss = 0.1;
        ceilMat.update();

        const panelMat = new pc.StandardMaterial();
        panelMat.diffuse = new pc.Color(1, 1, 1);
        panelMat.emissive = new pc.Color(1, 0.97, 0.88);
        panelMat.emissiveIntensity = 3;
        panelMat.update();

        const exitMat = new pc.StandardMaterial();
        exitMat.diffuse = new pc.Color(0, 0, 0);
        exitMat.emissive = new pc.Color(0.1, 1, 0.35);
        exitMat.emissiveIntensity = 4;
        exitMat.update();

        const walls = new MeshBuilder();
        const floor = new MeshBuilder();
        const ceil = new MeshBuilder();
        const panels = new MeshBuilder();
        const H = WALL_H;

        for (let z = 0; z < this.h; z++) {
            for (let x = 0; x < this.w; x++) {
                if (this.isWall(x, z)) continue;
                const x0 = x * CELL, x1 = x0 + CELL, z0 = z * CELL, z1 = z0 + CELL;
                floor.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0], [0, 1, 0],
                    [0, 0], [1, 0], [1, 1], [0, 1]);
                ceil.quad([x0, H, z0], [x1, H, z0], [x1, H, z1], [x0, H, z1], [0, -1, 0],
                    [0, 0], [1, 0], [1, 1], [0, 1]);
                // wall faces toward this open cell
                if (this.isWall(x, z - 1)) walls.quad([x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1], true);
                if (this.isWall(x, z + 1)) walls.quad([x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1], [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1], true);
                if (this.isWall(x - 1, z)) walls.quad([x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0], [1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1], true);
                if (this.isWall(x + 1, z)) walls.quad([x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1], [-1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1], true);

                // fluorescent panels on a checker pattern
                if ((x + z) % 2 === 0) {
                    const cx = x0 + CELL / 2, cz = z0 + CELL / 2, hw = 0.6, hd = 0.16, y = H - 0.01;
                    panels.quad([cx - hw, y, cz - hd], [cx + hw, y, cz - hd], [cx + hw, y, cz + hd], [cx - hw, y, cz + hd], [0, -1, 0],
                        [0, 0], [1, 0], [1, 1], [0, 1]);
                    if ((x + z) % 4 === 0) this.addLight(cx, H - 0.25, cz);
                }
            }
        }
        addMeshEntity(app, 'walls', walls.build(device), wallMat);
        addMeshEntity(app, 'floor', floor.build(device), floorMat);
        addMeshEntity(app, 'ceiling', ceil.build(device), ceilMat);
        addMeshEntity(app, 'panels', panels.build(device), panelMat);

        // square columns against the walls (collision lives in Grid.pillars)
        const pillarMat = wallMat.clone();
        pillarMat.diffuseMapTiling = new pc.Vec2(0.35, 1);
        pillarMat.update();
        for (const [x0, z0, x1, z1] of this.pillars) {
            const p = new pc.Entity('pillar');
            p.addComponent('render', { type: 'box', material: pillarMat, castShadows: false });
            p.setLocalScale(x1 - x0, WALL_H, z1 - z0);
            p.setPosition((x0 + x1) / 2, WALL_H / 2, (z0 + z1) / 2);
            app.root.addChild(p);
        }

        // exit sign + door glow
        const [ex, ez] = this.exitCell;
        const sign = new pc.Entity('exit-sign');
        sign.addComponent('render', { type: 'box', material: exitMat, castShadows: false });
        sign.setLocalScale(0.6, 0.22, 0.06);
        sign.setPosition((ex + 0.5) * CELL, 2.5, ez * CELL + 0.05);
        app.root.addChild(sign);
        const exitLight = new pc.Entity('exit-light');
        exitLight.addComponent('light', { type: 'omni', color: new pc.Color(0.2, 1, 0.4), intensity: 1.5, range: 6, castShadows: false });
        exitLight.setPosition((ex + 0.5) * CELL, 2.2, ez * CELL + 0.6);
        app.root.addChild(exitLight);
    }

    addLight(x, y, z) {
        const e = new pc.Entity('light');
        e.addComponent('light', {
            type: 'omni', color: new pc.Color(1, 0.95, 0.82), intensity: 1.0, range: 8,
            castShadows: false, falloffMode: pc.LIGHTFALLOFF_INVERSESQUARED,
            shadowResolution: 512, shadowBias: 0.02, normalOffsetBias: 0.04
        });
        e.setPosition(x, y, z);
        this.app.root.addChild(e);
        this.lights.push({ entity: e, base: 1.0, flicker: Math.random() < 0.12 });
    }

    // Only the few ceiling lights nearest the creature cast (omni cube) shadows: enough for the worm
    // mass to shade the floor and itself without paying for shadows everywhere.
    updateShadowLights(x, z, count = 2) {
        const ranked = this.lights
            .map(l => { const p = l.entity.getPosition(); return [Math.hypot(p.x - x, p.z - z), l]; })
            .sort((a, b) => a[0] - b[0]);
        ranked.forEach(([d, l], i) => {
            const want = i < count && d < 7;
            if (l.entity.light.castShadows !== want) l.entity.light.castShadows = want;
        });
    }

    updateLights(t) {
        for (const l of this.lights) {
            if (!l.flicker) continue;
            const f = Math.sin(t * 37 + l.base * 13) > 0.85 || Math.random() < 0.03 ? 0.15 : 1;
            l.entity.light.intensity = l.base * f;
        }
    }

}

export { CELL, WALL_H };
