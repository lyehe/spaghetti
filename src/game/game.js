// AL DENTE — pasta-man. The game's composition root and main loop.
// The spaghetti monsters hunt YOU. Meatballs pop up around the park: eat one and for a minute you are
// spinach-strong — the monsters panic and run, and a fork strike crushes them into a heap of noodles
// you can eat. Without a meatball, a strike only stuns them. Eat them all, then the Flying Spaghetti
// Monster comes for dessert.
//
// Systems (each owns one part of the game; they share the `G` context below):
//   CameraRig  camera, post stack, eating cam        Input      keys, mouse look, buttons
//   Hud        overlay, cards, bars, hints           Pack       the four monsters and their rules
//   Meatballs  power pellets                          BossFight  the Flying Spaghetti Monster
//   Eating     bites -> noodle sim                    combat     strike rules + fork hit tests
//   Player     physics capsule + PlayCanvas ThirdPersonController (mouse / gamepad / touch)
import { createApp } from '../core/app.js';
import { createKit } from '../core/materials.js';
import { Audio } from '../core/audio.js';
import { seeded } from '../core/rng.js';
import { loadSpace } from '../world/space.js';
import { loadPhysics } from '../world/physics.js';
import { SPACES } from '../world/spaces.js';
import { CollisionMesh } from '../world/collision.js';
import { Hero } from '../actors/hero/hero.js';
import { HeroModel } from '../actors/hero/heromodel.js';
import { NoodleHost } from '../sim/noodles.js';
import { Sauce } from '../fx/sauce.js';
import { addWeather } from '../fx/weather.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Player } from './player.js';
import { Hud } from './hud.js';
import { Pack } from './monsters.js';
import { Meatballs } from './meatballs.js';
import { BossFight } from './bossfight.js';
import { Eating } from './eating.js';
import { resolveStrike, crushMonster } from './combat.js';
import { RULES } from './rules.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const canvas = document.getElementById('app');

// ---------------------------------------------------------------- boot
const hud = new Hud();
hud.overlay('AL DENTE', 'loading physics…');
// physics first: the rigidbody system picks Ammo up when the app is created (?nophysics: grid movement)
const physics = !params.has('nophysics') && await loadPhysics();
const app = createApp(canvas, params);
app.start();
const spaceName = params.get('space') || 'park';
const level = await loadSpace(app, spaceName, {
    showCollision: params.has('collision'), physics, reveal: params.has('reveal') || (!params.has('noreveal') && !DEBUG), onProgress: (t) => hud.progress(t)
});

const G = {
    params, DEBUG, app, level, hud, kit: createKit(app), rand: seeded(Date.now()),
    // state
    mode: 'intro',             // intro | play | paused | won | lost
    lives: RULES.lives, power: 0, invuln: 0, score: 0, strandsEaten: 0, shake: 0, time: 0, warnT: 0,
    get boss() { return this.bossfight.boss; },
};
G.rig = new CameraRig(app, level, params, SPACES[spaceName]?.sky || [0.08, 0.08, 0.09]);
if (level.def.weather && !params.has('noweather')) G.weather = addWeather(app, G.rig.entity, level.def.weather);
G.hero = new Hero(app, level, level.start, { visual: params.has('prims') });
// start looking into the middle of the space
const startYaw = Math.atan2(-(level.w * level.CELL / 2 - level.start.x), -(level.h * level.CELL / 2 - level.start.z)) * 180 / Math.PI;
G.player = physics ? new Player(app, level, G.rig.entity, level.start, startYaw) : null;
G.rig.cam.yaw = startYaw * Math.PI / 180 + Math.PI;
G.body = null;
if (!params.has('prims')) {
    try { G.body = new HeroModel(app, await HeroModel.load(app, 'assets/hero/hero.glb'), G.hero); }
    catch (err) { console.warn('hero model failed, using the primitive body', err); G.hero.visual = true; G.hero.buildVisual(); }
}
G.host = new NoodleHost(app, level, { useWorker: !(DEBUG || params.has('inline')) });
G.sauce = new Sauce(app, level);
G.audio = new Audio();
G.pack = new Pack(G);
G.meatballs = new Meatballs(G);
G.bossfight = new BossFight(G);
G.eating = new Eating(G);
const { hero, host, audio } = G;

