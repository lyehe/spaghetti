// Playable spaces. Each: a splat (looks) + a collision mesh (physics), both in the same frame:
// y-up metres, floor at y = 0, the room inside the +x/+z quadrant.
//   splat:      .sog / .ply / .compressed.ply url (optional: without it the collision mesh is drawn)
//   transform:  how to place the splat so it lines up with the collision mesh (from tools/build_space.py)
//   collision:  .json {positions, indices} or .obj, made by tools/build_space.py (or by hand in Blender)
//   start:      player spawn [x, z];   wallH: ceiling height (worms cling up to here)
//   credit:     shown on the title screen (the captures are CC-BY)
import { proceduralKitchen } from './collision.js';

export const SPACES = {
    park: {
        title: 'Heritage Park',
        // a real photogrammetry capture, cropped to a 32 x 32 m play area by tools/splat_crop.py:
        //   splat_crop.py spaces/sunnyvale/scene.sog spaces/sunnyvale/collision_raw.obj spaces/sunnyvale --flip-z --box -16 -20 14 10 --view 12 --min-alpha 0.15 --keep-far 0.2
        // collision_raw.obj is the capture's own collision mesh (decoded by tools/blender_glb2obj.py)
        splat: 'spaces/sunnyvale/scene.compressed.ply',
        collision: 'spaces/sunnyvale/collision.json',
        transform: { rotation: [0, 0, 180], position: [17.0, -0.27557, 21.0] },
        start: [16, 16], wallH: 40, terrain: true,       // open sky: no ceiling to cling to
        sky: [0.66, 0.76, 0.88], shadowIntensity: 0.55,
        lighting: { ambient: [0.55, 0.55, 0.58], keyIntensity: 1.7, keyColor: [1, 0.95, 0.86], keyAngles: [50, 140, 0], fillIntensity: 0.45 },
        credit: 'Sunnyvale Heritage Park Museum scan by zeitgeistarchivescans, CC-BY 4.0'
    },
    apartment: {
        title: 'The Apartment',
        splat: 'spaces/apartment/scene.sog',
        collision: 'spaces/apartment/collision.json',
        // tools/build_space.py spaces/apartment/scene.sog spaces/apartment --flip-x --crop -13.5 -0.5 -0.5 9.5 --min-pts 40 --wall-h 3.0
        transform: { rotation: [180, 0, 0], position: [14.0, 0.1249, 1.0] },
        start: [8.625, 4.625], wallH: 3.0,
        lighting: { ambient: [0.5, 0.47, 0.43], keyIntensity: 1.5, keyAngles: [60, 200, 0] },
        credit: '"SA3D_R&D_XP47" apartment splat by Stephane Agullo (sa3d.fr), CC-BY 4.0'
    },
    kitchen: {
        title: "Nonna Rosa's kitchen (no splat)",
        procedural: () => proceduralKitchen(),
        start: [6, 2], wallH: 2.8,
        lighting: { ambient: [0.36, 0.32, 0.28], keyIntensity: 1.6 }
    }
};
