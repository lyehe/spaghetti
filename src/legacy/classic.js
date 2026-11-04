import * as pc from 'playcanvas';
import { Level } from './level.js';
import { Creature } from '../actors/monsters/creature.js';
import { Worms } from './worms.js';
import { Player } from './player.js';
import { Gun } from './gun.js';
import { Audio } from '../core/audio.js';
import { CELL } from '../world/map.js';
import { Lens } from '../core/lens.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const WORM_COUNT =Math.max(100, Math.min(3000, parseInt(params.get('worms') || '900', 10)));

const canvas = document.getElementById('app');
const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    keyboard: new pc.Keyboard(window),
    graphicsDeviceOptions: { antialias: false, alpha: false }
});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());

// ---------- scene ----------
const scene = app.scene;
scene.ambientLight = new pc.Color(0.12, 0.115, 0.085);
scene.clusteredLightingEnabled = true;
// worm shadows: a couple of nearby omni lights cast into the clustered shadow atlas (off with ?lowq)
const SHADOWS = !params.has('lowq');
scene.lighting.shadowsEnabled = SHADOWS;
scene.lighting.shadowAtlasResolution = 2048;
scene.lighting.shadowType = pc.SHADOW_PCF3_16F;   // 32F rendered fully shadowed on software GL
scene.lighting.cookiesEnabled = false;
scene.lighting.maxLightsPerCell = 16;
scene.lighting.cells = new pc.Vec3(16, 2, 12);
scene.fog.type = pc.FOG_EXP2;
scene.fog.color = new pc.Color(0.16, 0.15, 0.1);
scene.fog.density = 0.045;

const level = new Level(app);

const camera = new pc.Entity('camera');
camera.addComponent('camera', {
    clearColor: new pc.Color(0.05, 0.05, 0.04),
    fov: 84,                 // wide body-cam lens; the barrel warp zooms the center back in
    nearClip: 0.02,
    farClip: 80
});
app.root.addChild(camera);

// post: camcorder look
const frame = new pc.CameraFrame(app, camera.camera);
if (params.has('nopost')) { frame.enabled = false; camera.camera.toneMapping = pc.TONEMAP_ACES; }
frame.rendering.samples = 4;
frame.rendering.toneMapping = pc.TONEMAP_ACES;
frame.rendering.sharpness = 0.3;
frame.bloom.intensity = 0.015;
frame.bloom.blurLevel = 10;
frame.ssao.type = pc.SSAOTYPE_LIGHTING;
frame.ssao.intensity = 0.6;
frame.ssao.radius = 20;
frame.grading.enabled = true;
frame.grading.saturation = 0.82;
frame.grading.contrast = 1.08;
frame.grading.brightness = 0.9;
frame.grading.tint = new pc.Color(1, 1, 0.92);
frame.vignette.intensity = 0.55;
frame.vignette.inner = 0.35;
frame.vignette.outer = 1.15;
frame.vignette.curvature = 0.6;
frame.fringing.intensity = 25;
frame.update();
const lens = params.has('nolens') || params.has('nopost') ? null : new Lens(app, camera.camera);

const creature = new Creature(level);
// physics runs in a worker; ?debug / ?inline keep it on the main thread for deterministic stepping
const worms = new Worms(app, creature, level, WORM_COUNT, { useWorker: params.has('worker') || !(DEBUG || params.has('inline')), bodyCollisions: !params.has('lowq') });
const player = new Player(app, camera, level);
const gun = new Gun(app, camera);
const audio = new Audio();

// ---------- HUD ----------
const $ = (id) => document.getElementById(id);
const hud = { overlay: $('overlay'), title: $('title'), sub: $('sub'), ammo: $('ammo'), stam: $('stamina'), tc: $('timecode'), msg: $('msg'), fps: $('fps') };

let mode = 'intro';       // intro | play | dead | win
let playTime = 0;
let msgT = 0;
function message(text, dur = 2) { hud.msg.textContent = text; msgT = dur; }

function showOverlay(title, sub) {
    hud.title.textContent = title;
    hud.sub.innerHTML = sub;
    hud.overlay.style.display = 'flex';
}

function restart() {
    player.reset();
    creature.reset();
    creature.computePose(0);
    worms.placeAll();
    gun.ammo = gun.maxAmmo; gun.reloadT = 0;
    playTime = 0;
}

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!player.locked) {
        if (mode !== 'play') {
            if (mode !== 'intro') restart();
            mode = 'play';
            hud.overlay.style.display = 'none';
        }
        audio.start();
        canvas.requestPointerLock();
        return;
    }
    if (mode === 'play') tryFire();
});
hud.overlay.addEventListener('mousedown', () => canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 })));
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && mode === 'play' && gun.reload()) audio.click();
});
document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && mode === 'play') {
        showOverlay('PAUSED', 'click to continue');
    } else if (document.pointerLockElement) {
        hud.overlay.style.display = 'none';
    }
});