// where the noodle sim pulls eaten strands: the fork tines, the left fist, the mouth
G.eaterAnchors = () => ({ mouth: hero.mouth, fork: hero.forkAnchor, fist: hero.fist });

// ---------------------------------------------------------------- rules
G.startPower = () => {
    G.power = RULES.powerTime;
    G.warnT = 0;
    audio.powerUp();
    G.shake = 0.4;
    hud.card('MEATBALL POWER!', 'One minute. They are running now — crush them and eat them.', 3);
    G.pack.scatter();
    hero.celebrate('cheer', 1.6);
};

G.end = (mode, title, text) => {
    if (mode === 'won') hero.celebrate('dance', 1e9);
    G.mode = mode;
    G.input.unlock();
    hud.overlay(title, text);
};

// lose a plate (a life); returns false when it was the last one
G.hurt = (title, invuln = RULES.invulnAfterHit, shake = 1) => {
    G.lives--;
    G.invuln = invuln;
    G.shake = shake;
    if (G.lives <= 0) { G.end('lost', 'EATEN', `The spaghetti got you.<br>Score ${G.score} · ${G.strandsEaten} strands eaten.<br><br><i>click to try again</i>`); return false; }
    hud.card(G.lives === 1 ? 'Last plate!' : title, `${G.lives} ${G.lives === 1 ? 'plate' : 'plates'} left. Find a meatball.`, 2.5);
    return true;
};

G.caught = (by) => {
    audio.ouch();
    const dx = hero.x - by.creature.x, dz = hero.z - by.creature.z, d = Math.hypot(dx, dz) || 1;
    if (G.player) G.player.push(dx / d * 7, dz / d * 7); else { hero.vx = dx / d * 7; hero.vz = dz / d * 7; }
    G.sauce.burst(hero.headPos, [dx / d, 0.5, dz / d], 22, 3);
    G.pack.stunAll(1.8);            // they back off and regroup, like the ghosts after a catch
    G.hurt('Caught!');
};

// ---------------------------------------------------------------- input
G.input = new Input(canvas, hud.overlayEl, G.rig, {
    onPress(action) {
        if (G.mode === 'won' || G.mode === 'lost') { location.reload(); return; }
        if (G.mode !== 'play' || !(G.input.ready || DEBUG)) {
            audio.start();
            G.input.lock();
            if (G.mode === 'intro') hud.card('They smell you.', 'Find a meatball. Then turn the tables.', 4);
            G.mode = 'play';
            hud.hideOverlay();
            G.input.showTouch(true);
            return;
        }
        if (action === 'strike' && hero.strike()) audio.whoosh();
        if (action === 'eat') G.eating.press();
        if (action === 'dodge') {
            // roll the way he is moving (or straight ahead); the monsters can't grab him mid-roll
            if (hero.dodge(hero.vx, hero.vz)) { G.invuln = Math.max(G.invuln, 0.55); audio.whoosh(); }
        }
        if (action === 'jump' && G.player) G.player.jump();
    },
    onRelease(action) { if (action === 'eat') G.eating.release(); },
    onUnlock() { if (G.mode === 'play' && !G.input.touch && !G.input.padActive) { G.mode = 'paused'; G.input.showTouch(false); hud.overlay('PAUSED', 'click to keep eating'); } }
});
G.input.showTouch(false);

const credit = SPACES[spaceName]?.credit;
hud.overlay('AL DENTE', `The spaghetti came alive — and it is hungry for <i>you</i>.<br>
Four spaghetti monsters prowl the park. Dodge them. Find the <b>meatballs</b>.<br>
One meatball = one minute of strength: they run from you, and your fork <b>crushes</b> them into a heap you can eat.<br>
Without a meatball your fork only <b>stuns</b> them.<br><br>
<b>LMB</b> strike &nbsp;·&nbsp; <b>RMB</b> (hold) eat &nbsp;·&nbsp; <b>WASD</b> move &nbsp;·&nbsp; <b>Shift</b> run &nbsp;·&nbsp; <b>Mouse</b> look<br><br>
<i>click to start</i><br><br><small style="opacity:.6">${credit ? credit + ' · ' : ''}Character: Microsoft Rocketbox (MIT)</small>`);

// ---------------------------------------------------------------- main loop
const drivers = new Map();
let lastEaten = 0;

