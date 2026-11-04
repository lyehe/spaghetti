import * as pc from 'playcanvas';

// Game actions from every device. Moving and looking come from PlayCanvas's ThirdPersonController
// (keyboard / mouse / gamepad sticks / touch joysticks, see player.js); this class handles the
// action buttons on top of it, plus a keyboard + mouse fallback when physics is unavailable.
//   mouse:    LMB strike, RMB (hold) eat
//   gamepad:  RT / RB / X strike, LT / LB / B (hold) eat, START start / resume   (PlayCanvas GamepadSource)
//   touch:    on-screen STRIKE / EAT buttons
// Callbacks: onPress(action), onRelease(action) with action 'strike' | 'eat' | 'start'; onUnlock().
const BTN = pc.GamepadSource.buttonCode;
const PAD = { strike: [BTN.RT, BTN.RB, BTN.X], eat: [BTN.LT, BTN.LB, BTN.B], start: [BTN.START] };

export class Input {
    constructor(canvas, overlay, rig, { onPress, onRelease, onUnlock }) {
        this.canvas = canvas;
        this.keys = new Set();
        this.locked = false;
        this.touch = matchMedia('(pointer: coarse)').matches;
        this.onPress = onPress; this.onRelease = onRelease;
        window.addEventListener('keydown', (e) => this.keys.add(e.code));
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousemove', (e) => { if (this.locked) rig.look(e.movementX, e.movementY); });
        document.addEventListener('pointerlockchange', () => {
            this.locked = document.pointerLockElement === canvas;
            if (!this.locked) onUnlock();
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        const mouse = (e) => { if (e.pointerType === 'touch') return; onPress(e.button === 2 ? 'eat' : e.button === 0 ? 'strike' : 'other'); };
        canvas.addEventListener('pointerdown', mouse);
        overlay.addEventListener('pointerdown', () => onPress('start'));
        window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch' && e.button === 2) onRelease('eat'); });

        // gamepad buttons (PlayCanvas reports press / release deltas)
        this.pad = new pc.GamepadSource();
        this.pad.attach(canvas);
        this.padState = new Array(16).fill(0);

        if (this.touch) this.touchButtons();
    }

    touchButtons() {
        const mk = (label, right, bottom, action) => {
            const b = document.body.appendChild(document.createElement('button'));
            b.className = 'touch-btn';
            b.textContent = label;
            Object.assign(b.style, { right: `${right}px`, bottom: `${bottom}px` });
            b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); this.onPress(action); }, { passive: false });
            b.addEventListener('touchend', (e) => { e.preventDefault(); this.onRelease(action); }, { passive: false });
            return b;
        };
        this.buttons = [mk('STRIKE', 24, 150, 'strike'), mk('EAT', 120, 60, 'eat')];
    }

    showTouch(on) { for (const b of this.buttons || []) b.style.display = on ? 'block' : 'none'; }

    // the game is controllable without pointer lock on touch screens
    get ready() { return this.locked || this.touch || this.padActive; }

    lock() { if (!this.touch) this.canvas.requestPointerLock(); }
    unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

    // poll the gamepad once per frame: fires onPress / onRelease on button edges
    poll() {
        const { buttons } = this.pad.read();
        if (buttons.some(b => b > 0)) this.padActive = true;      // a gamepad player needs no pointer lock
        for (const [action, codes] of Object.entries(PAD)) {
            const was = codes.some(c => this.padState[c] > 0);
            for (const c of codes) this.padState[c] = Math.min(1, Math.max(0, this.padState[c] + (buttons[c] || 0)));
            const is = codes.some(c => this.padState[c] > 0);
            if (is && !was) this.onPress(action);
            else if (!is && was) this.onRelease(action);
        }
    }

    // keyboard movement (only used without physics; the controller reads the keys itself)
    move() {
        const k = this.keys;
        return {
            x: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
            z: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
            sprint: k.has('ShiftLeft') || k.has('ShiftRight')
        };
    }
}
