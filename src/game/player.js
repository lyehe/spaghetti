import * as pc from 'playcanvas';
import { ThirdPersonController } from 'playcanvas/scripts/esm/third-person-controller.mjs';

// The player's body in the physics world: a dynamic capsule driven by PlayCanvas's ThirdPersonController
// script (keyboard + mouse with pointer lock, gamepad sticks, touch dual joysticks; orbit camera with
// wall avoidance). The hero rig and skinned body follow the capsule; the game adds on top:
//   - action moves (the lunge into a stab, shuffling up to food, standing still to eat, knock-backs)
//   - the playable area: the capsule is kept on the occupancy grid the monsters can reach
const RADIUS = 0.3, HEIGHT = 1.75;
const WALK = 2.9, RUN = 4.6;
// the controller adds `speedGround * dt` of velocity per frame and damps it by 0.99 per ms;
// at 60 fps that settles at speedGround * 0.0913 m/s
const SPEED_K = 0.0913;

export class Player {
    // yaw: the camera heading to start with (degrees, PlayCanvas convention: 0 looks down -z)
    constructor(app, level, camera, start, yaw = 0) {
        this.startYaw = yaw;
        this.app = app;
        this.level = level;
        const e = new pc.Entity('player');
        e.setPosition(start.x, level.groundAt(start.x, start.z) + HEIGHT / 2 + 0.05, start.z);
        e.addComponent('collision', { type: 'capsule', radius: RADIUS, height: HEIGHT });
        e.addComponent('rigidbody', {
            type: 'dynamic', mass: 80, linearDamping: 0, angularDamping: 0,
            linearFactor: pc.Vec3.ONE, angularFactor: pc.Vec3.ZERO, friction: 0, restitution: 0
        });
        e.addComponent('script');
        this.ctl = e.script.create(ThirdPersonController, {
            properties: {
                camera, speedGround: WALK / SPEED_K, speedAir: 4, sprintMult: RUN / WALK, jumpForce: 0,
                lookSens: 0.12, initialPitch: 14, pitchMin: -25, pitchMax: 60,
                cameraDistance: 3.2, cameraDistanceMin: 1.6, cameraDistanceMax: 7, cameraHeight: 0.75,
                cameraMinHeightAboveCharacter: -0.3, cameraCollisionPadding: 0.3
            }
        });
        app.root.addChild(e);
        this.entity = e;
        this.rb = e.rigidbody;
        this.joysticks();
    }

    get yaw() { return this.ctl._yaw * pc.math.DEG_TO_RAD + Math.PI; }      // as the hero rig measures it
    get pitch() { return -this.ctl._pitch * pc.math.DEG_TO_RAD; }          // as the camera rig measures it

    set active(on) {
        if (this.ctl.enabled === on) return;
        this.ctl.enabled = on;
        if (!on) this.rb.linearVelocity = pc.Vec3.ZERO;
    }

    push(vx, vz) { const v = this.rb.linearVelocity; this.rb.linearVelocity = new pc.Vec3(vx, v.y, vz); }

    // after physics: steer, clamp to the playable grid, and report the body to the hero rig
    update(hero, power) {
        if (this.startYaw !== null && this.ctl._ready) { this.ctl._yaw = this.startYaw; this.startYaw = null; }
        this.ctl.speedGround = WALK / SPEED_K * (hero.action ? 0.5 : 1) * (1 + 0.15 * power);
        if (hero.wantVel) this.push(hero.wantVel[0], hero.wantVel[1]);
        const p = this.entity.getPosition(), v = this.rb.linearVelocity;
        const q = { x: p.x, z: p.z };
        this.level.collideCircle(q, RADIUS * 0.85);
        const ground = this.level.groundAt(q.x, q.z);
        if (Math.hypot(q.x - p.x, q.z - p.z) > 0.01 || p.y < ground - 1) {
            this.rb.teleport(q.x, Math.max(p.y, ground + HEIGHT / 2 + 0.02), q.z);
            this.rb.linearVelocity = new pc.Vec3(0, Math.max(0, v.y), 0);
        }
        return { x: q.x, z: q.z, vx: v.x, vz: v.z };
    }

    teleport(x, z) { this.rb.teleport(x, this.level.groundAt(x, z) + HEIGHT / 2 + 0.05, z); this.rb.linearVelocity = pc.Vec3.ZERO; }

    // on-screen joysticks for the controller's touch input (it reports where they are)
    joysticks() {
        for (const side of ['left', 'right']) {
            const mk = (size, bg) => Object.assign(document.body.appendChild(document.createElement('div')), {
                className: 'joystick', style: `display:none;position:fixed;width:${size}px;height:${size}px;border-radius:50%;background:${bg};pointer-events:none`
            });
            const base = mk(100, 'rgba(40,30,20,0.45)'), stick = mk(56, 'rgba(255,240,220,0.55)');
            this.app.on(`joystick:${side}`, (bx, by, sx, sy) => {
                const show = bx >= 0 && by >= 0 && sx >= 0 && sy >= 0;
                base.style.display = stick.style.display = show ? 'block' : 'none';
                if (!show) return;
                base.style.left = `${bx - 50}px`; base.style.top = `${by - 50}px`;
                stick.style.left = `${sx - 28}px`; stick.style.top = `${sy - 28}px`;
            });
        }
    }
}