app.on('update', (rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    G.time += dt;
    G.input.poll();
    const playing = G.mode === 'play' && (G.input.ready || DEBUG);
    const sdt = playing ? dt : 0;

    // meatball power runs out
    if (G.power > 0 && sdt > 0) {
        G.power = Math.max(0, G.power - sdt);
        if (G.power < RULES.powerWarn && (G.warnT -= sdt) <= 0) { G.warnT = G.power < 3 ? 0.35 : 0.8; audio.powerWarn(); }
        if (G.power === 0) { audio.powerEnd(); hud.card('The strength fades…', 'They are coming back for you.', 2.5); }
    }
    hero.power = G.power > 0 ? 1 : 0;
    G.invuln = Math.max(0, G.invuln - sdt);

    // the hero
    let external = null;
    if (G.player) {
        // the capsule moved (controller + physics); steer it for actions, keep it on the playable grid
        G.player.active = playing;
        external = G.player.update(hero, hero.power);
        G.rig.cam.yaw = G.player.yaw; G.rig.cam.pitch = G.player.pitch;
    }
    const move = playing && !G.player ? G.input.move() : { x: 0, z: 0, sprint: false };
    hero.update(sdt, { ...move, camYaw: G.rig.cam.yaw, external });
    if (G.body) {
        G.body.power += ((G.power > 0 ? 1 : 0) - G.body.power) * Math.min(1, dt * 3);
        G.body.update(dt);
    }
    if (external && external.jumped) audio.whoosh();
    if (playing) {
        for (const ev of hero.events) {
            if (ev === 'step') audio.step(0.15);
            else if (ev === 'land') { audio.step(0.5); G.sauce.burst([hero.x, (hero.gy || 0) + 0.05, hero.z], [0, 1, 0], 4, 1.2); }
        }
        resolveStrike(G);
        G.eating.update();
    }

    // the world
    drivers.clear();
    G.meatballs.update(dt, sdt, playing);
    G.pack.update(dt, sdt, playing, drivers);
    G.bossfight.update(dt, sdt, playing, drivers);
    host.update(sdt, drivers);
    G.sauce.update(sdt);

    // score every strand that went down
    let eaten = 0;
    for (const b of host.bodies.values()) eaten += b.eaten;
    const total = eaten + G.pack.list.filter(m => m.state === 'eaten').reduce((s, m) => s + Math.round(m.N * 0.8), 0);
    if (total > lastEaten) { const d = total - lastEaten; G.strandsEaten += d; G.score += d * RULES.score.strand; }
    lastEaten = total;

    G.rig.update(dt, rawDt, G, G.eating.held, !!G.player && playing);
    hud.update(dt, G, playing);
});

// ---------------------------------------------------------------- debug API (?debug)
if (DEBUG) {
    window.__game = {
        G, app, hero, body: G.body, host, level, sauce: G.sauce, camera: G.rig.entity, cam: G.rig.cam, frame: G.rig.frame,
        get monsters() { return G.pack.list; }, get meatballs() { return G.meatballs.pool; }, get boss() { return G.boss; },
        start() { G.mode = 'play'; hud.hideOverlay(); },
        state() {
            return {
                mode: G.mode, lives: G.lives, power: +G.power.toFixed(1), score: G.score, strandsEaten: G.strandsEaten,
                monsters: G.pack.list.map(m => ({ id: m.id, state: m.state, mode: m.creature.mode, stun: +m.creature.stunT.toFixed(1), bound: +m.boundFrac.toFixed(2), eaten: m.body.eaten, x: +m.creature.x.toFixed(1), z: +m.creature.z.toFixed(1) })),
                hero: { x: +hero.x.toFixed(2), z: +hero.z.toFixed(2) }, boss: G.boss && { state: G.boss.state, hp: G.boss.hp }
            };
        },
        strike() { hero.strike(); },
        eat() { G.eating.bite(); },
        eatHold(on = true) { if (on) G.eating.press(); else G.eating.release(); },
        power() { G.startPower(); },
        meatball(p) { G.meatballs.spawn(p); },
        crush(i = 0) { crushMonster(G, G.pack.list[i]); },
        spawnBoss() { G.bossfight.spawn(); },
        teleport(x, z) { if (G.player) G.player.teleport(x, z); else { hero.x = x; hero.z = z; } },
        CollisionMesh
    };
}
