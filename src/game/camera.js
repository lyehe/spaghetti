import * as pc from 'playcanvas';
import { Lens } from '../core/lens.js';

// Third-person camera over the right shoulder, kept out of walls and splat furniture, with the
// post-processing stack, an "eating cam" that swings round to his face while he digs in, and
// adaptive resolution (?stats shows fps / render scale / sim time).
export class CameraRig {
    constructor(app, level, params, clearColor) {
        this.app = app;
        this.level = level;
        this.params = params;
        this.cam = { yaw: 0, pitch: -0.22, dist: 3.2 };    // driven by the mouse
        this.eatCam = 0;
        const camera = new pc.Entity('camera');
        camera.addComponent('camera', { clearColor: new pc.Color(...clearColor), fov: 62, nearClip: 0.05, farClip: 120 });
        app.root.addChild(camera);
        this.entity = camera;

        const frame = new pc.CameraFrame(app, camera.camera);
        if (params.has('nopost')) { frame.enabled = false; camera.camera.toneMapping = pc.TONEMAP_ACES; }
        frame.rendering.samples = params.has('hq') ? 4 : 1;
        frame.rendering.toneMapping = pc.TONEMAP_NEUTRAL;
        frame.bloom.intensity = 0.015;
        frame.bloom.blurLevel = 10;
        frame.ssao.type = params.has('hq') ? pc.SSAOTYPE_LIGHTING : pc.SSAOTYPE_NONE;
        frame.ssao.intensity = 0.45;
        frame.ssao.radius = 12;
        frame.grading.enabled = true;
        frame.grading.saturation = 1.05;
        frame.grading.contrast = 1.04;
        frame.vignette.intensity = 0.3;
        frame.vignette.inner = 0.5;
        frame.vignette.outer = 1.3;
        frame.update();
        this.frame = frame;
        this.lens = params.has('nopost') || params.has('nolens') ? null : new Lens(app, camera.camera, { barrel: 0.02, blur: 0.35, smear: 0 });

        this.perf = { t: 0, n: 0, fps: 0 };
        this.statsEl = params.has('stats') ? Object.assign(document.body.appendChild(document.createElement('div')), { style: 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 1px 2px #000;pointer-events:none' }) : null;
    }

    look(dx, dy) {
        this.cam.yaw -= dx * 0.0025;
        this.cam.pitch = Math.max(-0.8, Math.min(0.4, this.cam.pitch - dy * 0.0022));
    }

    // external: the PlayCanvas third-person controller already placed the camera this frame; then only
    // the eating cam (blended over it), shake, fov and lens are layered on top
    update(dt, rawDt, G, eatHeld, external = false) {
        const { hero, level } = G, cam = this.cam, camera = this.entity;
        // eating cam: while he digs in, swing round to a three-quarter front view of his face
        const wantEat = hero.eating && (eatHeld || hero.action.t > 0.15) ? 1 : 0;
        this.eatCam += (wantEat - this.eatCam) * Math.min(1, dt * (wantEat ? 1.8 : 3));
        const eatCam = this.eatCam;
        let vy = cam.yaw, vp = cam.pitch, vd = cam.dist;
        if (eatCam > 0.001) {
            let dy = hero.yaw + Math.PI - 0.7 - cam.yaw;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            const e = eatCam * eatCam * (3 - 2 * eatCam);
            vy = cam.yaw + dy * e; vp = cam.pitch + (-0.1 - cam.pitch) * e; vd = cam.dist + (1.9 - cam.dist) * e;
        }
        const head = hero.headPos;
        const k = 1 + 0.18 * (G.body ? G.body.power : hero.power);
        const sh = 0.42 * (1 - eatCam * 0.8);
        const tgt = { x: head[0] - Math.cos(vy) * sh, y: head[1] + 0.1 - eatCam * 0.12, z: head[2] + Math.sin(vy) * sh };   // over the right shoulder
        const back = { x: -Math.sin(vy) * Math.cos(vp), y: -Math.sin(vp), z: -Math.cos(vy) * Math.cos(vp) };
        const want = vd * k;
        // a fat ray (centre + 4 offsets) so the lens never pokes into walls, plants or furniture splats
        let free = level.raycast(tgt, back, want + 0.3);
        const side = { x: Math.cos(vy), z: -Math.sin(vy) };
        for (const [sx, sy] of [[0.28, 0], [-0.28, 0], [0, 0.22], [0, -0.22]]) {
            const o = { x: tgt.x + side.x * sx, y: tgt.y + sy, z: tgt.z + side.z * sx };
            free = Math.min(free, level.raycast(o, back, want + 0.3));
        }
        let d = Math.max(0.3, Math.min(want, free - 0.3));
        const clear = (x, y, z) => {
            const C = level.CELL, r = 0.4, cx = Math.floor(x / C), cz = Math.floor(z / C), R = Math.ceil(r / C);
            for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
                if (!level.isWall(cx + dx, cz + dz, y)) continue;
                const qx = Math.max((cx + dx) * C, Math.min(x, (cx + dx + 1) * C)), qz = Math.max((cz + dz) * C, Math.min(z, (cz + dz + 1) * C));
                if (Math.hypot(qx - x, qz - z) < r) return false;
            }
            return true;
        };
        while (d > 0.3 && !clear(tgt.x + back.x * d, tgt.y + back.y * d, tgt.z + back.z * d)) d -= 0.08;
        G.shake = Math.max(0, G.shake - dt * 2.5);
        const sx = (Math.random() - 0.5) * G.shake * 0.1, sy = (Math.random() - 0.5) * G.shake * 0.1;
        const cx = tgt.x + back.x * d, cz = tgt.z + back.z * d;
        let P = new pc.Vec3(cx, Math.max(level.groundAt(cx, cz) + 0.25, tgt.y + back.y * d), cz);
        let L = new pc.Vec3(tgt.x - back.x * 4, tgt.y - back.y * 4, tgt.z - back.z * 4);
        if (external) {
            const e = eatCam * eatCam * (3 - 2 * eatCam);
            const P0 = camera.getPosition().clone(), L0 = P0.clone().add(camera.forward.clone().mulScalar(4));
            P = P0.lerp(P0, P, e); L = L0.lerp(L0, L, e);
        }
        camera.setPosition(P.x + sx, P.y + sy, P.z);
        camera.lookAt(L);
        camera.camera.fov += ((G.power > 0 ? 68 : 62) - camera.camera.fov) * Math.min(1, dt * 3);
        if (this.lens) this.lens.update(dt, cam.yaw + Math.PI, cam.pitch);      // blur follows the mouse, not the automatic eating cam
        this.adapt(rawDt, G);
    }

    // adaptive resolution: keep ~60 fps by trading render scale (0.6 .. 1), checked twice a second
    adapt(rawDt, G) {
        const perf = this.perf, frame = this.frame;
        perf.t += rawDt; perf.n++;
        if (perf.t < 0.5) return;
        const fps = perf.n / perf.t;
        perf.fps = fps; perf.t = 0; perf.n = 0;
        if (!this.params.has('hq') && frame.enabled) {
            const sc = frame.rendering.renderTargetScale;
            const next = fps < 48 ? Math.max(0.6, sc - 0.1) : fps > 58 ? Math.min(1, sc + 0.05) : sc;
            if (next !== sc) { frame.rendering.renderTargetScale = next; frame.update(); }
        }
        if (this.statsEl) this.statsEl.textContent = `${fps.toFixed(0)} fps · scale ${frame.rendering.renderTargetScale.toFixed(2)} · sim ${G.host.stepMs.toFixed(1)} ms`;
    }
}
