import * as pc from 'playcanvas';

// Tomato sauce painted into the hero's face texture as he eats: the lower lip first, then the mouth
// corners, the chin, the upper lip, a streak down one cheek. The spots are found in the bind pose
// (head-mesh vertices near the lip / corner bones) and painted at those vertices' UVs, so the
// smears sit exactly on the skin and move with every expression.
const SPOTS = [
    // [bone, offset in the mesh frame (m), radius (m), texels per blob, order]
    ['Bip01 MBottomLip', [0, -0.006, 0.004], 0.022, 9],
    ['Bip01 LMouthCorner', [0, -0.006, 0], 0.016, 8],
    ['Bip01 RMouthCorner', [0, -0.004, 0], 0.014, 7],
    ['Bip01 MBottomLip', [0.006, -0.032, 0], 0.026, 10],     // chin
    ['Bip01 MUpperLip', [-0.004, 0.006, 0.004], 0.016, 7],
    ['Bip01 LMouthCorner', [0.012, -0.03, -0.004], 0.018, 8],  // a drip line from the corner
    ['Bip01 RCheek', [-0.006, -0.012, 0.006], 0.014, 7],
];

export class SaucePaint {
    constructor(model) {
        this.level = -1;
        this.ok = false;
        try { this.init(model); } catch (err) { console.warn('sauce paint unavailable', err); }
    }

    init(model) {
        let mi = null;
        for (const r of model.findComponents('render')) for (const m of r.meshInstances) if (m.material && m.material.name.includes('head') && m.material.diffuseMap) mi = m;
        if (!mi || !mi.mesh.skin) return;
        const mesh = mi.mesh, skin = mesh.skin;
        const P = [], U = [];
        mesh.getPositions(P); mesh.getUvs(0, U);
        const bindPos = (name) => {
            const i = skin.boneNames.indexOf(name);
            if (i < 0) return null;
            const m = skin.inverseBindPose[i].clone().invert();
            return m.getTranslation();
        };
        // the blobs: for each spot, the UVs of the skin around it
        this.blobs = [];
        for (const [bone, off, rad, px] of SPOTS) {
            const c = bindPos(bone);
            if (!c) { this.blobs.push([]); continue; }
            c.x += off[0]; c.y += off[1]; c.z += off[2];
            const list = [];
            for (let v = 0; v < P.length / 3; v++) {
                const d = Math.hypot(P[v * 3] - c.x, P[v * 3 + 1] - c.y, P[v * 3 + 2] - c.z);
                if (d < rad) list.push([U[v * 2], U[v * 2 + 1], 1 - d / rad, px]);
            }
            this.blobs.push(list);
        }
        const tex = mi.material.diffuseMap, src = tex.getSource();
        const W = tex.width, H = tex.height;
        this.canvas = document.createElement('canvas');
        this.canvas.width = W; this.canvas.height = H;
        this.ctx = this.canvas.getContext('2d');
        this.base = src;
        this.material = mi.material;
        this.original = tex;
        this.tex = new pc.Texture(tex.device, { name: 'face-sauce', width: W, height: H, format: pc.PIXELFORMAT_SRGBA8, mipmaps: true, anisotropy: 4 });
        this.flipV = false;
        this.ok = this.blobs.some(b => b.length);
    }

    // mess 0..1; repainted in steps so the texture upload is rare
    set(mess) {
        if (!this.ok) return;
        const lvl = Math.round(mess * 10);
        if (lvl === this.level) return;
        this.level = lvl;
        if (lvl === 0) { this.material.diffuseMap = this.original; this.material.update(); return; }
        const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(this.base, 0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        const amount = lvl / 10;
        this.blobs.forEach((list, i) => {
            const on = Math.max(0, Math.min(1, (amount * SPOTS.length - i * 0.8) / 1.5));
            if (on <= 0) return;
            for (const [u, v, w, px] of list) {
                const x = u * W, y = (this.flipV ? 1 - v : v) * H, r = px * 2.4 * (0.6 + 0.6 * w) * (0.6 + 0.4 * on);
                const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                const a = 0.3 * on * (0.4 + 0.6 * w);
                g.addColorStop(0, `rgba(150,18,6,${a})`);
                g.addColorStop(1, 'rgba(150,18,6,0)');
                ctx.fillStyle = g;
                ctx.fillRect(x - r, y - r, r * 2, r * 2);
            }
        });
        this.tex.setSource(this.canvas);
        if (this.material.diffuseMap !== this.tex) { this.material.diffuseMap = this.tex; this.material.update(); }
    }
}
