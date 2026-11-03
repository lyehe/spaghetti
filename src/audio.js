// Tiny procedural sound kit: fluorescent hum, gunshot, wet squelches, footsteps.
export class Audio {
    constructor() { this.ctx = null; }

    start() {
        if (this.ctx) { this.ctx.resume(); return; }
        const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = ctx.createGain();
        this.master.gain.value = 0.7;
        this.master.connect(ctx.destination);

        const len = ctx.sampleRate * 2;
        this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

        // fluorescent hum
        const hum = ctx.createGain();
        hum.gain.value = 0.025;
        hum.connect(this.master);
        for (const f of [120, 240, 360]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f + Math.random() * 0.5;
            const g = ctx.createGain();
            g.gain.value = f === 120 ? 1 : 0.3;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 900;
            o.connect(lp).connect(g).connect(hum);
            o.start();
        }

        // continuous wet writhing, volume driven by proximity
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf; src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 3;
        this.writheLfo = bp;
        this.writhe = ctx.createGain();
        this.writhe.gain.value = 0;
        src.connect(bp).connect(this.writhe).connect(this.master);
        src.start();
    }

    noise(dur, { type = 'lowpass', freq = 1000, q = 1, gain = 0.5, attack = 0.002, sweepTo = null, rate = 1 } = {}) {
        const ctx = this.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        const s = ctx.createBufferSource();
        s.buffer = this.noiseBuf;
        s.playbackRate.value = rate;
        const f = ctx.createBiquadFilter();
        f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
        if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(this.master);
        s.start(t, Math.random());
        s.stop(t + dur + 0.05);
    }

    shot() {
        this.noise(0.35, { freq: 4000, sweepTo: 200, gain: 0.9, q: 0.7 });
        this.noise(0.12, { type: 'highpass', freq: 2500, gain: 0.4 });
        const ctx = this.ctx; if (!ctx) return;
        const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
        o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
        g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.3);
    }

    squelch(amount = 1) {
        for (let i = 0; i < 3; i++) {
            setTimeout(() => this.noise(0.18 + Math.random() * 0.2, {
                type: 'bandpass', freq: 300 + Math.random() * 600, sweepTo: 120 + Math.random() * 200, q: 4, gain: 0.35 * amount
            }), i * 40 + Math.random() * 60);
        }
    }

    collapse() {
        for (let i = 0; i < 10; i++) setTimeout(() => this.squelch(0.8), i * 70);
        this.noise(1.2, { freq: 400, sweepTo: 60, gain: 0.6, q: 1 });
    }

    step(vol) {
        this.noise(0.22, { type: 'bandpass', freq: 220 + Math.random() * 120, sweepTo: 80, q: 2, gain: 0.5 * vol });
    }

    click() { this.noise(0.05, { type: 'highpass', freq: 3000, gain: 0.25 }); }

    // ---- fork game sounds
    whoosh() { this.noise(0.28, { type: 'bandpass', freq: 600, sweepTo: 2400, q: 1.5, gain: 0.35, attack: 0.05 }); }

    splat(amount = 1) {
        this.noise(0.2, { type: 'lowpass', freq: 900, sweepTo: 150, gain: 0.5 * amount, q: 2 });
        this.squelch(amount);
    }

    // a long wet slurp that rises in pitch
    slurp() {
        const ctx = this.ctx; if (!ctx) return;
        const t = ctx.currentTime;
        const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6;
        f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1600, t + 0.55);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.45, t + 0.08);
        g.gain.setValueAtTime(0.45, t + 0.45); g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
        // wobble: the noodle whipping around
        const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 18; lg.gain.value = 0.25;
        lfo.connect(lg).connect(g.gain);
        s.connect(f).connect(g).connect(this.master);
        s.start(t, Math.random()); s.stop(t + 0.7); lfo.start(t); lfo.stop(t + 0.7);
    }

    chomp() {
        for (let i = 0; i < 3; i++) setTimeout(() => this.noise(0.09, { type: 'bandpass', freq: 250 + Math.random() * 150, q: 3, gain: 0.5 }), i * 140);
    }

    thud() {
        const ctx = this.ctx; if (!ctx) return;
        const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
        o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
        g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.35);
        this.splat(0.6);
    }

    // the boss: a low, wavering choir-ish hum while it is around
    bossHum(on) {
        const ctx = this.ctx; if (!ctx) return;
        if (on && !this.hum) {
            const g = ctx.createGain(); g.gain.value = 0; g.connect(this.master);
            const oscs = [110, 164.8, 220.5].map((fr, i) => { const o = ctx.createOscillator(); o.type = i ? 'triangle' : 'sine'; o.frequency.value = fr; o.connect(g); o.start(); return o; });
            g.gain.setTargetAtTime(0.06, ctx.currentTime, 1);
            this.hum = { g, oscs };
        } else if (!on && this.hum) {
            this.hum.g.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
            const h = this.hum; setTimeout(() => h.oscs.forEach(o => o.stop()), 2000);
            this.hum = null;
        }
    }

    tone(freq, dur, { type = 'square', gain = 0.12, at = 0, slideTo = null } = {}) {
        const ctx = this.ctx; if (!ctx) return;
        const t = ctx.currentTime + at;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(freq, t);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
    }
    // meatball eaten: a quick rising fanfare
    powerUp() { [262, 330, 392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.16, { at: i * 0.06, type: 'square', gain: 0.08 })); this.chomp(); }
    // power running out: two short blips
    powerWarn() { this.tone(880, 0.07, { gain: 0.06 }); this.tone(660, 0.07, { at: 0.1, gain: 0.06 }); }
    powerEnd() { this.tone(523, 0.4, { slideTo: 196, type: 'triangle', gain: 0.12 }); }
    // fork bonk on a monster's head (no power)
    bonk() { this.tone(520, 0.12, { slideTo: 260, type: 'triangle', gain: 0.25 }); this.splat(0.4); }
    // caught by a monster
    ouch() { this.tone(330, 0.5, { slideTo: 80, type: 'sawtooth', gain: 0.15 }); this.thud(); }
    // a monster crushed into a heap
    crush() { this.thud(); this.collapse(); this.splat(1.2); }

    setProximity(p) {
        if (!this.ctx) return;
        this.writhe.gain.setTargetAtTime(0.25 * p, this.ctx.currentTime, 0.2);
        this.writheLfo.frequency.setTargetAtTime(500 + Math.random() * 600, this.ctx.currentTime, 0.05);
    }
}
