import * as pc from 'playcanvas';

export class Player {
    constructor(app, camera, level) {
        this.app = app;
        this.camera = camera;
        this.level = level;
        this.keys = new Set();
        this.locked = false;
        this.pos = new pc.Vec3();
        this.reset();

        window.addEventListener('keydown', (e) => { this.keys.add(e.code); });
        window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousemove', (e) => {
            if (!this.locked) return;
            this.yaw -= e.movementX * 0.0022;
            this.pitch -= e.movementY * 0.0022;
            this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
        });
        document.addEventListener('pointerlockchange', () => {
            this.locked = document.pointerLockElement === app.graphicsDevice.canvas;
        });
    }

    reset() {
        const s = this.level.start;
        this.pos.set(s.x, 0, s.z);
        this.yaw = 0;          // looking toward -z
        this.pitch = 0;
        this.bob = 0;
        this.stamina = 1;
        this.roll = 0;
        this.vel = new pc.Vec3();
        this.shake = 0;
    }

    update(dt, t, enabled) {
        let fx = 0, fz = 0;
        if (enabled) {
            if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fz += 1;
            if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fz -= 1;
            if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) fx -= 1;
            if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) fx += 1;
        }
        const len = Math.hypot(fx, fz) || 1;
        fx /= len; fz /= len;
        const sprint = enabled && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) && this.stamina > 0.05 && fz > 0;
        const speed = sprint ? 5.2 : 3.0;
        if (sprint && (fx || fz)) this.stamina = Math.max(0, this.stamina - dt / 4);
        else this.stamina = Math.min(1, this.stamina + dt / 6);

        // forward is -z rotated by yaw
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        const wx = (-sy * fz + cy * fx) * speed;
        const wz = (-cy * fz - sy * fx) * speed;
        this.vel.x += (wx - this.vel.x) * Math.min(1, dt * 10);
        this.vel.z += (wz - this.vel.z) * Math.min(1, dt * 10);
        this.pos.x += this.vel.x * dt;
        this.pos.z += this.vel.z * dt;
        this.level.collideCircle(this.pos, 0.3);

        const moving = Math.hypot(this.vel.x, this.vel.z);
        this.bob += dt * moving * 2.4;
        const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, moving / 3);
        const bobX = Math.cos(this.bob) * 0.025 * Math.min(1, moving / 3);
        this.roll += ((-fx * 2.0) - this.roll) * Math.min(1, dt * 5);

        // handheld camcorder drift
        const hx = Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3) * 0.25;
        const hy = Math.sin(t * 0.7 + 1) * 0.5 + Math.sin(t * 1.9) * 0.2;
        this.shake = Math.max(0, this.shake - dt * 4);
        const sk = this.shake;

        this.camera.setPosition(this.pos.x + bobX * cy, 1.62 + bobY, this.pos.z - bobX * sy);
        this.camera.setEulerAngles(
            this.pitch * pc.math.RAD_TO_DEG + hy * 0.4 + (Math.random() - 0.5) * sk * 3,
            this.yaw * pc.math.RAD_TO_DEG + hx * 0.4 + (Math.random() - 0.5) * sk * 3,
            this.roll + Math.sin(t * 0.5) * 0.6
        );
        return moving;
    }
}
