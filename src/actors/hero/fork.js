import * as pc from 'playcanvas';

// The Great Fork: a dinner fork scaled up 5x (1.05 m), as one smooth lofted steel mesh: a wide flat
// handle end, a narrow neck, a head that flares and curves up, four tapered tines.
// Local frame: +Y runs from the handle toward the tines, +X across the tines, +Z the concave face.
// The origin is the GRIP point (where the palm holds the handle).

export const FORK = { length: 1.05, grip: 0.3 };
FORK.reach = FORK.length - FORK.grip;              // palm -> tine tips
FORK.wad = FORK.reach - 0.07;                       // palm -> where twirled noodles sit on the tines

// cross-section stations: u = distance from the handle end, wx / wz = half width / thickness
const BODY = [
    [0.000, 0.006, 0.004], [0.006, 0.018, 0.008], [0.018, 0.026, 0.0105], [0.04, 0.03, 0.0115], [0.12, 0.03, 0.011],
    [0.3, 0.024, 0.0105], [0.5, 0.018, 0.0095], [0.6, 0.0135, 0.0088], [0.64, 0.0125, 0.0082], [0.7, 0.024, 0.0068],
    [0.76, 0.046, 0.0058], [0.8, 0.062, 0.0055], [0.83, 0.07, 0.0055], [0.855, 0.071, 0.0052]
];
const TINE_X = [-0.0533, -0.0178, 0.0178, 0.0533], TINE_W = 0.0105, TINE_FROM = 0.835;

// the fork's gentle curve: the handle bows a little, the head bends up toward +Z
function bend(u) {
    return u < 0.62 ? -0.018 * Math.sin(Math.PI * u / 0.62) : 0.32 * (u - 0.62) * (u - 0.62);
}

function loft(stations, cx, sides, expo, P, N, I) {
    const base = P.length / 3;
    for (const [u, wx, wz] of stations) {
        const cz = bend(u), y = u - FORK.grip;
        for (let s = 0; s < sides; s++) {
            const a = s / sides * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
            // superellipse: flatter sides on the handle like a stamped fork
            const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / expo) * wx, z = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / expo) * wz;
            P.push(cx + x, y, cz + z);
        }
    }
    const rings = stations.length;
    for (let r = 0; r < rings - 1; r++) for (let s = 0; s < sides; s++) {
        const a = base + r * sides + s, b = base + r * sides + (s + 1) % sides, c = a + sides, d = b + sides;
        I.push(a, c, b, b, c, d);
    }
    // caps
    const capS = P.length / 3, capE = capS + 1;
    const f = stations[0], l = stations[rings - 1];
    P.push(cx, f[0] - FORK.grip - 0.001, bend(f[0]), cx, l[0] - FORK.grip + 0.001, bend(l[0]));
    for (let s = 0; s < sides; s++) {
        const a = base + s, b = base + (s + 1) % sides;
        I.push(capS, a, b);
        const c = base + (rings - 1) * sides + s, d = base + (rings - 1) * sides + (s + 1) % sides;
        I.push(capE, d, c);
    }
}

export function buildForkMesh(device) {
    const P = [], I = [];
    loft(BODY, 0, 24, 2.8, P, null, I);
    for (const tx of TINE_X) {
        const st = [];
        const n = 9, L = FORK.length - TINE_FROM;
        for (let i = 0; i <= n; i++) {
            const t = i / n, u = TINE_FROM + t * L;
            // straight, then a short taper to a rounded point
            const taper = t < 0.72 ? 1 : Math.max(0.12, 1 - Math.pow((t - 0.72) / 0.28, 1.6) * 0.88);
            st.push([u, TINE_W * taper * (tx * tx > 0.002 ? 0.95 : 1), 0.0052 * (0.7 + 0.3 * taper)]);
        }
        // outer tines splay a touch
        loft(st, tx * 1.0, 10, 2.2, P, null, I);
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(P);
    mesh.setNormals(pc.calculateNormals(P, I));
    mesh.setIndices(I);
    mesh.update();
    return mesh;
}

export function forkMaterial(envLit) {
    const m = new pc.StandardMaterial();
    m.name = 'fork-steel';
    m.diffuse = new pc.Color(0.82, 0.83, 0.86);
    m.useMetalness = true;
    m.metalness = envLit ? 0.92 : 0.45;           // fully metallic is black without something to reflect
    m.gloss = 0.86;
    m.update();
    return m;
}

// orientation from the handle direction (fork +Y) and a side hint (fork +X, made orthogonal), then a roll
export function forkRotation(dir, side, rollDeg = 0, out = new pc.Quat()) {
    const y = new pc.Vec3(dir[0], dir[1], dir[2]).normalize();
    const x = new pc.Vec3(side[0], side[1], side[2]);
    x.sub(y.clone().mulScalar(x.dot(y)));
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0).sub(y.clone().mulScalar(y.x));
    x.normalize();
    const z = new pc.Vec3().cross(x, y);
    const m = new pc.Mat4();
    const d = m.data;
    d[0] = x.x; d[1] = x.y; d[2] = x.z; d[4] = y.x; d[5] = y.y; d[6] = y.z; d[8] = z.x; d[9] = z.y; d[10] = z.z;
    out.setFromMat4(m);
    if (rollDeg) out.mul(new pc.Quat().setFromAxisAngle(pc.Vec3.UP, rollDeg));
    return out;
}
