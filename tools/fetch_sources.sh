#!/usr/bin/env bash
# Download the large source assets that are not kept in git (only needed to REBUILD the
# game assets; the built ones are committed). Run from the repo root.
set -euo pipefail

PC=https://code.playcanvas.com/examples_data/example_sunnyvale
RB=https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets

mkdir -p assets/spaces/sunnyvale assets/hero/src

# Sunnyvale Heritage Park capture (CC-BY 4.0, zeitgeistarchivescans) + its collision mesh
curl -fL -o assets/spaces/sunnyvale/scene.sog     "$PC/sunnyvale.sog"
curl -fL -o assets/spaces/sunnyvale/collision.glb "$PC/sunnyvale.glb"

# Microsoft Rocketbox avatar Male_Adult_12 + mocap clips (MIT)
A="$RB/Avatars/Adults/Male_Adult_12"
curl -fL -o assets/hero/src/Male_Adult_12.fbx "$A/Export/Male_Adult_12.fbx"
for t in body_color body_normal head_color head_normal; do
  curl -fL -o "assets/hero/src/m007_$t.tga" "$A/Textures/m007_$t.tga"
done
M="$RB/Animations"
curl -fL -o assets/hero/src/m_idle_neutral_01.fbx "$M/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx"
curl -fL -o assets/hero/src/m_walk_neutral.fbx    "$M/all_animations_max_motextr_xy/m_walk_neutral.max.fbx"
curl -fL -o assets/hero/src/m_run_neutral.fbx     "$M/all_animations_max_motextr_xy/m_run_neutral.max.fbx"
echo "done"
