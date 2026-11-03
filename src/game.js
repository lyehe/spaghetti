import * as pc from 'playcanvas';
import { loadSpace } from './space.js';
import { Creature } from './creature.js';
import { NoodleHost } from './noodles.js';
import { Hero } from './hero.js';
import { HeroModel } from './heromodel.js';
import { FlyingSpaghettiMonster } from './boss.js';
import { Sauce } from './sauce.js';
import { Audio } from './audio.js';
import { Lens } from './lens.js';
import { forkHit } from './combat.js';
import { CollisionMesh } from './collision.js';
import { SPACES } from './spaces.js';

// AL DENTE — pasta-man.
// The spaghetti monsters hunt YOU. Meatballs pop up around the room: eat one and for a minute you are
// spinach-strong — the monsters panic and run, and a fork strike crushes them into a heap of noodles
// you can eat. Without a meatball, a strike only stuns them. Eat them all, then the Flying Spaghetti
// Monster comes for dessert.

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const POWER_TIME = 60;          // seconds of meatball strength
const LIVES = 3;

// ---------------------------------------------------------------- engine + scene
const canvas = document.getElementById('app');
const app = new pc.Application(canvas, { mouse: new pc.Mouse(canvas), keyboard: new pc.Keyboard(window), graphicsDeviceOptions: { antialias: false, alpha: false } });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, params.has('hq') ? 2 : 1.25);
window.addEventListener('resize', () => app.resizeCanvas());

const scene = app.scene;
scene.clusteredLightingEnabled = true;
scene.lighting.shadowsEnabled = !params.has('lowq');
scene.lighting.shadowAtlasResolution = 1024;
scene.lighting.shadowType = pc.SHADOW_PCF3_16F;
scene.lighting.cookiesEnabled = false;
scene.lighting.maxLightsPerCell = 8;

// HUD: hide the camcorder bits from the horror prototype
for (const id of ['grain', 'scan', 'frame', 'rec', 'timecode', 'batt', 'cross', 'msg', 'ammo', 'stamwrap']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
document.body.classList.add('fork');
document.getElementById('game-hud').style.display = 'block';
const $ = (id) => document.getElementById(id);
function showOverlay(title, sub) { $('title').textContent = title; $('sub').innerHTML = sub; $('overlay').style.display = 'flex'; }

const spaceName = params.get('space') || 'park';
showOverlay('AL DENTE', 'loading…');
app.start();
const level = await loadSpace(app, spaceName, { showCollision: params.has('collision'), onProgress: (t) => { $('sub').textContent = t; } });

const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(...(SPACES[spaceName]?.sky || [0.08, 0.08, 0.09])), fov: 62, nearClip: 0.05, farClip: 120 });
app.root.addChild(camera);
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
const lens = params.has('nopost') || params.has('nolens') ? null : new Lens(app, camera.camera, { barrel: 0.02, blur: 0.35, smear: 0 });

// ---------------------------------------------------------------- actors
const usePrims = params.has('prims');
const hero = new Hero(app, level, level.start, { visual: usePrims });
let body = null;
if (!usePrims) {
    try { body = new HeroModel(app, await HeroModel.load(app, 'assets/hero/hero.glb'), hero); }
    catch (err) { console.warn('hero model failed, using the primitive body', err); hero.visual = true; hero.buildVisual(); }
}
const host = new NoodleHost(app, level, { useWorker: !(DEBUG || params.has('inline')) });
const sauce = new Sauce(app, level);
const audio = new Audio();

function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = seeded(Date.now());

const mat = (c, gloss = 0.5, emissive = null) => {
    const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(...c); m.gloss = gloss; m.useMetalness = true; m.metalness = 0;
    if (emissive) { m.emissive = new pc.Color(...emissive); m.emissiveIntensity = 1; }
    m.update(); return m;
};
const eyeWhite = mat([0.95, 0.94, 0.9], 0.8), eyeBlack = mat([0.02, 0.02, 0.02], 0.9);
const eyeScared = mat([0.25, 0.35, 0.95], 0.8, [0.05, 0.08, 0.3]);
const meatMat = mat([0.36, 0.17, 0.09], 0.55), meatDark = mat([0.22, 0.09, 0.05], 0.35);
const sauceMat = mat([0.6, 0.07, 0.03], 0.75);
function sphere(m, parent = app.root) { const e = new pc.Entity(); e.addComponent('render', { type: 'sphere', material: m, castShadows: true }); parent.addChild(e); return e; }

