"""Run inside Blender: --background --python scripts/build_scene.py -- --manifest ... --out ..."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector


def xyz(values):
    """Project/glTF Y-up -> Blender Z-up."""
    x, y, z = values
    return Vector((x, -z, y))


def material(name, color):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = .7
    return m


def box(name, position, dimensions, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(position))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (dimensions[0], dimensions[2], dimensions[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def import_meshes(path):
    if path.suffix.lower() != '.glb':
        raise ValueError('Initial pipeline accepts GLB only; export your source model as GLB')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    imported = set(bpy.data.objects) - before
    baked = []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in imported:
        if obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=graph)
        mesh.transform(evaluated.matrix_world)
        copy = bpy.data.objects.new(obj.name + '_baked', mesh)
        bpy.context.collection.objects.link(copy)
        baked.append(copy)
    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)
    if not baked or not any(len(o.data.vertices) for o in baked):
        raise ValueError('No mesh geometry in ' + str(path))
    return baked


def fit(meshes, slot, yaw):
    angle = math.radians(yaw)
    from mathutils import Matrix
    rotation = Matrix.Rotation(angle, 4, 'Z')
    for mesh in meshes:
        mesh.data.transform(rotation)
    points = [v.co.copy() for o in meshes for v in o.data.vertices]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    dimensions = high-low
    if not all(math.isfinite(v) for p in points for v in p):
        raise ValueError('Non-finite geometry')
    limits = (slot['size'][0], slot['size'][2], slot['size'][1])
    factors = [limits[i]/dimensions[i] for i in range(3) if dimensions[i] > 1e-8]
    if not factors:
        raise ValueError('Degenerate geometry')
    scale = min(factors)*.9
    center = Vector(((low.x+high.x)/2, (low.y+high.y)/2, low.z))
    target = xyz(slot['position'])
    for obj in meshes:
        for vertex in obj.data.vertices:
            vertex.co = (vertex.co-center)*scale+target
    return {'position': slot['position'], 'scale': scale, 'yawDeg': yaw,
            'normalizedBaseCenterBlender': list(center)}


def validate(manifest, template):
    objects = manifest['objects']
    if len(objects) != 12 or len({o['id'] for o in objects}) != 12:
        raise ValueError('Exactly 12 unique object IDs required')
    if len({o['photoId'] for o in objects}) != 6:
        raise ValueError('Exactly 6 distinct photo IDs required')
    slots = template['slots']
    if len({s['id'] for s in slots}) != len(slots):
        raise ValueError('Duplicate slot IDs')
    for floor in range(6):
        pair = [o for o in objects if o['floor'] == floor]
        if len(pair) != 2 or {o['source'] for o in pair} != {'user','ai'} or len({o['photoId'] for o in pair}) != 1:
            raise ValueError('Each floor needs one photo with user + ai objects')
        for source in ('user', 'ai'):
            if len([s for s in slots if s['floor'] == floor and s['source'] == source]) != 1:
                raise ValueError('Exactly one configured slot per floor/source required')
    for slot in slots:
        if len(slot['position']) != 3 or len(slot['size']) != 3 or not all(math.isfinite(v) for v in slot['position']+slot['size']) or min(slot['size']) <= 0:
            raise ValueError('Invalid slot bounds')
    # Occupancy volumes must not overlap. Custom template author guarantees clearance from pillars.
    def bounds(s):
        x,y,z = s['position']; w,h,d = s['size']
        return (x-w/2,y,z-d/2), (x+w/2,y+h,z+d/2)
    for i, left in enumerate(slots):
        a,b = bounds(left)
        for right in slots[i+1:]:
            c,d = bounds(right)
            if all(min(b[k],d[k])-max(a[k],c[k]) > 1e-6 for k in range(3)):
                raise ValueError('Overlapping slots: ' + left['id'] + ', ' + right['id'])


def build(manifest_path, output, preview=True):
    manifest_path = Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    template_path = (manifest_path.parent / manifest['template']).resolve()
    template = json.loads(template_path.read_text(encoding='utf-8-sig'))
    validate(manifest, template)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    architecture = material('Architecture', (.78,.76,.72))
    user_mat = material('User_proxy', (.92,.48,.39))
    ai_mat = material('AI_proxy', (.35,.62,.64))
    building = template.get('buildingAsset')
    if building:
        import_meshes((template_path.parent / building).resolve())
    else:
        for floor in range(6):
            offset = .22 if floor % 2 else -.22
            box('Floor_' + str(floor), (offset,floor*2-.12,0), (5.6,.24,3.2), architecture)
        for x in (-2.5,2.5):
            for z in (-1.35,1.35):
                box('Pillar', (x,5.7,z), (.13,11.6,.13), architecture)
    placements = []
    for item in sorted(manifest['objects'], key=lambda o: (o['floor'],o['source'])):
        if item.get('skipped') is True:
            continue
        slot = next(s for s in template['slots'] if s['floor'] == item['floor'] and s['source'] == item['source'])
        asset = item.get('asset')
        if asset:
            path = (manifest_path.parent / asset).resolve()
            meshes = import_meshes(path)
            origin = item.get('origin')
            if origin not in ('generated','library'):
                raise ValueError('Real assets must explicitly declare origin generated or library')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            if not item.get('allowProxy', False):
                raise ValueError('Missing asset without explicit allowProxy: '+item['id'])
            meshes = [box(item['id']+'_PROXY', (0,.5,0), (1,1,1), user_mat if item['source']=='user' else ai_mat)]
            origin, digest = 'proxy', None
        transform = fit(meshes, slot, item.get('yawDeg',0))
        for obj in meshes:
            obj.name = item['id'] + '_' + obj.name
            obj['objectId'] = item['id']; obj['source'] = item['source']; obj['origin'] = origin
        placements.append({'objectId':item['id'], 'photoId':item['photoId'], 'floor':item['floor'],
                           'slotId':slot['id'], 'origin':origin, 'sha256':digest, 'transform':transform})
    output = Path(output).resolve(); output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.camera_add(location=(19,-23,17))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0,0,5.5))-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type = 'ORTHO'; camera.data.ortho_scale = 17
    scene = bpy.context.scene; scene.camera = camera
    scene.render.engine = 'CYCLES'; scene.cycles.samples = 16
    scene.render.resolution_x = 900; scene.render.resolution_y = 1200; scene.render.resolution_percentage = 100
    if scene.world is None: scene.world = bpy.data.worlds.new('World')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.65,.65,.65,1)
    bpy.ops.object.light_add(type='AREA', location=(5,-8,16))
    bpy.context.object.data.energy = 1800; bpy.context.object.data.shape = 'DISK'; bpy.context.object.data.size = 10
    bpy.context.object.rotation_euler = (Vector((0,0,5))-bpy.context.object.location).to_track_quat('-Z','Y').to_euler()
    triangles = sum(len(p.vertices)-2 for obj in bpy.data.objects if obj.type=='MESH' for p in obj.data.polygons)
    bpy.ops.wm.save_as_mainfile(filepath=str(output/'building.blend'))
    bpy.ops.export_scene.gltf(filepath=str(output/'building.glb'), export_format='GLB', export_extras=True, export_yup=True)
    report = {'schemaVersion':1, 'sceneId':manifest['sceneId'], 'templateVersion':template['version'],
              'coordinateSystem':'Y_UP', 'qualityStatus':'mixed' if any(p['origin']!='generated' for p in placements) else 'full',
              'placements':placements, 'triangles':triangles, 'glbBytes':(output/'building.glb').stat().st_size,
              'warnings':['Digital scene only: not print-ready', 'Custom template slots require manual architectural clearance review']}
    (output/'scene.json').write_text(json.dumps(report, ensure_ascii=False, indent=2),encoding='utf-8')
    if preview:
        scene.render.filepath = str(output/'preview.png')
        bpy.ops.render.render(write_still=True)
    print('BUILD_COMPLETE', output)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True); p.add_argument('--out', required=True)
    p.add_argument('--skip-preview', action='store_true')
    args = p.parse_args(sys.argv[sys.argv.index('--')+1:])
    build(args.manifest, args.out, not args.skip_preview)
