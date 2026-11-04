// Hero test bench: the skinned hero alone in the procedural kitchen, with a scriptable orbit camera and
// frozen poses, for screenshots while working on the rig.   http://localhost:5173/dev/hero.html
//   bench.pose('eat', 0.7)   freeze an action at time t (seconds)      bench.play()  run in real time
//   bench.cam(yawDeg, pitchDeg, dist, lookY)                            bench.walk(speed)
import * as pc from 'playcanvas';
import { loadSpace } from '../src/world/space.js';
import { Hero, BITE_AT } from '../src/actors/hero/hero.js';
import { HeroModel } from '../src/actors/hero/heromodel.js';

const canvas = document.getElementById('app');
const app = new pc.Application(canvas, { graphicsDeviceOptions: { antialias: true } });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
app.scene.lighting.shadowsEnabled = true;
app.scene.clusteredLightingEnabled = true;
app.start();
const level = await loadSpace(app, 'kitchen');
// just a floor (the kitchen walls would block the orbit camera)
if (level.collisionEntity) level.collisionEntity.enabled = false;
const floor = new pc.Entity('floor');
const fm = new pc.StandardMaterial(); fm.diffuse = new pc.Color(0.42, 0.4, 0.36); fm.gloss = 0.2; fm.useMetalness = true; fm.update();
floor.addComponent('render', { type: 'plane', material: fm });
floor.setLocalScale(30, 1, 30); floor.setPosition(5, 0, 5);
app.root.addChild(floor);
const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(0.55, 0.6, 0.66), fov: 40, nearClip: 0.02, farClip: 60, toneMapping: pc.TONEMAP_ACES });
app.root.addChild(camera);

const hero = new Hero(app, level, level.start, { visual: false });
const body = new HeroModel(app, await HeroModel.load(app, '../assets/hero/hero.glb'), hero);
const S = { frozen: null, speed: 0, cam: [200, 8, 2.6, 1.1], camYaw: 0 };

window.bench = {
    app, hero, body, level,
    // eat: t is the fraction of the bite (0..1); strike: seconds
    pose(type, t, extra = {}) {
        const { fwd } = hero.frame();
        const dur = type === 'eat' ? (extra.kind === 'hand' ? 0.9 : 1.05) : 0.55;
        const target = [hero.x + fwd[0] * 0.8, level.groundAt(hero.x, hero.z) + 0.08, hero.z + fwd[2] * 0.8];
        hero.action = { type, kind: extra.kind || 'fork', t: type === 'eat' ? t * dur : t, dur, target: S.target || target, fired: {} };
        S.target = S.target || target;
        S.frozen = { type, t, extra };
    },
    play() { S.frozen = null; hero.action = null; },
    act(type) { S.frozen = null; hero.action = null; type === 'strike' ? hero.strike() : hero.eat([hero.x + Math.sin(hero.yaw) * 0.9, 0.05, hero.z + Math.cos(hero.yaw) * 0.9]); },
    cam(yaw, pitch, dist, y) { S.cam = [yaw, pitch, dist, y ?? S.cam[3]]; },
    walk(speed) { S.speed = speed; },
    power(on) { hero.power = on ? 1 : 0; body.power = on ? 1 : 0; },
    ready: true
};

app.on('update', (dt) => {
    if (S.frozen) {
        const f = S.frozen;
        window.bench.pose(f.type, f.t, f.extra);
    }
    const z = S.speed;
    hero.update(S.frozen ? 0 : dt, { x: 0, z: z > 0 ? Math.min(1, z / (z > 2.9 ? 4.6 : 2.9)) : 0, sprint: z > 2.9, camYaw: S.camYaw });
    if (S.speed) { hero.x = level.start.x; hero.z = level.start.z; }          // a treadmill
    body.update(dt);
    const [yaw, pitch, dist, ly] = S.cam, r = pc.math.DEG_TO_RAD;
    const tx = hero.x, tz = hero.z, ty = (hero.gy || 0) + ly;
    const a = (yaw * r) + hero.yaw;
    camera.setPosition(tx + Math.sin(a) * Math.cos(pitch * r) * dist, ty + Math.sin(pitch * r) * dist, tz + Math.cos(a) * Math.cos(pitch * r) * dist);
    camera.lookAt(tx, ty, tz);
    document.getElementById('info').textContent = S.frozen ? `${S.frozen.type} t=${S.frozen.t}` : hero.action ? `${hero.action.type} ${hero.action.t.toFixed(2)}` : 'idle';
});
