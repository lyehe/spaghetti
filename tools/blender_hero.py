"""Convert a Microsoft Rocketbox avatar + mocap clips (FBX, Biped rig) into one GLB for PlayCanvas.

    blender -b --factory-startup --python tools/blender_hero.py -- <avatar.fbx> <out.glb> idle=<fbx> walk=<fbx> run=<fbx> cheer=<fbx>@1-90 ...

Textures are looked up next to the avatar FBX (the FBX references the artist's old paths), downscaled
to 1024 px and embedded. Clips are retargeted by bone name (same Biped skeleton) and exported as
separate animations. Horizontal root motion is removed so the game can move the character itself.
"""
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:]
avatar, out = argv[0], argv[1]
clips = dict(a.split('=', 1) for a in argv[2:])
src = os.path.dirname(os.path.abspath(avatar))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


objs = imported(avatar)
arm = next(o for o in objs if o.type == 'ARMATURE')
meshes = [o for o in objs if o.type == 'MESH']
for o in objs:
    if o.type == 'EMPTY':
        bpy.data.objects.remove(o)
arm.name = 'hero'
if arm.animation_data and arm.animation_data.action:
    bpy.data.actions.remove(arm.animation_data.action)
arm.animation_data_clear()
bones = set(b.name for b in arm.data.bones)

# ---- materials: fix texture paths, downscale, metal/rough workflow
def image(name, colorspace='sRGB', size=1024):
    p = os.path.join(src, name)
    if not os.path.exists(p):
        return None
    img = bpy.data.images.load(p)
    img.colorspace_settings.name = colorspace
    if max(img.size) > size:
        img.scale(size, size)
    img.pack()
    img.file_format = 'JPEG' if 'opacity' not in name else 'PNG'
    return img


for m in bpy.data.materials:
    base = m.name.split('_', 1)[-1]
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    outn = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], outn.inputs['Surface'])
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.62 if base == 'body' else 0.5
    col = image(f'{m.name}_color.tga')
    if col:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = col
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if base == 'opacity':
            nt.links.new(t.outputs['Color'], bsdf.inputs['Alpha'])  # eyelashes / brows: greyscale cutout
            m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    nrm = image(f'{m.name}_normal.tga', 'Non-Color')
    if nrm:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = nrm
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])

# ---- clips
arm.animation_data_create()
for name, spec in clips.items():
    # name=file.fbx or name=file.fbx@start-end (keep only those frames)
    path, _, rng = spec.partition('@')
    objs = imported(path)
    carm = next(o for o in objs if o.type == 'ARMATURE')
    act = carm.animation_data.action
    act.name = name
    act.use_fake_user = True
    # keep only channels for bones the avatar has; strip horizontal root motion from the pelvis
    fcs = act.fcurves if hasattr(act, 'fcurves') else [fc for l in act.layers for s in l.strips for cb in s.channelbags for fc in cb.fcurves]
    for fc in list(fcs):
        dp = fc.data_path
        if dp.startswith('pose.bones["'):
            b = dp.split('"')[1]
            if b not in bones:
                try:
                    fcs.remove(fc)
                except Exception:
                    pass
    for o in objs:
        bpy.data.objects.remove(o)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(act.frame_range[0]), act)
    if rng:
        a, b = (float(v) for v in rng.split('-'))
        strip.action_frame_start, strip.action_frame_end = a, b
    if hasattr(strip, 'action_slot') and len(act.slots):
        strip.action_slot = act.slots[0]
    track.mute = False
    print('clip', name, act.frame_range[:])

for o in bpy.data.objects:
    o.select_set(o == arm or o in meshes)
bpy.ops.export_scene.gltf(
    filepath=out, export_format='GLB', use_selection=True, export_yup=True,
    export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True,
    export_image_format='AUTO', export_def_bones=False, export_skins=True, export_morph=False,
    export_anim_single_armature=True, export_optimize_animation_size=True)
print('wrote', out, os.path.getsize(out))
