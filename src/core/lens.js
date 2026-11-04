import * as pc from 'playcanvas';

// Camcorder lens, injected into CameraFrame's compose pass through its custom chunk hooks:
//   - barrel distortion (wide-angle body-cam look; straight walls bow outward)
//   - camera-motion blur along the screen-space direction the view is turning
//   - CCD vertical smear: very bright pixels bleed into a faint vertical streak down their column
// The end hook re-samples the scene through the warped uv and re-applies bloom/grading/tonemap,
// replacing the stock result.
const DECL = /* glsl */`
    uniform vec4 lensParams;   // x: barrel k, y: zoom to fill the frame, z: aspect, w: smear strength
    uniform vec2 lensBlur;     // screen-space blur vector (uv units per exposure)

    vec2 lensWarp(vec2 uv) {
        vec2 c = (uv - 0.5) * vec2(lensParams.z, 1.0);
        float r2 = dot(c, c);
        c *= (1.0 + lensParams.x * r2) * lensParams.y;
        return c / vec2(lensParams.z, 1.0) + 0.5;
    }

    vec3 lensScene(vec2 uv) {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 8; i++) {
            float t = float(i) / 7.0 - 0.5;
            acc += texture2DLod(sceneTexture, clamp(uv + lensBlur * t, vec2(0.001), vec2(0.999)), 0.0).rgb;
        }
        return acc * 0.125;
    }

    vec3 lensSmear(vec2 uv) {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 16; i++) {
            float y = (float(i) + 0.5) / 16.0;
            vec3 s = texture2DLod(sceneTexture, vec2(uv.x, y), 0.0).rgb;
            acc += max(s - vec3(8.0), vec3(0.0));      // only near-saturated sources (muzzle flash), not ceiling panels
        }
        // the smear is strongest near the source row and a little bluish-white like CCD bleed
        return acc * (1.0 / 16.0) * lensParams.w * vec3(0.9, 0.95, 1.0);
    }
`;

const END = /* glsl */`
    {
        vec2 duv = lensWarp(uv);
        vec3 lr = lensScene(duv);
        #ifdef FRINGING
            lr = applyFringing(lr, duv);
        #endif
        #ifdef BLOOM
            lr = applyBloom(lr, duv);
        #endif
        #ifdef GRADING
            lr = applyGrading(lr);
        #endif
        lr += lensSmear(duv);
        lr = toneMap(max(vec3(0.0), lr));
        #ifdef VIGNETTE
            lr = applyVignette(lr, uv);
        #endif
        if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) lr = vec3(0.0);
        result = lr;
    }
`;

export class Lens {
    constructor(app, cameraComponent, { barrel = 0.16, blur = 0.7, smear = 0.12 } = {}) {
        this.app = app;
        this.cam = cameraComponent;
        this.barrel = barrel;
        this.blurAmount = blur;
        this.smear = smear;
        this.params = new Float32Array(4);
        this.blurVec = new Float32Array(2);
        this.prevYaw = null;
        this.prevPitch = null;
        const device = app.graphicsDevice;
        const chunks = pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL);
        chunks.set('composeDeclarationsPS', DECL);
        chunks.set('composeMainEndPS', END);
        this.paramsId = device.scope.resolve('lensParams');
        this.blurId = device.scope.resolve('lensBlur');
    }

    // how much to zoom so the barrel-warped corners still land inside the source image
    static fillZoom(k, aspect) {
        const r2 = (aspect * 0.5) ** 2 + 0.25;
        return 1 / (1 + k * r2);
    }

    // yaw/pitch in radians (camera view direction), dt in seconds
    update(dt, yaw, pitch) {
        const device = this.app.graphicsDevice;
        const aspect = device.width / Math.max(1, device.height);
        const p = this.params;
        p[0] = this.barrel;
        p[1] = Lens.fillZoom(this.barrel, aspect);
        p[2] = aspect;
        p[3] = this.smear;
        this.paramsId.setValue(p);

        // angular velocity -> screen-space smear over roughly half a frame of exposure
        let bx = 0, by = 0;
        if (this.prevYaw !== null && dt > 0) {
            let dy = yaw - this.prevYaw;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            const vfov = this.cam.fov * Math.PI / 180;
            const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
            bx = -dy / hfov * this.blurAmount;
            by = (pitch - this.prevPitch) / vfov * this.blurAmount;
            const l = Math.hypot(bx, by);
            if (l > 0.06) { bx *= 0.06 / l; by *= 0.06 / l; }
        }
        this.prevYaw = yaw; this.prevPitch = pitch;
        const k = Math.min(1, dt * 30);
        this.blurVec[0] += (bx - this.blurVec[0]) * k;
        this.blurVec[1] += (by - this.blurVec[1]) * k;
        this.blurId.setValue(this.blurVec);
    }
}
