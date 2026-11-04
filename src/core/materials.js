import * as pc from 'playcanvas';

// Shared materials and primitive helpers for the props (meatballs, eyes, boss parts).
export function createKit(app) {
    const mat = (c, gloss = 0.5, emissive = null) => {
        const m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(...c); m.gloss = gloss; m.useMetalness = true; m.metalness = 0;
        if (emissive) { m.emissive = new pc.Color(...emissive); m.emissiveIntensity = 1; }
        m.update();
        return m;
    };
    const sphere = (m, parent = app.root) => {
        const e = new pc.Entity();
        e.addComponent('render', { type: 'sphere', material: m, castShadows: true });
        parent.addChild(e);
        return e;
    };
    return {
        app, mat, sphere,
        eyeWhite: mat([0.95, 0.94, 0.9], 0.8),
        eyeBlack: mat([0.02, 0.02, 0.02], 0.9),
        meat: mat([0.36, 0.17, 0.09], 0.55),
        meatDark: mat([0.22, 0.09, 0.05], 0.35),
        sauce: mat([0.6, 0.07, 0.03], 0.75),
        glint: mat([1, 1, 1], 0.9, [0.6, 0.6, 0.6])
    };
}