// meatball eyeballs: a bumpy, sauce-glazed meatball with a dark pupil (and a wet glint) that
// follows whoever they are chasing — or rolls away in fright
const glint = mat([1, 1, 1], 0.9, [0.6, 0.6, 0.6]);
function meatEye(parent = app.root) {
    const ball = sphere(meatMat, parent);
    for (let i = 0; i < 7; i++) {
        const b = sphere(meatDark, ball), a = i * 2.39996, el = Math.asin(1 - 2 * (i + 0.5) / 7);
        b.setLocalPosition(Math.cos(a) * Math.cos(el) * 0.44, Math.sin(el) * 0.44, Math.sin(a) * Math.cos(el) * 0.44);
        b.setLocalScale(0.24, 0.2, 0.24);
    }
    const glaze = sphere(sauceMat, ball); glaze.setLocalPosition(0, 0.2, 0); glaze.setLocalScale(0.8, 0.45, 0.8);
    return ball;
}
function makeEyes(scale) { return { eyes: [0, 1].map(() => ({ white: meatEye(), pupil: sphere(eyeBlack), glint: sphere(glint) })), scale }; }
function placeEyes(E, head, fwd, right, look, scared) {
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
function hideEyes(E) { E.eyes.forEach(e => { e.white.enabled = false; e.pupil.enabled = false; e.glint.enabled = false; }); }

// ---------------------------------------------------------------- monsters
// Each hunts differently (like the four ghosts): straight at you, cutting you off ahead,
// flanking from the other side of the room, and a coward that only chases from far away.
const PERSONAS = [
    { name: 'Spaghetto', scale: 1.1, chase: 2.15, target: 'direct' },
    { name: 'Linguina', scale: 0.8, chase: 2.4, target: 'ambush' },
    { name: 'Fettuccino', scale: 0.95, chase: 2.25, target: 'flank' },
    { name: 'Capellino', scale: 0.62, chase: 2.5, target: 'shy' }
];
class Monster {
    constructor(id, persona, start, seed) {
        this.id = id;
        this.p = persona;
        this.scale = persona.scale;
        this.home = start;
        this.creature = new Creature(level, { scale: this.scale, behavior: 'chase', start });
        this.creature.chaseSpeed = persona.chase;
        this.creature.awake = true;
        this.creature.radius = 0.22;          // noodle bodies squeeze between the furniture
        this.N = Math.round(70 + 100 * this.scale);
        this.body = host.add(id, {
            count: this.N, grid: level.toData(), bones: this.creature.boneData, coreBones: this.creature.coreBones,
            boneWeights: this.creature.boneWeight, seed, style: 'pasta', scale: this.scale, squishy: true, bodyCollisions: false
        });
        this.eyes = makeEyes(this.scale);
        this.state = 'alive';                 // alive -> down (a heap) -> eaten   (down -> alive if left too long)
        this.downT = 0;
        this.dripT = Math.random();
    }
    get boundFrac() { return this.body.boundCount / this.N; }
    // where this monster is heading while hunting
    chaseTarget(blinky) {
        const { fwd } = hero.frame(), c = this.creature;
        const H = { x: hero.x, z: hero.z };
        const clampIn = (p) => { const q = { x: p.x, z: p.z }; return level.isWallAt(q.x, q.z) ? H : q; };
        if (this.p.target === 'ambush') return clampIn({ x: hero.x + fwd[0] * 2.5, z: hero.z + fwd[2] * 2.5 });
        if (this.p.target === 'flank' && blinky) return clampIn({ x: hero.x * 2 - blinky.creature.x, z: hero.z * 2 - blinky.creature.z });
        if (this.p.target === 'shy' && Math.hypot(c.x - hero.x, c.z - hero.z) < 3) return this.home;      // too close: back off home
        return H;
    }
}

// spawn points: open cells, far from the player and from each other
function farCells(from, minDist, count, avoid = []) {
    const dist = level.distanceField(from);
    const C = level.CELL, out = [];
    const cells = [];
    for (let z = 0; z < level.h; z++) for (let x = 0; x < level.w; x++) {
        const d = dist[z * level.w + x];
        const inner = x * C > 2.5 && z * C > 2.5 && x * C < level.w * C - 2.5 && z * C < level.h * C - 2.5;   // not at the edge of the capture
        if (inner && d * C >= minDist && !level.isBlocked(x, z)) cells.push({ x: (x + 0.5) * C, y: 0, z: (z + 0.5) * C, d });
    }
    cells.sort((a, b) => b.d - a.d);
    for (const c of cells) {
        if (out.length >= count) break;
        if ([...out, ...avoid].every(o => Math.hypot(o.x - c.x, o.z - c.z) > 2.2)) out.push(c);
    }
    return out;
}
const monsters = farCells(level.start, 3, PERSONAS.length).map((s, i) => new Monster('m' + i, PERSONAS[i], s, 100 + i));

// ---------------------------------------------------------------- meatballs (the power pellets)
const meatballs = [];
const meatLight = (() => { const e = new pc.Entity(); e.addComponent('light', { type: 'omni', color: new pc.Color(1, 0.55, 0.25), intensity: 1.2, range: 2.2, castShadows: false }); app.root.addChild(e); return e; })();
function makeMeatball() {
    const root = new pc.Entity('meatball'); app.root.addChild(root);
    const core = sphere(meatMat, root); core.setLocalScale(0.34, 0.32, 0.34);
    for (let i = 0; i < 9; i++) { const b = sphere(meatDark, core); const a = i * 2.39996, e = Math.asin(1 - 2 * (i + 0.5) / 9); b.setLocalPosition(Math.cos(a) * Math.cos(e) * 0.47, Math.sin(e) * 0.47, Math.sin(a) * Math.cos(e) * 0.47); b.setLocalScale(0.22, 0.2, 0.22); }
    const glaze = sphere(sauceMat, root); glaze.setLocalPosition(0, 0.12, 0); glaze.setLocalScale(0.3, 0.12, 0.3);
    return { root, core, active: false, p: [0, 0, 0], t: 0, life: 0 };
}
for (let i = 0; i < 3; i++) { const m = makeMeatball(); m.root.enabled = false; meatballs.push(m); }
let meatT = 4;               // first meatball shows up soon
function spawnMeatball(at = null) {
    const m = meatballs.find(b => !b.active);
    if (!m) return;
    let p = at;
    if (!p) {
        // somewhere open, not right next to the player, not inside a monster
        const C = level.CELL;
        for (let tries = 0; tries < 200 && !p; tries++) {
            const x = Math.floor(rand() * level.w), z = Math.floor(rand() * level.h);
            if (level.isBlocked(x, z) || x < 10 || z < 10 || x > level.w - 10 || z > level.h - 10) continue;
            const q = [(x + 0.5) * C, 0, (z + 0.5) * C];
            if (Math.hypot(q[0] - hero.x, q[2] - hero.z) < 3) continue;
            if (monsters.some(mm => mm.state !== 'eaten' && Math.hypot(q[0] - mm.creature.x, q[2] - mm.creature.z) < 1.5)) continue;
            p = q;
        }
    }
    if (!p) return;
    m.active = true; m.p = p; m.t = 0; m.life = 30; m.root.enabled = true;
    sauce.puddle(p[0], p[2], 0.35);
}

// ---------------------------------------------------------------- boss
let boss = null, bossBody = null, bossVis = null;
const projectiles = [];
for (let i = 0; i < 6; i++) { const e = sphere(meatMat); e.enabled = false; projectiles.push({ e, p: [0, 0, 0], v: [0, 0, 0], active: false }); }

function spawnBoss() {
    const at = farCells({ x: hero.x, z: hero.z }, 3, 1)[0] || level.start;
    boss = new FlyingSpaghettiMonster(level, at);
    bossBody = host.add('boss', {
        count: 240, grid: level.toData(), bones: boss.boneData, coreBones: boss.coreBones, boneWeights: boss.boneWeight,
        seed: 999, style: 'pasta', scale: 1.25, squishy: true, bodyCollisions: false
    });
    const meat = [sphere(meatMat), sphere(meatMat)];
    meat.forEach(m => { for (let i = 0; i < 7; i++) { const s = sphere(meatDark, m); const a = i * 2.4, e = (i % 3 - 1) * 0.5; s.setLocalPosition(Math.cos(a) * 0.42 * Math.cos(e), Math.sin(e) * 0.42, Math.sin(a) * 0.42 * Math.cos(e)); s.setLocalScale(0.25, 0.25, 0.25); } });
    const stalks = [0, 1].map(() => { const e = new pc.Entity(); e.addComponent('render', { type: 'cylinder', material: meatMat, castShadows: true }); e.prim = 'cylinder'; app.root.addChild(e); return e; });
    bossVis = { meat, stalks, eyes: [0, 1].map(() => ({ white: meatEye(), pupil: sphere(eyeBlack) })) };
    audio.bossHum(true);
    showCard('Dessert — His Noodly Appendage', 'Its meatballs only break when you are meatball-strong. Its thrown meatballs make you strong.', 5);
    $('g-boss').style.display = 'block';
}

// ---------------------------------------------------------------- game state + story
let mode = 'intro';          // intro | play | paused | won | lost
let lives = LIVES, power = 0, invuln = 0, score = 0, strandsEaten = 0, cardT = 0, shake = 0, time = 0, warnT = 0;
const cam = { yaw: 0, pitch: -0.22, dist: 3.2 };
const keys = new Set();
let locked = false;

function showCard(title, sub = '', dur = 4) { $('g-card').innerHTML = title + (sub ? `<small>${sub}</small>` : ''); cardT = dur; }
const credit = SPACES[spaceName]?.credit;
showOverlay('AL DENTE', `The spaghetti came alive — and it is hungry for <i>you</i>.<br>
Four spaghetti monsters prowl the apartment. Dodge them. Find the <b>meatballs</b>.<br>
One meatball = one minute of strength: they run from you, and your fork <b>crushes</b> them into a heap you can eat.<br>
Without a meatball your fork only <b>stuns</b> them.<br><br>
<b>LMB</b> strike &nbsp;·&nbsp; <b>RMB</b> eat &nbsp;·&nbsp; <b>WASD</b> move &nbsp;·&nbsp; <b>Shift</b> run &nbsp;·&nbsp; <b>Mouse</b> look<br><br>
<i>click to start</i><br><br><small style="opacity:.6">${credit ? credit + ' · ' : ''}Character: Microsoft Rocketbox (MIT)</small>`);

window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    cam.yaw -= e.movementX * 0.0025;
    cam.pitch = Math.max(-0.8, Math.min(0.4, cam.pitch - e.movementY * 0.0022));
});
document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked && mode === 'play') { mode = 'paused'; showOverlay('PAUSED', 'click to keep eating'); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const onDown = (e) => {
    if (mode === 'won' || mode === 'lost') { location.reload(); return; }
    if (!locked) {
        audio.start();
        canvas.requestPointerLock();
        if (mode === 'intro') showCard('They smell you.', 'Find a meatball. Then turn the tables.', 4);
        mode = 'play';
        $('overlay').style.display = 'none';
        return;
    }
    if (e.button === 0) { if (hero.strike()) audio.whoosh(); }
    if (e.button === 2) tryEat();
};
canvas.addEventListener('mousedown', onDown);
$('overlay').addEventListener('mousedown', onDown);

// ---------------------------------------------------------------- combat
function resolveStrike() {
    const a = hero.action;
    if (!a || a.type !== 'strike') return;
    if (!hero.strikeActive) { a.prevTip = hero.forkTip; return; }
    a.hit = a.hit || new Set();
    const tip = hero.forkTip;
    const { fwd } = hero.frame();
    for (const m of monsters) {
        if (m.state !== 'alive' || a.hit.has(m.id)) continue;
        const { hit, at } = forkHit(hero.handR, tip, a.prevTip, m.creature.boneData, m.scale);
        if (!hit) continue;
        a.hit.add(m.id);
        const c = m.creature;
        if (power > 0) {
            // meatball-strong: the monster bursts into a heap of noodles
            m.body.events.push({ type: 'chunk', p: at, d: [fwd[0], 0.4, fwd[2]], n: Math.ceil(m.N * 0.3) });
            crushMonster(m, fwd);
            sauce.burst(at, fwd, 40, 4.5);
            audio.crush(); shake = 0.7;
            score += 200;
        } else {
            // just a bonk: a few noodles fly, it reels for a moment
            m.body.events.push({ type: 'chunk', p: at, d: [fwd[0], 0.3, fwd[2]], n: Math.ceil(m.N * 0.05) });
            c.impact(fwd[0] * 2.2, fwd[2] * 2.2);
            c.stun(2.6);
            sauce.burst(at, fwd, 14, 3);
            audio.bonk(); shake = 0.3;
            score += 10;
        }
    }
    a.prevTip = tip;
    if (boss && boss.alive && !a.hit.has('boss')) {
        const bd = Math.hypot(boss.x - hero.x, boss.z - hero.z);
        if (power > 0 && boss.takeHit(tip)) {
            a.hit.add('boss');
            bossBody.events.push({ type: 'hit', p: tip, d: [fwd[0], 0.4, fwd[2]], r: 0.5 });
            sauce.burst(tip, fwd, 30, 4);
            audio.thud(); shake = 0.6;
            if (boss.downed) {
                bossBody.events.push({ type: 'collapse', d: [0, 0, 0] });
                sauce.puddle(boss.x, boss.z, 1.4);
                audio.bossHum(false); audio.collapse();
                showCard('It fell!', 'Eat the Flying Spaghetti Monster. Every last meatball.');
            }
        } else if (power <= 0 && bd < 2.2 && !a.hit.has('boss')) {
            a.hit.add('boss');
            audio.bonk();
            showCard('Too weak!', 'Eat a meatball first — catch the ones it throws.', 2);
        }
    }
}

function crushMonster(m, dir = [0, 0, 0]) {
    const c = m.creature;
    m.state = 'down';
    m.downT = 0;
    c.collapse(); c.stateTimer = Infinity; c.stunT = 0;
    m.body.events.push({ type: 'collapse', d: [dir[0] * 0.5, 0, dir[2] * 0.5] });
    sauce.puddle(c.x, c.z, 0.8 * m.scale);
    hideEyes(m.eyes);
    showCard('Crushed!', 'Right click — eat it before it pulls itself together.', 2.5);
}

// right click: twirl up the nearest loose noodles in front of you
function tryEat() {
    if (hero.action) return;
    const { fwd } = hero.frame();
    const p = [hero.x, 0, hero.z];
    let target = null, bestD = 2.4;
    const consider = (q) => {
        const dx = q[0] - p[0], dz = q[2] - p[2], d = Math.hypot(dx, dz);
        const facing = d < 0.6 || (dx * Math.sin(cam.yaw) + dz * Math.cos(cam.yaw)) / d > -0.2;
        if (d < bestD && facing && q[1] - level.groundAt(q[0], q[2]) < 1.7) { bestD = d; target = q; }
    };
    for (const b of host.bodies.values()) for (let i = 0; i < b.loose.length; i += 4) consider([b.loose[i + 1], b.loose[i + 2], b.loose[i + 3]]);
    if (boss && boss.downed) consider([boss.x, level.groundAt(boss.x, boss.z) + 0.5, boss.z]);
    hero.eat(target || [hero.x + fwd[0], level.groundAt(hero.x, hero.z) + 0.3, hero.z + fwd[2]]);
    hero.action.slurped = false;
    if (!target) $('g-hint').textContent = 'Nothing to eat here.';
}

function resolveEat() {
    const a = hero.action;
    if (!a || a.type !== 'eat') return;
    if (!a.slurped && a.t > 0.6) {
        a.slurped = true;
        let n = 0;
        // with power you shovel faster
        const per = power > 0 ? 9 : 4;
        for (const b of host.bodies.values()) {
            const ids = host.edibleNear(b, a.target, 1.2, per - n);
            if (ids.length) { b.events.push({ type: 'slurp', ids }); n += ids.length; }
            if (n >= per) break;
        }
        if (boss && boss.downed && Math.hypot(boss.x - hero.x, boss.z - hero.z) < 2.6) { boss.eatBite(); n++; }
        if (n) audio.slurp();
    }
    if (!a.chomped && a.t > 0.95) { a.chomped = true; audio.chomp(); }
}

function startPower() {
    power = POWER_TIME;
    warnT = 0;
    audio.powerUp();
    shake = 0.4;
    showCard('MEATBALL POWER!', 'One minute. They are running now — crush them and eat them.', 3);
    for (const m of monsters) if (m.state === 'alive') { m.creature.stunT = 0; m.creature.impact((m.creature.x - hero.x) * 0.3, (m.creature.z - hero.z) * 0.3); }
}

function caught(by) {
    lives--;
    invuln = 2.5;
    audio.ouch(); shake = 1;
    const dx = hero.x - by.creature.x, dz = hero.z - by.creature.z, d = Math.hypot(dx, dz) || 1;
    hero.vx = dx / d * 7; hero.vz = dz / d * 7;
    sauce.burst(hero.headPos, [dx / d, 0.5, dz / d], 22, 3);
    // the monsters back off and regroup, like the ghosts after a catch
    for (const m of monsters) if (m.state === 'alive') m.creature.stun(1.8);
    if (lives <= 0) {
        mode = 'lost';
        document.exitPointerLock();
        showOverlay('EATEN', `The spaghetti got you.<br>Score ${score} · ${strandsEaten} strands eaten.<br><br><i>click to try again</i>`);
    } else showCard(lives === 1 ? 'Last plate!' : 'Caught!', `${lives} ${lives === 1 ? 'plate' : 'plates'} left. Find a meatball.`, 2.5);
}

// ---------------------------------------------------------------- update
const drivers = new Map();
let lastEaten = 0;

app.on('update', (rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    time += dt;
    const playing = mode === 'play' && (locked || DEBUG);
    const sdt = playing ? dt : 0;

    // power timer
    if (power > 0 && sdt > 0) {
        power = Math.max(0, power - sdt);
        if (power < 8 && (warnT -= sdt) <= 0) { warnT = power < 3 ? 0.35 : 0.8; audio.powerWarn(); }
        if (power === 0) { audio.powerEnd(); showCard('The strength fades…', 'They are coming back for you.', 2.5); }
    }
    hero.power = power > 0 ? 1 : 0;
    invuln = Math.max(0, invuln - sdt);

    // hero
    const input = {
        x: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
        z: (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
        sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
        camYaw: cam.yaw
    };
    if (!playing) { input.x = 0; input.z = 0; }
    hero.update(sdt, input);
    if (body) {
        body.power += ((power > 0 ? 1 : 0) - body.power) * Math.min(1, dt * 3);
        body.update(dt);
    }
    if (playing) {
        for (const ev of hero.events) if (ev === 'step') audio.step(0.15);
        resolveStrike();
        resolveEat();
    }

    // meatballs: spawn, bob, get eaten
    if (playing && !(boss && boss.downed)) {
        meatT -= sdt;
        const onField = meatballs.filter(m => m.active).length;
        if (meatT <= 0) { if (onField < 2 && power < 10) spawnMeatball(); meatT = 9 + rand() * 8; }
    }
    let lightOn = null;
    for (const m of meatballs) {
        if (!m.active) continue;
        m.t += dt; m.life -= sdt;
        const pop = Math.min(1, m.t * 3);
        const gy = level.groundAt(m.p[0], m.p[2]), y = 0.28 + Math.sin(m.t * 3) * 0.05;
        m.root.setPosition(m.p[0], gy + y * pop, m.p[2]);
        m.root.setEulerAngles(0, m.t * 60, 0);
        m.root.setLocalScale(pop, pop, pop);
        if (!lightOn) lightOn = m;
        if (Math.random() < dt * 3) sauce.drip([m.p[0] + (Math.random() - 0.5) * 0.2, gy + y, m.p[2] + (Math.random() - 0.5) * 0.2]);
        if (playing && Math.hypot(m.p[0] - hero.x, m.p[2] - hero.z) < 0.6 + 0.1 * hero.power) {
            m.active = false; m.root.enabled = false;
            score += 50;
            startPower();
        } else if (m.life <= 0) { m.active = false; m.root.enabled = false; }
    }
    meatLight.enabled = !!lightOn;
    if (lightOn) meatLight.setPosition(lightOn.p[0], level.groundAt(lightOn.p[0], lightOn.p[2]) + 0.8, lightOn.p[2]);

    // monsters
    const blinky = monsters.find(m => m.p.target === 'direct' && m.state === 'alive');
    drivers.clear();
    for (const m of monsters) {
        if (m.state === 'eaten') continue;
        const c = m.creature;
        if (m.state === 'alive') {
            c.mode = power > 0 ? 'flee' : 'chase';
            const tgt = power > 0 ? { x: hero.x, z: hero.z, panic: true } : m.chaseTarget(blinky);
            if (tgt.panic && power <= 0) c.mode = 'flee';
            if (sdt > 0) c.update(sdt, { pos: { x: tgt.x, z: tgt.z }, panic: tgt.panic }, m.boundFrac, time);
            const dHero = Math.hypot(c.x - hero.x, c.z - hero.z);
            // a monster that loses most of its noodles to bonks falls apart too
            if (m.boundFrac < 0.45) crushMonster(m);
            else if (playing && power <= 0 && invuln <= 0 && !c.stunned && dHero < 0.45 + 0.3 * m.scale) caught(m);
            else {
                const { fwd, right } = c.frame();
                placeEyes(m.eyes, c.joints.head, fwd, right, hero.headPos, power > 0 || c.stunned);
                if ((m.dripT -= sdt) <= 0) { m.dripT = 0.25 + Math.random() * 0.5; sauce.drip([c.x + (Math.random() - 0.5) * 0.4 * m.scale, (c.gy || 0) + 0.7 * m.scale, c.z + (Math.random() - 0.5) * 0.4 * m.scale]); }
            }
        } else if (m.state === 'down') {
            if (sdt > 0) c.update(sdt, { pos: { x: hero.x, z: hero.z } }, m.boundFrac, time);
            m.downT += sdt;
            if (m.body.eaten >= m.N * 0.8) {
                m.state = 'eaten';
                host.remove(m.id);
                score += 500;
                const left = monsters.filter(x => x.state !== 'eaten').length;
                showCard('Delizioso.', left ? `${left} left` : '', 2.5);
                continue;
            }
            // left alone without power for too long, the heap pulls itself back together
            if (power <= 0 && m.downT > 10 && m.body.eaten < m.N * 0.5) {
                m.state = 'alive';
                c.stateTimer = 0;           // COLLAPSED -> REFORM
                m.body.events.push({ type: 'reform' });
                showCard('It is getting back up!', '', 2);
            }
        }
        drivers.set(m.id, { bones: c.boneData, x: c.x, z: c.z, walking: c.walking && m.state === 'alive', speed: c.speed, mouth: hero.mouth });
    }
    if (!boss && playing && monsters.every(m => m.state === 'eaten')) spawnBoss();

    // boss
    if (boss) {
        const evs = sdt > 0 ? boss.update(sdt, { x: hero.x, z: hero.z }) : [];
        for (const ev of evs) {
            const pr = projectiles.find(p => !p.active);
            if (pr) { pr.active = true; pr.p = ev.from.slice(); pr.v = ev.vel.slice(); pr.e.enabled = true; pr.e.setLocalScale(0.26, 0.26, 0.26); }
        }
        const [mA, mB] = boss.meatballs();
        const gone = boss.state === 'eaten';
        bossVis.meat[0].setPosition(...mA.c); bossVis.meat[0].setLocalScale(mA.r * 2, mA.r * 2, mA.r * 2);
        bossVis.meat[1].setPosition(...mB.c); bossVis.meat[1].setLocalScale(mB.r * 2, mB.r * 2, mB.r * 2);
        bossVis.meat.forEach(m => m.enabled = !gone);
        const J = boss.joints;
        Hero.setLimb(bossVis.stalks[0], J.sL0, J.eyeL, 0.035); Hero.setLimb(bossVis.stalks[1], J.sR0, J.eyeR, 0.035);
        bossVis.stalks.forEach(s => s.enabled = !boss.downed);
        bossVis.eyes.forEach((e, i) => {
            const c = i ? J.eyeR : J.eyeL;
            e.white.enabled = e.pupil.enabled = !boss.downed;
            e.white.setPosition(...c); e.white.setLocalScale(0.17, 0.17, 0.17);
            const lx = hero.headPos[0] - c[0], ly = hero.headPos[1] - c[1], lz = hero.headPos[2] - c[2], l = Math.hypot(lx, ly, lz) || 1;
            e.pupil.setPosition(c[0] + lx / l * 0.065, c[1] + ly / l * 0.065, c[2] + lz / l * 0.065); e.pupil.setLocalScale(0.08, 0.08, 0.08);
        });
        if (boss.state !== 'eaten' || bossBody.eaten < 200) drivers.set('boss', { bones: boss.boneData, x: boss.x, z: boss.z, walking: false, speed: 0, mouth: hero.mouth });
        if (boss.state === 'eaten' && mode === 'play') {
            mode = 'won';
            score += 2000;
            document.exitPointerLock();
            audio.bossHum(false);
            showOverlay('BUON APPETITO', `You ate every spaghetti monster and the Flying Spaghetti Monster itself.<br>
                Score ${score} · ${strandsEaten} strands.<br><br><i>click to play again</i>`);
        }
    }

    // the boss's meatballs: dodge them in the air; the ones that land become power meatballs
    for (const pr of projectiles) {
        if (!pr.active) continue;
        pr.v[1] -= 9.8 * sdt;
        for (let i = 0; i < 3; i++) pr.p[i] += pr.v[i] * sdt;
        pr.e.setPosition(...pr.p);
        const hitHero = Math.hypot(pr.p[0] - hero.x, pr.p[2] - hero.z) < 0.45 && pr.p[1] - (hero.gy || 0) < 1.9;
        const pg = level.groundAt(pr.p[0], pr.p[2]);
        if (hitHero || pr.p[1] < pg + 0.15 || level.isWallAt(pr.p[0], pr.p[2], pr.p[1]) || pr.p[1] > level.WALL_H - 0.1) {
            pr.active = false; pr.e.enabled = false;
            sauce.burst(pr.p, [0, 1, 0], 14, 2.5);
            audio.thud();
            if (hitHero && power <= 0 && invuln <= 0) { lives--; invuln = 2; shake = 0.8; showCard('Ow — meatball!', `${lives} plates left`, 1.5); if (lives <= 0) { mode = 'lost'; document.exitPointerLock(); showOverlay('KNOCKED OUT', `Score ${score}.<br><br><i>click to try again</i>`); } }
            else if (!hitHero && pr.p[1] < pg + 0.2 && Math.random() < 0.5) spawnMeatball([pr.p[0], 0, pr.p[2]]);
        }
    }

    // noodles
    host.update(sdt, drivers);
    sauce.update(sdt);

    let eaten = 0;
    for (const b of host.bodies.values()) eaten += b.eaten;
    const totalEaten = eaten + monsters.filter(m => m.state === 'eaten').reduce((s, m) => s + Math.round(m.N * 0.8), 0);
    if (totalEaten > lastEaten) { const d = totalEaten - lastEaten; strandsEaten += d; score += d * 5; }
    lastEaten = totalEaten;

    // third-person camera over the right shoulder, pulled in front of anything in the way
    const head = hero.headPos;
    const k = 1 + 0.18 * (body ? body.power : hero.power);
    const tgt = { x: head[0] + Math.cos(cam.yaw) * 0.42, y: head[1] + 0.1, z: head[2] - Math.sin(cam.yaw) * 0.42 };
    const back = { x: -Math.sin(cam.yaw) * Math.cos(cam.pitch), y: -Math.sin(cam.pitch), z: -Math.cos(cam.yaw) * Math.cos(cam.pitch) };
    const want = cam.dist * k;
    // a fat ray (centre + 4 offsets) so the lens never pokes into walls, plants or furniture splats
    let free = level.raycast(tgt, back, want + 0.3);
    const side = { x: Math.cos(cam.yaw), z: -Math.sin(cam.yaw) };
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
    shake = Math.max(0, shake - dt * 2.5);
    const sx = (Math.random() - 0.5) * shake * 0.1, sy = (Math.random() - 0.5) * shake * 0.1;
    const cx = tgt.x + back.x * d, cz = tgt.z + back.z * d;
    camera.setPosition(cx + sx, Math.max(level.groundAt(cx, cz) + 0.25, tgt.y + back.y * d) + sy, cz);
    camera.lookAt(tgt.x - back.x * 4, tgt.y - back.y * 4, tgt.z - back.z * 4);
    camera.camera.fov += ((power > 0 ? 68 : 62) - camera.camera.fov) * Math.min(1, dt * 3);
    if (lens) lens.update(dt, cam.yaw + Math.PI, cam.pitch);

    // adaptive resolution: keep ~60 fps by trading render scale (0.6 .. 1), checked twice a second
    perf.t += rawDt; perf.n++;
    if (perf.t >= 0.5) {
        const fps = perf.n / perf.t;
        perf.fps = fps; perf.t = 0; perf.n = 0;
        if (!params.has('hq') && frame.enabled) {
            const sc = frame.rendering.renderTargetScale;
            const next = fps < 48 ? Math.max(0.6, sc - 0.1) : fps > 58 ? Math.min(1, sc + 0.05) : sc;
            if (next !== sc) { frame.rendering.renderTargetScale = next; frame.update(); }
        }
        if (statsEl) statsEl.textContent = `${fps.toFixed(0)} fps · scale ${frame.rendering.renderTargetScale.toFixed(2)} · sim ${host.stepMs.toFixed(1)} ms`;
    }

    // HUD (DOM writes only when something changed: they are surprisingly expensive every frame)
    const setText = (id, key, v, html = false) => { if (hudCache[key] === v) return; hudCache[key] = v; if (html) $(id).innerHTML = v; else $(id).textContent = v; };
    const setStyle = (el, prop, v) => { const k = el.id + prop; if (hudCache[k] === v) return; hudCache[k] = v; el.style[prop] = v; };
    const pw = $('g-health-fill');
    setStyle(pw, 'width', `${Math.round((power / POWER_TIME) * 200) / 2}%`);
    setStyle(pw, 'opacity', power > 0 && power < 8 ? (Math.sin(time * 18) > 0 ? '1' : '0.25') : '1');
    const left = monsters.filter(m => m.state !== 'eaten').length;
    setText('g-stats', 'stats', `${'🍝'.repeat(Math.max(0, lives))}<br>Score <b>${score}</b>` + (boss ? '' : `<br>Monsters left: <b>${left}</b>`), true);
    if (boss) setStyle($('g-boss-fill'), 'width', `${Math.round(boss.downed ? (1 - boss.eatProgress) * 30 : (boss.hp / boss.maxHp) * 100)}%`);
    cardT -= dt;
    setStyle($('g-card'), 'opacity', String(cardT > 0 ? Math.min(1, Math.round(cardT * 10) / 10) : 0));
    setStyle($('app'), 'filter', invuln > 0 && Math.sin(time * 30) > 0 ? 'brightness(1.4) saturate(0.6)' : 'none');
    if (playing && !hero.action && (hintT -= dt) <= 0) {
        hintT = 0.15;
        const near = monsters.some(m => m.state === 'alive' && Math.hypot(m.creature.x - hero.x, m.creature.z - hero.z) < 2.2);
        const food = [...host.bodies.values()].some(b => { for (let i = 0; i < b.loose.length; i += 4) if (Math.hypot(b.loose[i + 1] - hero.x, b.loose[i + 3] - hero.z) < 2.2) return true; return false; });
        setText('g-hint', 'hint', food ? 'Right click — eat!' : near ? (power > 0 ? 'Left click — CRUSH!' : 'Left click — stun it!') : '');
    }
});
const perf = { t: 0, n: 0, fps: 0 }, hudCache = {};
let hintT = 0;
const statsEl = params.has('stats') ? Object.assign(document.body.appendChild(document.createElement('div')), { style: 'position:fixed;left:8px;top:8px;color:#fff;font:12px monospace;text-shadow:0 1px 2px #000;pointer-events:none' }) : null;

$('g-health').querySelector('.lbl').textContent = 'MEATBALL POWER';
$('sub').innerHTML = $('sub').innerHTML;

if (DEBUG) {
    window.__game = {
        app, hero, body, monsters, host, level, sauce, camera, cam, frame, meatballs,
        get boss() { return boss; },
        start() { mode = 'play'; $('overlay').style.display = 'none'; },
        state() { return { mode, lives, power: +power.toFixed(1), score, strandsEaten, monsters: monsters.map(m => ({ id: m.id, state: m.state, mode: m.creature.mode, stun: +m.creature.stunT.toFixed(1), bound: +m.boundFrac.toFixed(2), eaten: m.body.eaten, x: +m.creature.x.toFixed(1), z: +m.creature.z.toFixed(1) })), hero: { x: +hero.x.toFixed(2), z: +hero.z.toFixed(2) }, boss: boss && { state: boss.state, hp: boss.hp } }; },
        strike() { hero.strike(); },
        eat() { tryEat(); },
        power() { startPower(); },
        meatball(p) { spawnMeatball(p); },
        spawnBoss, CollisionMesh
    };
}