const tmpO = new pc.Vec3(), tmpD = new pc.Vec3();
function tryFire() {
    if (!gun.canFire()) { if (gun.ammo === 0 || gun.reloadT > 0) audio.click(); return; }
    gun.fire();
    audio.shot();
    player.shake = 1;
    player.pitch += 0.02;

    tmpO.copy(camera.getPosition());
    tmpD.copy(camera.forward).normalize();
    const wallT = level.raycast(tmpO, tmpD);
    const ct = creature.raycast(tmpO, tmpD, wallT);
    const t = ct >= 0 ? ct : wallT;
    const hx = tmpO.x + tmpD.x * t, hy = tmpO.y + tmpD.y * t, hz = tmpO.z + tmpD.z * t;
    const released = worms.hit(hx, hy, hz, tmpD, ct >= 0 ? 0.21 : 0.6);   // ~13% of the body per torso shot
    if (released > 0 || ct >= 0) audio.squelch(released > 0 ? Math.min(1.5, 0.4 + released / 60) : 0.8);
    if (ct >= 0) creature.impact(tmpD.x, tmpD.z);
    lastShotDir.copy(tmpD);
}
const lastShotDir = new pc.Vec3();

// collapse once enough of the body has been shot away (the worm count is reported asynchronously)
function checkCollapse() {
    if (creature.walking && worms.boundFraction < 0.5) {
        creature.collapse();
        worms.collapseAll(lastShotDir);
        audio.collapse();
        message('IT FELL APART...', 2.5);
    }
}

// film grain + timecode canvas
const grain = $('grain');
const gctx = grain.getContext('2d');
const gimg = gctx.createImageData(grain.width, grain.height);
function drawGrain() {
    const d = gimg.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() * 255;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 26;
    }
    gctx.putImageData(gimg, 0, 0);
}

function timecode(s) {
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s) % 60, f = Math.floor((s % 1) * 30);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(sec)}:${p(f)}`;
}

let time = 0, fpsAcc = 0, fpsN = 0, shadowPickT = 0;
app.on('update', (dt) => {
    dt = Math.min(dt, 1 / 20);
    time += dt;
    const playing = mode === 'play' && (player.locked || DEBUG);
    const simDt = playing ? dt : 0;

    const moving = player.update(simDt, time, playing);
    gun.update(simDt, time, moving);
    level.updateLights(time);
    if (lens) lens.update(dt, player.yaw, player.pitch);
    if (SHADOWS && (shadowPickT -= dt) <= 0) { shadowPickT = 0.25; level.updateShadowLights(creature.x, creature.z); }

    if (simDt > 0) {
        const d = creature.update(simDt, player, worms.boundFraction, time);
        if (creature.reforming && worms.holding) { worms.startReform(); audio.collapse(); message('IT IS PULLING ITSELF BACK TOGETHER', 2.5); }
        worms.update(simDt);
        checkCollapse();

        if (creature.stepEvent) audio.step(Math.min(1, 4 / Math.max(1, d)) * worms.boundFraction);
        audio.setProximity(Math.max(0, 1 - d / 12));

        if (mode === 'play') {
            playTime += simDt;
            if (creature.walking && worms.boundFraction > 0.55 && d < 0.95) {
                mode = 'dead';
                document.exitPointerLock();
                showOverlay('IT GOT YOU', `survived ${playTime.toFixed(1)}s &middot; click to try again`);
            }
            const ex = level.exit;
            if (Math.abs(player.pos.x - ex.x) < CELL / 2 && Math.abs(player.pos.z - ex.z) < CELL / 2) {
                mode = 'win';
                document.exitPointerLock();
                showOverlay('YOU FOUND THE EXIT', `${playTime.toFixed(1)}s &middot; click to play again`);
            }
        }
    }

    // HUD
    hud.ammo.textContent = gun.reloadT > 0 ? 'RELOADING' : `${gun.ammo} / ${gun.maxAmmo}`;
    hud.stam.style.width = `${player.stamina * 100}%`;
    hud.tc.textContent = timecode(playTime);
    msgT -= dt;
    hud.msg.style.opacity = msgT > 0 ? Math.min(1, msgT) : 0;
    drawGrain();
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { hud.fps.textContent = `${Math.round(fpsN / fpsAcc)} fps · ${worms.N} worms · sim ${worms.stats.stepMs.toFixed(1)}ms${worms.worker ? ' (worker)' : ''}`; fpsAcc = 0; fpsN = 0; }
});

// initial camera placement for the intro screen
player.update(0, 0, false);
worms.update(0);
app.start();
showOverlay('THE CRAWLING HALLS', 'Find the green EXIT sign. Something made of worms is walking these halls.<br><br>' +
    '<b>WASD</b> move &middot; <b>Shift</b> sprint &middot; <b>Mouse</b> look &middot; <b>Click</b> shoot &middot; <b>R</b> reload<br><br>' +
    'Shoot it hard enough and it falls apart... for a while.<br><br><b>click to start</b>');
// ?debug: lets the sim run without pointer lock and exposes helpers for automated checks
if (DEBUG) {
    window.__game = {
        app, worms, creature, player, level, gun, frame,
        start() { mode = 'play'; hud.overlay.style.display = 'none'; },
        place(x, z, yawDeg, pitchDeg = 0) { player.pos.set(x, 0, z); player.yaw = yawDeg * pc.math.DEG_TO_RAD; player.pitch = pitchDeg * pc.math.DEG_TO_RAD; },
        creatureAt(x, z, yawDeg) { creature.place(x, z, yawDeg * pc.math.DEG_TO_RAD); worms.placeAll(); },
        shoot() { gun.cool = 0; tryFire(); },
        state() { return { mode, bound: worms.boundFraction, cs: creature.state, cx: creature.x, cz: creature.z, px: player.pos.x, pz: player.pos.z }; }
    };
}
