import * as pc from 'playcanvas';

// Physics (Ammo.js / Bullet, the PlayCanvas engine's physics backend). The hero is a dynamic capsule
// driven by PlayCanvas's third-person controller; the space's collision mesh is a static triangle
// collider. Monsters and noodles keep using the occupancy grid (they are not rigid bodies).
//
// The Ammo build is vendored in vendor/ammo (PlayCanvas's own build, zlib licence). Must be loaded
// BEFORE the Application is created: the rigidbody system picks Ammo up at startup.
export async function loadPhysics(base = 'vendor/ammo/') {
    if (typeof WebAssembly !== 'object') return false;
    try {
        pc.WasmModule.setConfig('Ammo', {
            glueUrl: base + 'ammo.wasm.js',
            wasmUrl: base + 'ammo.wasm.wasm',
            fallbackUrl: base + 'ammo.js'
        });
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Ammo load timed out')), 20000);
            pc.WasmModule.getInstance('Ammo', () => { clearTimeout(t); resolve(); });
        });
        return true;
    } catch (err) {
        console.warn('physics unavailable, falling back to grid movement', err);
        return false;
    }
}

// a static triangle-mesh collider from raw positions / indices (the space's collision mesh)
export function addStaticMesh(app, positions, indices, name = 'world-collider') {
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update();
    const node = new pc.GraphNode(name + '-node');
    const model = new pc.Model();
    model.graph = node;
    model.meshInstances = [new pc.MeshInstance(mesh, new pc.StandardMaterial(), node)];
    const e = new pc.Entity(name);
    e.addComponent('collision', { type: 'mesh', model });
    e.addComponent('rigidbody', { type: 'static', friction: 0.4, restitution: 0 });
    app.root.addChild(e);
    return e;
}
