// Meatball eyeballs: a bumpy, sauce-glazed meatball with a dark pupil (and a wet glint) that
// follows whoever they are chasing — or rolls away in fright.

export function meatEye(kit, parent = kit.app.root) {
    const ball = kit.sphere(kit.meat, parent);
    for (let i = 0; i < 7; i++) {
        const b = kit.sphere(kit.meatDark, ball), a = i * 2.39996, el = Math.asin(1 - 2 * (i + 0.5) / 7);
        b.setLocalPosition(Math.cos(a) * Math.cos(el) * 0.44, Math.sin(el) * 0.44, Math.sin(a) * Math.cos(el) * 0.44);
        b.setLocalScale(0.24, 0.2, 0.24);
    }
    const glaze = kit.sphere(kit.sauce, ball); glaze.setLocalPosition(0, 0.2, 0); glaze.setLocalScale(0.8, 0.45, 0.8);
    return ball;
}

export function makeEyes(kit, scale) {
    return { eyes: [0, 1].map(() => ({ white: meatEye(kit), pupil: kit.sphere(kit.eyeBlack), glint: kit.sphere(kit.glint) })), scale };
}

export function placeEyes(E, head, fwd, right, look, scared) {
    const s = E.scale, t = performance.now() / 1000;
    E.eyes.forEach((e, i) => {
        const side = i ? 1 : -1;
        const jit = scared ? Math.sin(t * 40 + i) * 0.01 * s : 0;          // trembling with fear
        const c = [head[0] + fwd[0] * 0.13 * s + right[0] * side * 0.075 * s + jit, head[1] + 0.06 * s, head[2] + fwd[2] * 0.13 * s + right[2] * side * 0.075 * s];
        const r = (scared ? 0.09 : 0.075) * s;
        e.white.enabled = e.pupil.enabled = e.glint.enabled = true;
        e.white.setPosition(...c); e.white.setLocalScale(r * 2, r * 2, r * 2);
        const lx = look[0] - c[0], ly = look[1] - c[1], lz = look[2] - c[2], ll = Math.hypot(lx, ly, lz) || 1;
        const k = scared ? -0.55 : 0.9;      // scared: pupils roll away
        const pr = r * (scared ? 0.42 : 0.6);
        const px = c[0] + lx / ll * r * k, py = c[1] + ly / ll * r * 0.8, pz = c[2] + lz / ll * r * k;
        e.pupil.setPosition(px, py, pz); e.pupil.setLocalScale(pr, pr, pr);
        e.glint.setPosition(px + lx / ll * pr * 0.35, py + pr * 0.25, pz + lz / ll * pr * 0.35); e.glint.setLocalScale(pr * 0.3, pr * 0.3, pr * 0.3);
    });
}

export function hideEyes(E) { E.eyes.forEach(e => { e.white.enabled = false; e.pupil.enabled = false; if (e.glint) e.glint.enabled = false; }); }
