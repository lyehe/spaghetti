# AL DENTE

A third-person, Pac-Man-style spaghetti hunt in a real Gaussian-splat scan of a park.

**▶ Play: https://lyehe.github.io/spaghetti/** (desktop browser with a GPU; ~35 MB download)

The spaghetti came alive and it is hungry for *you*. Four spaghetti monsters, each a body of
hundreds of simulated noodles, hunt you through Sunnyvale Heritage Park. Meatballs pop up around
the park: eat one and for a minute you are spinach-strong — the monsters panic and run, and your
giant fork **crushes** them into heaps of noodles you can eat. Without a meatball the fork only
**stuns** them. Eat them all, then the Flying Spaghetti Monster comes for dessert.

| Action | Keyboard + mouse | Gamepad | Touch |
|---|---|---|---|
| move / run | WASD / Shift | left stick | left joystick |
| look / zoom | mouse / wheel | right stick | right joystick |
| strike (stun, or crush when meatball-strong) | left click | RT / RB / X | STRIKE |
| eat (hold): stab-and-twirl forkfuls, stuffed fistfuls | right click | LT / LB / B | EAT |
| start / resume | click | START | tap |

URL options: `?stats` fps overlay · `?hq` MSAA + SSAO · `?lowq` no shadows · `?space=apartment` the indoor map ·
`?space=kitchen` procedural test room · `?collision` show the collision mesh · `?nophysics` grid movement
instead of the physics controller · `?noreveal` / `?noweather` / `?paintedsky` turn off the splat effects /
the procedural sky · `?debug` (`window.__game`) · `?classic` the original worm-horror prototype.

## How it works

- **Rendering**: [PlayCanvas](https://playcanvas.com) engine 2.23 (no editor), loaded from jsDelivr.
  The park is a photogrammetry Gaussian splat (cropped and recompressed to 1.7 M splats); characters
  cast shadows onto it through a shadow catcher built from the collision mesh.
- **PlayCanvas packages** (all from the engine's own `scripts/esm`, no editor): the hero is a physics
  capsule driven by `ThirdPersonController` (Ammo.js rigidbody; keyboard / mouse / gamepad / touch input
  sources; orbit camera with wall avoidance), with `GamepadSource` for the action buttons; the park's
  sky and image-based lighting come from `ProceduralSky` (its sun placed where the capture's sun was);
  the scan sweeps in with `GSplatRevealRadial` and pollen drifts through it with `GSplatWeather`;
  `ShadowCatcher` lands the characters' shadows on the scan; `CameraFrame` is the post stack.
- **Collision**: every space has a triangle collision mesh. It is the hero's static Ammo collider; rays
  (camera, projectiles) hit its triangles; monsters and noodles use a 25 cm occupancy grid rasterized
  from it, with per-cell terrain height, and the hero is kept on that grid too (`src/world/`).
- **Spaghetti monsters**: each monster is a Verlet worm simulation (20 points × N noodles) running in a
  Web Worker, wrapped around a procedurally animated skeleton (`src/sim/`, `src/actors/monsters/creature.js`).
  Strikes knock noodles loose; crushed monsters collapse into a pile that can pull itself back together.
- **Hero**: a Microsoft Rocketbox avatar with mocap idle/walk/run, plus procedural layers: a squat with
  leg IK (each foot on its own patch of terrain), spine folding over the food, a hammer grip on the fork
  whose wrist follows the forearm, a grabbing / stuffing left hand, and a face that chews with the
  cheeks full while sauce gets painted into the skin texture (`src/actors/hero/`).
  The gameplay rig and its strike / bite keyframes are in `src/actors/hero/hero.js`; the fork is a lofted mesh
  (`fork.js`). `dev/hero.html` is a test bench for posing it (`bench.pose('eat', 0.7)`).
- **Eating**: grabbed strands are pinned to the fork tines (wound in a coil that turns with the twirl)
  or to the fist; the bite hands them to the mouth, which sucks them in while the rest dangles.
- **AI**: four chase personalities (direct, ambush, flank, shy) on a distance field; when you are
  powered up they run for safe spots far from you (`src/actors/monsters/`).

## Layout

```
index.html                page + HUD markup; import map (PlayCanvas from the CDN)
styles/game.css           HUD / overlay styles
src/                      game code (ES modules, no build step)
  main.js                 entry: the game, or the old prototype with ?classic
  core/                   engine level: app setup, procedural audio, camera lens, shared materials, rng
  world/                  the playable space: splat + collision loading, Ammo physics, occupancy grid, terrain,
                          path-finding fields, spawn points, space definitions
  actors/hero/            gameplay rig, skinned body, the fork mesh, sauce painted on his face
  actors/monsters/        monster skeleton + AI, personas, meatball eyes, the boss
  sim/                    noodle physics: Verlet worm sim, its Web Worker, the main-thread host
  fx/                     sauce splats, drips, puddles; pollen (PlayCanvas gsplat weather)
  game/                   game.js (composition root + main loop), rules.js (tuning), player (physics
                          capsule + ThirdPersonController), camera,
                          input, HUD, combat, eating, meatballs, the monster pack, the boss fight
  legacy/                 the original worm-horror prototype (?classic)
vendor/ammo/              Ammo.js (Bullet physics), PlayCanvas's build
assets/hero/hero.glb      the hero (built by tools/blender_hero.py)
assets/spaces/<name>/     splat + collision.json (+ transform.json) per space
dev/hero.html             hero posing bench (http://localhost:5173/dev/hero.html)
tools/                    asset pipeline (Blender, Python) and the dev server
test/                     node:test suites (physics, AI, collision, gameplay)
```

## Develop

```sh
npm install        # PlayCanvas for the node tests
npm start          # http://localhost:5173
npm test
```

### Rebuilding assets

Large sources are not in git; `bash tools/fetch_sources.sh` downloads them. Then:

```sh
# park: decode the capture's (Draco) collision mesh, then crop splat + mesh to the play area
blender -b --factory-startup --python tools/blender_glb2obj.py -- assets/spaces/sunnyvale/collision.glb assets/spaces/sunnyvale/collision_raw.obj
uv run --no-project --with numpy --with pillow python -I tools/splat_crop.py assets/spaces/sunnyvale/scene.sog \
    assets/spaces/sunnyvale/collision_raw.obj assets/spaces/sunnyvale --flip-z --box -16 -20 14 10 --view 12 --min-alpha 0.15 --keep-far 0.2

# hero: Rocketbox FBX + clips -> one GLB
cd assets/hero/src && blender -b --factory-startup --python ../../../tools/blender_hero.py -- \
    Male_Adult_12.fbx ../hero.glb idle=m_idle_neutral_01.fbx walk=m_walk_neutral.fbx run=m_run_neutral.fbx

# a splat without a collision mesh: build one from the splat itself
uv run --no-project --with numpy --with pillow python -I tools/build_space.py assets/spaces/apartment/scene.sog assets/spaces/apartment \
    --flip-x --crop -13.5 -0.5 -0.5 9.5 --min-pts 40 --wall-h 3.0
```

## Credits

See [CREDITS.md](CREDITS.md). The third-party scans and the avatar keep their own licenses.
