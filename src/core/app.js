import * as pc from 'playcanvas';

// The PlayCanvas application: canvas, device and scene-wide render settings.
// Quality flags: ?hq (MSAA + SSAO, full pixel ratio), ?lowq (no shadows).
export function createApp(canvas, params) {
    const app = new pc.Application(canvas, {
        mouse: new pc.Mouse(canvas), keyboard: new pc.Keyboard(window),
        graphicsDeviceOptions: { antialias: false, alpha: false }
    });
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
    return app;
}
