# AL DENTE

A third-person, Pac-Man-style spaghetti hunt in a real Gaussian-splat scan of a park.

**▶ Play: https://lyehe.github.io/spaghetti/** (desktop browser with a GPU; ~35 MB download)

The spaghetti came alive and it is hungry for *you*. Four spaghetti monsters, each a body of
hundreds of simulated noodles, hunt you through Sunnyvale Heritage Park. Meatballs pop up around
the park: eat one and for a minute you are spinach-strong — the monsters panic and run, and your
giant fork **crushes** them into heaps of noodles you can eat. Without a meatball the fork only
**stuns** them. Eat them all, then the Flying Spaghetti Monster comes for dessert.

| Input | Action |
|---|---|
| Mouse | look |
| WASD / Shift | move / run |
| Left click | strike (stun, or crush when meatball-strong) |
| Right click | twirl and eat loose noodles |

URL options: `?stats` fps overlay · `?hq` MSAA + SSAO · `?space=apartment` the indoor map ·
`?space=kitchen` procedural test room · `?collision` show the collision mesh · `?debug` (`window.__game`) ·
`?classic` the original worm-horror prototype.

## How it works

- **Rendering**: [PlayCanvas](https://playcanvas.com) engine 2.23 (no editor), loaded from jsDelivr.
  The park is a photogrammetry Gaussian splat (cropped and recompressed to 1.7 M splats); characters
  cast shadows onto it through a shadow catcher built from the collision mesh.
- **Collision**: every space has a triangle collision mesh. Rays (camera, projectiles) hit the
  triangles; bodies and worms use a 25 cm occupancy grid rasterized from it, with per-cell terrain
  height (`src/collision.js`, `src/grid.js`).
- **Spaghetti monsters**: each monster is a Verlet worm simulation (20 points × N noodles) running in a
  Web Worker, wrapped around a procedurally animated skeleton (`src/sim/wormsim.js`, `src/creature.js`).
  Strikes knock noodles loose; crushed monsters collapse into a pile that can pull itself back together.
- **Hero**: a Microsoft Rocketbox avatar with mocap idle/walk/run, plus procedural layers: two-handed
  IK grip on the fork (wrist alignment, finger curl), strike/twirl/eat keyframes, head and jaw
  (`src/heromodel.js`, `src/hero.js`).
- **AI**: four chase personalities (direct, ambush, flank, shy) on a distance field; when you are
  powered up they run for safe spots far from you (`src/creature.js`).

## Layout

```
index.html            page + HUD; import map (PlayCanvas from CDN)
src/                  game code (ES modules, no build step)
  main.js             entry: game.js, or classic.js with ?classic
  game.js             AL DENTE: rules, monsters, meatballs, boss, camera, HUD
  space.js spaces.js  splat spaces: loading, lighting, shadow catcher; space definitions
  collision.js grid.js collision mesh, rasterized grid, terrain, path finding fields
  hero.js heromodel.js gameplay rig / skinned body
  creature.js boss.js monster skeletons + AI
  noodles.js sim/      worm simulation (worker + host)
  sauce.js audio.js lens.js combat.js   effects, procedural audio, camera lens, fork hit tests
  classic.js level.js worms.js ...      the original corridor prototype
assets/hero/hero.glb  the hero (built by tools/blender_hero.py)
spaces/<name>/        splat + collision.json (+ transform.json) per space
tools/                asset pipeline and dev server
test/                 node:test suites (physics, AI, collision, gameplay)
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
blender -b --factory-startup --python tools/blender_glb2obj.py -- spaces/sunnyvale/collision.glb spaces/sunnyvale/collision_raw.obj
uv run --no-project --with numpy --with pillow python -I tools/splat_crop.py spaces/sunnyvale/scene.sog \
    spaces/sunnyvale/collision_raw.obj spaces/sunnyvale --flip-z --box -16 -20 14 10 --view 12 --min-alpha 0.15 --keep-far 0.2

# hero: Rocketbox FBX + clips -> one GLB
cd assets/hero/src && blender -b --factory-startup --python ../../../tools/blender_hero.py -- \
    Male_Adult_12.fbx ../hero.glb idle=m_idle_neutral_01.fbx walk=m_walk_neutral.fbx run=m_run_neutral.fbx

# a splat without a collision mesh: build one from the splat itself
uv run --no-project --with numpy --with pillow python -I tools/build_space.py spaces/apartment/scene.sog spaces/apartment \
    --flip-x --crop -13.5 -0.5 -0.5 9.5 --min-pts 40 --wall-h 3.0
```

## Credits

See [CREDITS.md](CREDITS.md). The third-party scans and the avatar keep their own licenses.
