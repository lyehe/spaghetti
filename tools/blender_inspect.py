import bpy, sys
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
for f in argv:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=f)
    new = [o for o in bpy.data.objects if o not in before]
    print('==', f)
    for o in new:
        print(' obj', o.name, o.type, tuple(round(v, 3) for v in o.dimensions), 'scale', tuple(round(v, 3) for v in o.scale), 'mats', [m.name for m in getattr(o.data, 'materials', [])] if o.type == 'MESH' else '')
        if o.type == 'ARMATURE':
            print('  bones', len(o.data.bones), [b.name for b in o.data.bones][:12])
            ad = o.animation_data
            if ad and ad.action:
                a = ad.action
                print('  action', a.name, a.frame_range[:], 'fps', bpy.context.scene.render.fps)
for m in bpy.data.materials:
    imgs = [n.image.filepath for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image] if m.node_tree else []
    print('mat', m.name, imgs, m.blend_method if hasattr(m, 'blend_method') else '')
