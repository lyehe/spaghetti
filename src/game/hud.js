import { RULES } from './rules.js';

// The DOM HUD (markup in index.html): overlay screens, story cards, power bar, score, hints.
// DOM writes only happen when a value changes; they are surprisingly expensive every frame.
const $ = (id) => document.getElementById(id);

export class Hud {
    constructor() {
        this.cache = {};
        this.cardT = 0;
        this.hintT = 0;
        // hide the camcorder bits of the horror prototype (?classic)
        for (const id of ['grain', 'scan', 'frame', 'rec', 'timecode', 'batt', 'cross', 'msg', 'ammo', 'stamwrap']) { const e = $(id); if (e) e.style.display = 'none'; }
        document.body.classList.add('fork');
        $('game-hud').style.display = 'block';
        $('g-health').querySelector('.lbl').textContent = 'MEATBALL POWER';
    }

    get overlayEl() { return $('overlay'); }
    overlay(title, sub) { $('title').textContent = title; $('sub').innerHTML = sub; $('overlay').style.display = 'flex'; }
    progress(text) { $('sub').textContent = text; }
    hideOverlay() { $('overlay').style.display = 'none'; }
    card(title, sub = '', dur = 4) { $('g-card').innerHTML = title + (sub ? `<small>${sub}</small>` : ''); this.cardT = dur; }
    hint(text) { this.setText('g-hint', 'hint', text); }
    showBossBar() { $('g-boss').style.display = 'block'; }

    setText(id, key, v, html = false) { if (this.cache[key] === v) return; this.cache[key] = v; if (html) $(id).innerHTML = v; else $(id).textContent = v; }
    setStyle(el, prop, v) { const k = el.id + prop; if (this.cache[k] === v) return; this.cache[k] = v; el.style[prop] = v; }

    update(dt, G, playing) {
        const { hero, power, time } = G, boss = G.boss;
        const pw = $('g-health-fill');
        this.setStyle(pw, 'width', `${Math.round((power / RULES.powerTime) * 200) / 2}%`);
        this.setStyle(pw, 'opacity', power > 0 && power < RULES.powerWarn ? (Math.sin(time * 18) > 0 ? '1' : '0.25') : '1');
        this.setText('g-stats', 'stats', `${'🍝'.repeat(Math.max(0, G.lives))}<br>Score <b>${G.score}</b>` + (boss ? '' : `<br>Monsters left: <b>${G.pack.left}</b>`), true);
        if (boss) this.setStyle($('g-boss-fill'), 'width', `${Math.round(boss.downed ? (1 - boss.eatProgress) * 30 : (boss.hp / boss.maxHp) * 100)}%`);
        this.cardT -= dt;
        this.setStyle($('g-card'), 'opacity', String(this.cardT > 0 ? Math.min(1, Math.round(this.cardT * 10) / 10) : 0));
        this.setStyle($('app'), 'filter', G.invuln > 0 && Math.sin(time * 30) > 0 ? 'brightness(1.4) saturate(0.6)' : 'none');
        if (playing && !hero.action && (this.hintT -= dt) <= 0) {
            this.hintT = 0.15;
            const near = G.pack.list.some(m => m.state === 'alive' && Math.hypot(m.creature.x - hero.x, m.creature.z - hero.z) < 2.2);
            const food = [...G.host.bodies.values()].some(b => { for (let i = 0; i < b.loose.length; i += 4) if (Math.hypot(b.loose[i + 1] - hero.x, b.loose[i + 3] - hero.z) < 2.2) return true; return false; });
            this.hint(food ? 'Right click — eat!' : near ? (power > 0 ? 'Left click — CRUSH!' : 'Left click — stun it!') : '');
        }
    }
}
