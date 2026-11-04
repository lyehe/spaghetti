import * as pc from 'playcanvas';
import { GSplatWeather } from 'playcanvas/scripts/esm/gsplat/gsplat-weather.mjs';

// Ambient particles from PlayCanvas's procedural gaussian-splat weather (a camera-following volume
// that looks fixed in the world): drifting pollen / dandelion fluff in the park. A space opts in with
// `weather: { ...GSplatWeather properties }`; ?noweather turns it off.
export function addWeather(app, camera, props) {
    try {
        const e = new pc.Entity('weather');
        e.addComponent('script');
        const w = e.script.create(GSplatWeather, { properties: { followEntity: camera, ...props } });
        app.root.addChild(e);
        return w;
    } catch (err) {
        console.warn('weather effect unavailable', err);
        return null;
    }
}
