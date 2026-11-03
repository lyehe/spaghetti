"""blender -b --factory-startup --python tools/blender_glb2obj.py -- in.glb out.obj
Decodes a (Draco-compressed) glTF collision mesh into a plain OBJ (glTF y-up kept as-is)."""
import bpy, sys
a = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a[0])
bpy.ops.wm.obj_export(filepath=a[1], export_selected_objects=False, export_uv=False, export_normals=False, export_materials=False, forward_axis='NEGATIVE_Z', up_axis='Y', apply_modifiers=True, export_triangulated_mesh=True)
print('done')
